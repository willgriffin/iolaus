import { createHash } from 'node:crypto';
import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import { withoutSkillDiscoveryMetadata } from '../candidate-skill-discovery.js';
import { OPPORTUNITY_RECOMMENDATION_RANK_VERSION } from '../objects/OpportunityRecommendationRank.js';
import { parseSkillList } from '../opportunity-filters.js';
import type {
  ScreeningQuestion,
  ScreeningQuestionAggregate,
  ScreeningQuestionAnswer,
  ScreeningSkillMatch,
} from '../opportunity-screening-questions.js';
import {
  runOpportunityLifecycleTransaction,
  withOpportunityLifecycleLock,
} from './application-workflow.js';
import { getDbConfig } from './db.js';
import {
  JobWorkspaceSubjectError,
  runAsRevalidatedJobWorkspaceSubject,
} from './job-workspace-subject.js';
import {
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import {
  evaluateOpportunityQuestionScreening,
  OPPORTUNITY_QUESTION_SCREENING_FEATURE,
  type OPPORTUNITY_QUESTION_SCREENING_MODEL,
  OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_PROFILE,
  OPPORTUNITY_QUESTION_SCREENING_V1_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V5_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V6_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_V7_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_VERSION,
  type OpportunityQuestionScreeningResult,
  opportunityQuestionScreeningContextFits,
  opportunityQuestionScreeningInputFingerprint,
  type PreparedOpportunityQuestionScreening,
  preflightOpportunityQuestionScreening,
  prepareOpportunityQuestionScreening,
  prepareOpportunityRolePreScreen,
  resolveOpportunityQuestionScreening,
} from './opportunity-question-screening.js';
import {
  listOwnedOpportunityRecommendationRanks,
  normalizeOpportunityRecommendationRankSkillsSnapshot,
  type OwnedOpportunityRecommendationRankRow,
  saveVerifiedOpportunityRecommendationRank,
  type VerifiedOpportunityRecommendationRankPublication,
} from './opportunity-recommendation-rank.js';
import { isOwnerAuthorityDenial } from './owner-principal.js';
import {
  candidateProfileWhere,
  createPrivateRecord,
  listPrivateRecords,
  recordOwnedBySubject,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import {
  type CandidateEvidenceSource,
  loadWorkspaceCandidateEvidence,
  type WorkspaceCandidateEvidence,
} from './resume-data.js';
import {
  listAssessmentScreeningQuestions,
  type ScreeningQuestionSnapshot,
} from './screening-question-store.js';
import { getCollection } from './smrt.js';
import { WorkspaceSubjectError } from './workspace-subject.js';

type Row = Record<string, unknown>;
type OpportunitySkillSnapshots = {
  requiredSkillsSnapshot: string;
  preferredSkillsSnapshot: string;
};
type Database = Pick<
  Awaited<ReturnType<typeof resolveDatabase>>,
  'query' | 'transaction' | 'url'
>;
export interface ScreeningQuestionAssessmentDependencies {
  db?: Database;
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  getOpportunity?: (id: string) => Promise<Row | null>;
  getProfile?: (id: string) => Promise<Row | null>;
  loadCandidate?: typeof loadWorkspaceCandidateEvidence;
  listQuestions?: typeof listAssessmentScreeningQuestions;
  listSaved?: typeof listPrivateRecords;
  save?: typeof createPrivateRecord;
  evaluate?: typeof evaluateOpportunityQuestionScreening;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
  lock?: typeof withOpportunityLifecycleLock;
  transaction?: typeof runOpportunityLifecycleTransaction;
  saveRank?: typeof saveVerifiedOpportunityRecommendationRank;
  listRanks?: typeof listOwnedOpportunityRecommendationRanks;
  loadFinalOpportunity?: (id: string, db: Database) => Promise<Row | null>;
}
export interface ScreeningQuestionAssessmentOptions {
  version?: PreparedOpportunityQuestionScreening['version'];
  rolePreScreen?: boolean;
}
export interface ScreeningQuestionAssessmentProjection {
  skillMatches?: ScreeningSkillMatch[];
  rolePreScreen?: OpportunityQuestionScreeningResult['rolePreScreen'];
  version: 'opportunity-question-screening-projection/v1';
  sourceStatus: 'current';
  model: typeof OPPORTUNITY_QUESTION_SCREENING_MODEL;
  questions: ScreeningQuestion[];
  answers: ScreeningQuestionAnswer[];
  aggregate: ScreeningQuestionAggregate;
}
export interface ScreeningQuestionAssessmentProjectionMap
  extends Map<string, ScreeningQuestionAssessmentProjection> {
  questionScreeningStatuses: Map<string, 'current' | 'unknown'>;
  blockedReason?: string;
  questionScreeningEnabled: boolean;
}
function counter(value: unknown): number {
  return (typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '')) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 0
    ? Number(value)
    : Number.NaN;
}
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function database(
  deps: ScreeningQuestionAssessmentDependencies,
): Promise<Database> {
  return (
    deps.db ??
    getRequestScopedDatabase() ??
    (await resolveDatabase(getDbConfig()))
  );
}
async function native(
  className: 'Opportunity' | 'CandidateProfile',
  id: string,
  db?: Database,
): Promise<Row | null> {
  const record = await (
    await getCollection(className, { db: db as never })
  ).get({ id }, { cache: false });
  return record ? (record.toJSON() as Row) : null;
}
function exactId(value: string): string {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Native IDs must reject ASCII control characters.
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error('A current native opportunity identity is required.');
  return value;
}
function rawSkillSnapshot(value: unknown): string {
  return normalizeOpportunityRecommendationRankSkillsSnapshot(value);
}
function opportunitySkillSnapshots(
  opportunity: Row,
): OpportunitySkillSnapshots {
  return {
    requiredSkillsSnapshot: rawSkillSnapshot(opportunity.requiredSkills),
    preferredSkillsSnapshot: rawSkillSnapshot(opportunity.preferredSkills),
  };
}
async function lockedFinalOpportunity(
  opportunityId: string,
  deps: ScreeningQuestionAssessmentDependencies,
  transaction: Database,
): Promise<Row | null> {
  if (deps.loadFinalOpportunity)
    return await deps.loadFinalOpportunity(opportunityId, transaction);
  if (transaction.url && detectEngine(transaction.url) === 'postgres')
    await transaction.query(
      'SELECT id FROM opportunities WHERE CAST(id AS TEXT) = ? FOR UPDATE',
      [opportunityId],
    );
  return await native('Opportunity', opportunityId, transaction);
}
async function fresh<T>(
  subject: WorkspaceSubject,
  deps: ScreeningQuestionAssessmentDependencies,
  work: (owned: WorkspaceSubject) => Promise<T>,
): Promise<T> {
  return await (deps.runFresh ?? runAsRevalidatedJobWorkspaceSubject)(
    requireWorkspaceSubject(subject),
    'assessment.execute',
    async (owned, run) => {
      await run.assertOperation('workflow', 'assessment.execute');
      await run.assertOperation('opportunities', 'read');
      return await work(owned);
    },
  );
}
interface Context {
  profile: Row;
  candidate: WorkspaceCandidateEvidence;
  questions: ScreeningQuestionSnapshot;
  sources: CandidateEvidenceSource[];
  candidateFingerprint: string;
}
async function context(
  subject: WorkspaceSubject,
  deps: ScreeningQuestionAssessmentDependencies,
  selectedQuestions?: ScreeningQuestionSnapshot,
  version: PreparedOpportunityQuestionScreening['version'] = OPPORTUNITY_QUESTION_SCREENING_VERSION,
): Promise<Context> {
  const profile = await (
    deps.getProfile ?? ((id) => native('CandidateProfile', id))
  )(subject.profileId);
  if (
    !profile ||
    profile.id !== subject.profileId ||
    profile.active !== true ||
    Object.entries(candidateProfileWhere(subject)).some(
      ([key, value]) => profile[key] !== value,
    )
  )
    throw new WorkspaceSubjectError(
      403,
      'An active owned profile is required for question screening.',
    );
  const questions =
    selectedQuestions ??
    (await (deps.listQuestions ?? listAssessmentScreeningQuestions)(subject));
  if (questions.invalidQuestions.length || questions.errors.length)
    throw new Error('Repair invalid screening questions before running.');
  const candidate = await (
    deps.loadCandidate ?? loadWorkspaceCandidateEvidence
  )(subject);
  const text = (value: unknown) =>
    typeof value === 'string' ? value.trim() : '';
  const currentProfileText = [profile.title, profile.summary, profile.factsJson]
    .map(text)
    .filter(Boolean)
    .join('\n');
  const occurrences = candidate.evidence.filter(
    (row) => row.id === `profile:${subject.profileId}`,
  );
  if (
    currentProfileText
      ? occurrences.length !== 1 ||
        occurrences[0]?.text !== currentProfileText ||
        occurrences[0]?.title !== (text(profile.name) || 'Candidate profile')
      : occurrences.length !== 0
  )
    throw new Error('Candidate catalog contains a stale profile occurrence.');
  const sources =
    version === OPPORTUNITY_QUESTION_SCREENING_V1_VERSION
      ? candidate.evidence.filter(
          (row) => !row.id.startsWith('confirmed-skill:'),
        )
      : candidate.evidence.filter(
          (row) =>
            row.id !== `profile:${subject.profileId}` &&
            (version === OPPORTUNITY_QUESTION_SCREENING_VERSION ||
              version === OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION ||
              !row.id.startsWith('confirmed-skill:')),
        );
  if (version !== OPPORTUNITY_QUESTION_SCREENING_V1_VERSION) {
    const appendCareer = (
      field: 'title' | 'summary' | 'skillExperience',
      value: unknown,
      path: string,
    ) => {
      if (typeof value !== 'string' || !value.trim()) return;
      sources.push({
        id: `profile-career:${subject.profileId}:${path}`,
        kind: 'candidate_profile',
        recordId: subject.profileId,
        sectionId: path,
        title: `Candidate career ${field}`,
        text: value,
      });
    };
    appendCareer('title', profile.title, 'title');
    appendCareer('summary', profile.summary, 'summary');
    if (
      typeof profile.workAuthorization === 'string' &&
      profile.workAuthorization.trim()
    )
      sources.push({
        id: `profile-field:${subject.profileId}:workAuthorization`,
        kind: 'candidate_profile',
        recordId: subject.profileId,
        sectionId: 'workAuthorization',
        title: 'Candidate work authorization (exact owned value)',
        text: profile.workAuthorization,
      });
    // Explicit onboarding career fields only. Do not emit the JSON envelope,
    // contact/identity values, provenance or internal unresolved-question metadata.
    try {
      const state = JSON.parse(String(profile.factsJson ?? '{}'));
      if (
        state.version === 1 &&
        state.facts &&
        typeof state.facts === 'object'
      ) {
        if (
          version === OPPORTUNITY_QUESTION_SCREENING_VERSION ||
          version === OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION ||
          version === OPPORTUNITY_QUESTION_SCREENING_V7_VERSION ||
          version === OPPORTUNITY_QUESTION_SCREENING_V6_VERSION ||
          version === OPPORTUNITY_QUESTION_SCREENING_V5_VERSION
        ) {
          const skillExperience = state.facts.skillExperience;
          if (skillExperience?.provenance === 'user_verified')
            appendCareer(
              'skillExperience',
              skillExperience.value,
              'facts.skillExperience.value',
            );
        }
        for (const field of ['title', 'summary'] as const) {
          const fact = state.facts[field];
          if (
            fact &&
            ['user_verified', 'safe_derivation'].includes(fact.provenance) &&
            fact.value !== profile[field]
          )
            appendCareer(field, fact.value, `facts.${field}.value`);
        }
      }
    } catch {
      /* Malformed profile facts never become screening career evidence. */
    }
  }
  for (const field of [
    'citizenshipsJson',
    'authorizedWorkCountriesJson',
    'residenceCountryJson',
    'targetWorkCountryJson',
    'preferencesJson',
    'sponsorshipRequired',
  ] as const) {
    const value =
      field === 'preferencesJson'
        ? withoutSkillDiscoveryMetadata(profile[field])
        : profile[field];
    const raw =
      field === 'sponsorshipRequired'
        ? typeof value === 'boolean'
          ? JSON.stringify(value)
          : undefined
        : typeof value === 'string' && value.trim()
          ? value
          : undefined;
    if (raw !== undefined)
      sources.push({
        id: `profile-field:${subject.profileId}:${field}`,
        kind: 'candidate_profile',
        recordId: subject.profileId,
        sectionId: field,
        title: `CandidateProfile.${field} (exact typed raw value)`,
        text: raw,
      });
  }
  const fingerprintProfile: Row = {
    ...profile,
    preferencesJson: withoutSkillDiscoveryMetadata(profile.preferencesJson),
  };
  // Review-only writes update audit timestamps without changing career material.
  // Historical contracts retain their original timestamp projection.
  if (
    version === OPPORTUNITY_QUESTION_SCREENING_VERSION ||
    version === OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION
  ) {
    delete fingerprintProfile.updatedAt;
    delete fingerprintProfile.updated_at;
  }
  return {
    profile,
    candidate,
    questions,
    sources,
    candidateFingerprint:
      version === OPPORTUNITY_QUESTION_SCREENING_V1_VERSION
        ? hash({
            catalog: candidate.fingerprint,
            profile: fingerprintProfile,
          })
        : hash({
            catalog: candidate.fingerprint,
            profile: fingerprintProfile,
            careerSources: sources,
          }),
  };
}
async function prepare(
  opportunityId: string,
  subject: WorkspaceSubject,
  deps: ScreeningQuestionAssessmentDependencies,
  shared?: Context,
  options: ScreeningQuestionAssessmentOptions = {},
): Promise<PreparedOpportunityQuestionScreening> {
  const material =
    shared ?? (await context(subject, deps, undefined, options.version));
  const opportunity = await (
    deps.getOpportunity ?? ((id) => native('Opportunity', id))
  )(exactId(opportunityId));
  if (!opportunity || opportunity.id !== opportunityId)
    throw new Error('Current captured opportunity is missing.');
  const additionalSkillRequirements: NonNullable<
    Parameters<
      typeof prepareOpportunityQuestionScreening
    >[0]['additionalSkillRequirements']
  > = [];
  if (
    [
      OPPORTUNITY_QUESTION_SCREENING_VERSION,
      OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
      OPPORTUNITY_QUESTION_SCREENING_V6_VERSION,
      OPPORTUNITY_QUESTION_SCREENING_V7_VERSION,
    ].includes(options.version ?? OPPORTUNITY_QUESTION_SCREENING_VERSION)
  ) {
    let body = '';
    try {
      const captured = JSON.parse(
        String(opportunity.sourceContentJson ?? '{}'),
      );
      if (typeof captured.descriptionRaw === 'string')
        body = captured.descriptionRaw;
    } catch {
      /* Pure preparation below rejects malformed capture. */
    }
    for (const sourceField of ['requiredSkills', 'preferredSkills'] as const) {
      const raw = opportunity[sourceField];
      const skills =
        typeof raw === 'string'
          ? parseSkillList(raw)
          : Array.isArray(raw) && raw.every((item) => typeof item === 'string')
            ? (raw as string[])
            : [];
      for (const requirement of skills) {
        const escaped = requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = new RegExp(
          `(^|[^A-Za-z0-9])(${escaped})(?=$|[^A-Za-z0-9])`,
          'iu',
        ).exec(body);
        if (!match) continue;
        const start = match.index + match[1]!.length;
        additionalSkillRequirements.push({
          requirement,
          sourceField,
          start,
          end: start + match[2]!.length,
        });
      }
    }
  }
  let full = prepareOpportunityQuestionScreening(
    {
      opportunityId,
      sourceContentJson: String(opportunity.sourceContentJson ?? ''),
      sourceContentFingerprint: String(
        opportunity.sourceContentFingerprint ?? '',
      ),
      sourceContentVersion: Number(opportunity.sourceContentVersion),
      candidateSources: material.sources,
      ...(additionalSkillRequirements.length
        ? { additionalSkillRequirements }
        : {}),
      candidateMaterialFingerprint: material.candidateFingerprint,
      questions: material.questions.questions,
    },
    options,
  );
  if (!options.version && !opportunityQuestionScreeningContextFits(full)) {
    full = prepareOpportunityQuestionScreening(
      {
        opportunityId,
        sourceContentJson: String(opportunity.sourceContentJson ?? ''),
        sourceContentFingerprint: String(
          opportunity.sourceContentFingerprint ?? '',
        ),
        sourceContentVersion: Number(opportunity.sourceContentVersion),
        candidateSources: material.sources,
        additionalSkillRequirements,
        candidateMaterialFingerprint: material.candidateFingerprint,
        questions: material.questions.questions,
      },
      { ...options, version: OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION },
    );
  }
  if (!options.rolePreScreen) return full;
  const preScreen = prepareOpportunityRolePreScreen(full, material.profile);
  if (!preScreen)
    throw new Error(
      'Current target roles and captured title are required for pre-screening.',
    );
  return preScreen;
}
export async function prepareCurrentScreeningQuestionAssessment(
  subject: WorkspaceSubject,
  opportunityId: string,
  deps: ScreeningQuestionAssessmentDependencies = {},
  options: ScreeningQuestionAssessmentOptions = {},
): Promise<PreparedOpportunityQuestionScreening> {
  return await fresh(
    subject,
    deps,
    async (owned) =>
      await prepare(opportunityId, owned, deps, undefined, options),
  );
}
export interface ScreeningQuestionRecommendationScope {
  questionScreeningEnabled: boolean;
  candidateMaterialFingerprint?: string;
  questionSetFingerprint?: string;
  blockedReason?: string;
}
/** Read owned semantic ranking material once; never hydrate postings or receipts. */
export async function loadCurrentScreeningQuestionRecommendationScope(
  subject: WorkspaceSubject,
  deps: ScreeningQuestionAssessmentDependencies = {},
): Promise<ScreeningQuestionRecommendationScope> {
  return await fresh(subject, deps, async (owned) => {
    try {
      const questions = await (
        deps.listQuestions ?? listAssessmentScreeningQuestions
      )(owned);
      const enabled = questions.questions.some((question) => question.active);
      if (questions.invalidQuestions.length || questions.errors.length)
        return {
          questionScreeningEnabled: true,
          blockedReason: 'Current screening questions need repair.',
        };
      if (!enabled) return { questionScreeningEnabled: false };
      const material = await context(owned, deps, questions);
      return {
        questionScreeningEnabled: true,
        candidateMaterialFingerprint: material.candidateFingerprint,
        questionSetFingerprint: material.questions.questionSetFingerprint,
      };
    } catch (error) {
      if (isOwnerAuthorityDenial(error)) throw error;
      return {
        questionScreeningEnabled: true,
        blockedReason: 'Current screening material is unavailable.',
      };
    }
  });
}

function ownerValues(subject: WorkspaceSubject) {
  return [subject.tenantId, subject.userId, subject.profileId];
}
type VerifiedReceipt = {
  result: OpportunityQuestionScreeningResult;
  intelligenceRequestId: string;
  intelligenceResultId: string;
  proofFinishedAt: Date;
};
/** Native q/r/run joins authorize output; prepared or saved JSON never does. */
async function receipt(
  prepared: PreparedOpportunityQuestionScreening,
  subject: WorkspaceSubject,
  deps: ScreeningQuestionAssessmentDependencies,
): Promise<VerifiedReceipt | undefined> {
  const fp = opportunityQuestionScreeningInputFingerprint(prepared, subject);
  const plan = preflightOpportunityQuestionScreening(prepared);
  const found = await (await database(deps)).query(
    `SELECT r.id AS result_id, r.output_json, q.request_id, q.agent_run_id, q.finished_at, q.reserved_input_tokens, q.requested_max_output_tokens, q.reserved_spend_micros,
    a.intelligence_reserved_calls AS reserved_calls, a.intelligence_actual_calls AS actual_calls, a.intelligence_call_limit AS call_limit,
    a.intelligence_reserved_input_tokens AS reserved_tokens, (a.intelligence_actual_input_tokens + a.intelligence_actual_output_tokens) AS actual_tokens, a.intelligence_input_token_limit AS token_limit,
    a.intelligence_reserved_spend_micros AS reserved_spend, a.intelligence_actual_spend_micros AS actual_spend, a.intelligence_spend_limit_micros AS spend_limit
    FROM opportunity_intelligence_results r JOIN opportunity_intelligence_requests q
      ON q.request_id = r.owner_request_id AND q.request_id = r.request_id AND q.idempotency_key = r.idempotency_key
      AND q.opportunity_id = r.opportunity_id AND q.agent_run_id = r.agent_run_id AND q.content_fingerprint = r.content_fingerprint AND q.input_fingerprint = r.input_fingerprint
      AND q.model = r.model AND q.feature = r.feature AND q.profile = r.profile
      AND q.tenant_id = r.tenant_id AND q.owner_user_id = r.owner_user_id AND q.candidate_profile_id = r.candidate_profile_id
    JOIN agent_runs a ON CAST(a.id AS TEXT) = q.agent_run_id AND a.opportunity_id = q.opportunity_id
      AND a.tenant_id = q.tenant_id AND a.owner_user_id = q.owner_user_id AND a.candidate_profile_id = q.candidate_profile_id
    WHERE r.opportunity_id = ? AND r.content_fingerprint = ? AND r.input_fingerprint = ?
      AND r.feature = ? AND r.profile = ? AND r.model = ? AND r.prompt_version = ? AND r.output_schema_version = ? AND r.prepared_payload_version = ?
      AND r.tenant_id = ? AND r.owner_user_id = ? AND r.candidate_profile_id = ?
      AND r.status = 'completed' AND q.status = 'succeeded' AND q.accounting_basis = 'actual' AND q.actual_total_tokens > 0
      AND (a.status IN ('running', 'succeeded') OR (a.status = 'failed' AND a.error = 'question_screening_failed'
        AND a.intelligence_actual_calls = 1
        AND NOT EXISTS (SELECT 1 FROM opportunity_intelligence_requests other_request WHERE other_request.agent_run_id = q.agent_run_id AND other_request.request_id <> q.request_id))) LIMIT 2`,
    [
      prepared.opportunityId,
      prepared.sourceContentFingerprint,
      fp,
      OPPORTUNITY_QUESTION_SCREENING_FEATURE,
      OPPORTUNITY_QUESTION_SCREENING_PROFILE,
      prepared.model,
      prepared.version,
      prepared.version,
      prepared.version,
      ...ownerValues(subject),
    ],
  );
  if (found.rows.length !== 1) return undefined;
  const row = found.rows[0]!;
  if (
    typeof row.result_id !== 'string' ||
    !row.result_id ||
    typeof row.request_id !== 'string' ||
    !row.request_id ||
    typeof row.agent_run_id !== 'string' ||
    !row.agent_run_id ||
    counter(row.reserved_input_tokens) !== plan.inputTokenCeiling ||
    counter(row.requested_max_output_tokens) !== plan.maxOutputTokens ||
    !Number.isSafeInteger(counter(row.reserved_spend_micros)) ||
    counter(row.reserved_spend_micros) < Math.max(1, plan.spendMicros) ||
    counter(row.actual_calls) < 1
  )
    return undefined;
  const proofFinishedAt = new Date(String(row.finished_at ?? ''));
  if (Number.isNaN(proofFinishedAt.getTime())) return undefined;
  for (const [reserved, actual, limit, maximum] of [
    ['reserved_calls', 'actual_calls', 'call_limit', 4],
    ['reserved_tokens', 'actual_tokens', 'token_limit', 80000],
    ['reserved_spend', 'actual_spend', 'spend_limit', 100000],
  ] as const) {
    const counters = [
      counter(row[reserved]),
      counter(row[actual]),
      counter(row[limit]),
    ];
    if (
      counters.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      counters[2]! < 1 ||
      counters[0]! + counters[1]! > Math.min(counters[2]!, maximum)
    )
      return undefined;
  }
  try {
    return {
      result: resolveOpportunityQuestionScreening(
        prepared,
        JSON.parse(String(row.output_json)),
        {
          requestId: row.request_id,
          inputFingerprint: fp,
          agentRunId: row.agent_run_id,
        },
      ),
      intelligenceRequestId: row.request_id,
      intelligenceResultId: row.result_id,
      proofFinishedAt,
    };
  } catch {
    return undefined;
  }
}
async function saved(
  prepared: PreparedOpportunityQuestionScreening,
  subject: WorkspaceSubject,
  deps: ScreeningQuestionAssessmentDependencies,
) {
  return await (deps.listSaved ?? listPrivateRecords)(
    'OpportunityAssessment',
    subject,
    {
      where: {
        opportunityId: prepared.opportunityId,
        contractVersion: prepared.version,
        assessmentFingerprint: opportunityQuestionScreeningInputFingerprint(
          prepared,
          subject,
        ),
        status: 'question_screened',
      },
    },
  );
}
function savedMatches(
  row: Row,
  result: OpportunityQuestionScreeningResult,
  subject: WorkspaceSubject,
): boolean {
  if (
    !recordOwnedBySubject(row, subject) ||
    row.contractVersion !== result.contractVersion ||
    row.model !== result.model ||
    row.sourceContentFingerprint !== result.sourceContentFingerprint ||
    Number(row.sourceContentVersion) !== result.sourceContentVersion ||
    row.candidateMaterialFingerprint !== result.candidateMaterialFingerprint ||
    row.preferencesFingerprint !== result.questionSetFingerprint ||
    row.assessmentFingerprint !== result.inputFingerprint ||
    row.agentRunId !== result.agentRunId ||
    row.status !== 'question_screened'
  )
    return false;
  try {
    return hash(JSON.parse(String(row.assessmentJson))) === hash(result);
  } catch {
    return false;
  }
}
function rankMatches(
  rank: OwnedOpportunityRecommendationRankRow,
  opportunityId: string,
  opportunity: Row,
  assessment: Row,
  receipt: VerifiedReceipt,
  subject: WorkspaceSubject,
): boolean {
  const actual = receipt.result;
  const assessmentId = typeof assessment.id === 'string' ? assessment.id : '';
  const finishedAt =
    rank.proofFinishedAt instanceof Date
      ? rank.proofFinishedAt
      : new Date(String(rank.proofFinishedAt ?? ''));
  return (
    rank.tenantId === subject.tenantId &&
    rank.ownerUserId === subject.userId &&
    rank.candidateProfileId === subject.profileId &&
    rank.opportunityId === opportunityId &&
    rank.sourceContentFingerprint === actual.sourceContentFingerprint &&
    Number(rank.sourceContentVersion) === actual.sourceContentVersion &&
    rank.candidateMaterialFingerprint === actual.candidateMaterialFingerprint &&
    rank.questionSetFingerprint === actual.questionSetFingerprint &&
    rank.projectionVersion === OPPORTUNITY_RECOMMENDATION_RANK_VERSION &&
    rank.recommendationPercent === actual.aggregate.recommendationPercent &&
    rank.evidenceCoveragePercent === actual.aggregate.evidenceCoveragePercent &&
    rank.mustHaveConflictCount ===
      actual.aggregate.mustHaveConflictIds.length &&
    rank.assessmentCompleteness ===
      (actual.rolePreScreen ? 'title_only' : 'full') &&
    rank.requiredSkillsSnapshot ===
      rawSkillSnapshot(opportunity.requiredSkills) &&
    rank.preferredSkillsSnapshot ===
      rawSkillSnapshot(opportunity.preferredSkills) &&
    rank.contractVersion === actual.contractVersion &&
    rank.model === actual.model &&
    rank.assessmentId === assessmentId &&
    rank.intelligenceRequestId === receipt.intelligenceRequestId &&
    rank.intelligenceResultId === receipt.intelligenceResultId &&
    rank.agentRunId === actual.agentRunId &&
    rank.assessmentFingerprint === actual.inputFingerprint &&
    !Number.isNaN(finishedAt.getTime()) &&
    finishedAt.getTime() === receipt.proofFinishedAt.getTime()
  );
}
function rankPublication(
  subject: WorkspaceSubject,
  opportunityId: string,
  assessment: Row,
  receipt: VerifiedReceipt,
  snapshots: OpportunitySkillSnapshots,
): VerifiedOpportunityRecommendationRankPublication {
  const actual = receipt.result;
  const assessmentId = typeof assessment.id === 'string' ? assessment.id : '';
  return {
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
    candidateProfileId: subject.profileId,
    opportunityId,
    recommendationPercent: actual.aggregate.recommendationPercent,
    evidenceCoveragePercent: actual.aggregate.evidenceCoveragePercent,
    mustHaveConflictCount: actual.aggregate.mustHaveConflictIds.length,
    assessmentCompleteness: actual.rolePreScreen ? 'title_only' : 'full',
    sourceContentFingerprint: actual.sourceContentFingerprint,
    sourceContentVersion: actual.sourceContentVersion,
    candidateMaterialFingerprint: actual.candidateMaterialFingerprint,
    questionSetFingerprint: actual.questionSetFingerprint,
    ...snapshots,
    contractVersion: actual.contractVersion,
    model: actual.model,
    assessmentId,
    intelligenceRequestId: receipt.intelligenceRequestId,
    intelligenceResultId: receipt.intelligenceResultId,
    agentRunId: actual.agentRunId,
    assessmentFingerprint: actual.inputFingerprint,
    proofFinishedAt: receipt.proofFinishedAt,
  };
}
async function publish(
  prepared: PreparedOpportunityQuestionScreening,
  expected: OpportunityQuestionScreeningResult,
  subject: WorkspaceSubject,
  deps: ScreeningQuestionAssessmentDependencies,
): Promise<OpportunityQuestionScreeningResult> {
  return await fresh(subject, deps, async (owned) => {
    const current = await prepare(
      prepared.opportunityId,
      owned,
      deps,
      undefined,
      { version: prepared.version, rolePreScreen: !!prepared.rolePreScreen },
    );
    if (current.fingerprint !== prepared.fingerprint)
      throw new Error(
        'Question screening material changed before publication.',
      );
    const verified = await receipt(current, owned, deps);
    if (!verified || hash(verified.result) !== hash(expected))
      throw new Error(
        'Question screening needs a completed actual private receipt before publication.',
      );
    const records = await saved(current, owned, deps);
    if (
      records.length > 1 ||
      records.some((row) => !savedMatches(row, verified.result, owned))
    )
      throw new Error('Saved question screening identity is ambiguous.');
    return await fresh(owned, deps, async (publicationSubject) => {
      const transaction =
        deps.transaction ?? runOpportunityLifecycleTransaction;
      return await transaction(async (transactionDatabase) => {
        const finalOpportunity = await lockedFinalOpportunity(
          prepared.opportunityId,
          deps,
          transactionDatabase as Database,
        );
        if (!finalOpportunity || finalOpportunity.id !== prepared.opportunityId)
          throw new Error('Current captured opportunity is missing.');
        const transactionDeps = {
          ...deps,
          db: transactionDatabase as Database,
          getOpportunity: async (id: string) =>
            id === prepared.opportunityId ? finalOpportunity : null,
        };
        const publicationMaterial = await prepare(
          prepared.opportunityId,
          publicationSubject,
          transactionDeps,
          undefined,
          {
            version: prepared.version,
            rolePreScreen: !!prepared.rolePreScreen,
          },
        );
        if (publicationMaterial.fingerprint !== prepared.fingerprint)
          throw new Error(
            'Question screening material changed at the final publication fence.',
          );
        const finalReceipt = await receipt(
          publicationMaterial,
          publicationSubject,
          transactionDeps,
        );
        if (!finalReceipt || hash(finalReceipt.result) !== hash(expected))
          throw new Error(
            'Question screening receipt changed at the final publication fence.',
          );
        const finalRecords = await (
          transactionDeps.listSaved ?? listPrivateRecords
        )(
          'OpportunityAssessment',
          publicationSubject,
          {
            where: {
              opportunityId: prepared.opportunityId,
              contractVersion: publicationMaterial.version,
              assessmentFingerprint: finalReceipt.result.inputFingerprint,
              status: 'question_screened',
            },
          },
          { db: transactionDatabase },
        );
        if (
          finalRecords.length > 1 ||
          finalRecords.some(
            (row) =>
              !savedMatches(row, finalReceipt.result, publicationSubject),
          )
        )
          throw new Error('Saved question screening identity is ambiguous.');
        const assessment =
          finalRecords[0] ??
          (await (transactionDeps.save ?? createPrivateRecord)(
            'OpportunityAssessment',
            publicationSubject,
            {
              opportunityId: prepared.opportunityId,
              assessmentFingerprint: finalReceipt.result.inputFingerprint,
              candidateMaterialFingerprint:
                finalReceipt.result.candidateMaterialFingerprint,
              preferencesFingerprint:
                finalReceipt.result.questionSetFingerprint,
              sourceContentFingerprint:
                finalReceipt.result.sourceContentFingerprint,
              sourceContentVersion: finalReceipt.result.sourceContentVersion,
              contractVersion: finalReceipt.result.contractVersion,
              model: finalReceipt.result.model,
              provider: 'typesafe',
              assessmentJson: JSON.stringify(finalReceipt.result),
              projectionJson: JSON.stringify(
                projection(publicationMaterial, finalReceipt.result),
              ),
              status: 'question_screened',
              agentRunId: finalReceipt.result.agentRunId,
              fitScore: 0,
              excluded: false,
              eligibilityBucket: 'unknown',
              eligibilityPriority: 2,
              matchReadiness: 'needs_evidence',
            },
            { db: transactionDatabase },
          ));
        await (
          transactionDeps.saveRank ?? saveVerifiedOpportunityRecommendationRank
        )(
          transactionDatabase,
          rankPublication(
            publicationSubject,
            publicationMaterial.opportunityId,
            assessment,
            finalReceipt,
            opportunitySkillSnapshots(finalOpportunity),
          ),
        );
        return finalReceipt.result;
      });
    });
  });
}
export async function readCurrentScreeningQuestionAssessment(
  subject: WorkspaceSubject,
  opportunityId: string,
  deps: ScreeningQuestionAssessmentDependencies = {},
  options: ScreeningQuestionAssessmentOptions = {},
): Promise<OpportunityQuestionScreeningResult | undefined> {
  return await fresh(subject, deps, async (owned) => {
    const prepared = await prepare(
      opportunityId,
      owned,
      deps,
      undefined,
      options,
    );
    const records = await saved(prepared, owned, deps);
    if (records.length !== 1) return undefined;
    const actual = await receipt(prepared, owned, deps);
    if (!actual || !savedMatches(records[0]!, actual.result, owned))
      return undefined;
    if (
      ![
        OPPORTUNITY_QUESTION_SCREENING_VERSION,
        OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
      ].includes(prepared.version)
    )
      return actual.result;
    const opportunity = await (
      deps.getOpportunity ?? ((id) => native('Opportunity', id))
    )(opportunityId);
    if (!opportunity || opportunity.id !== opportunityId) return undefined;
    const ranks = await (
      deps.listRanks ?? listOwnedOpportunityRecommendationRanks
    )(owned, [opportunityId], { db: deps.db as never });
    return ranks.length === 1 &&
      rankMatches(
        ranks[0]!,
        opportunityId,
        opportunity,
        records[0]!,
        actual,
        owned,
      )
      ? actual.result
      : undefined;
  });
}
async function executePreparedScreening(
  prepared: PreparedOpportunityQuestionScreening,
  owned: WorkspaceSubject,
  deps: ScreeningQuestionAssessmentDependencies,
): Promise<{ result: OpportunityQuestionScreeningResult; reused: boolean }> {
  const opportunityId = prepared.opportunityId;
  const actual = await receipt(prepared, owned, deps);
  if (actual)
    return {
      result: await publish(prepared, actual.result, owned, deps),
      reused: true,
    };
  const prior = await (await database(deps)).query(
    'SELECT request_id FROM opportunity_intelligence_requests WHERE opportunity_id = ? AND content_fingerprint = ? AND input_fingerprint = ? AND feature = ? AND profile = ? AND model = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ? LIMIT 1',
    [
      opportunityId,
      prepared.sourceContentFingerprint,
      opportunityQuestionScreeningInputFingerprint(prepared, owned),
      OPPORTUNITY_QUESTION_SCREENING_FEATURE,
      OPPORTUNITY_QUESTION_SCREENING_PROFILE,
      prepared.model,
      ...ownerValues(owned),
    ],
  );
  if (prior.rows.length)
    throw new Error(
      'This exact question screening identity is already attempted or in progress.',
    );
  if (!preflightOpportunityQuestionScreening(prepared).fits)
    throw new Error(
      'Question screening exceeds the exact provider or native run budget; shorten questions or reduce enabled questions.',
    );
  const agentRunId = await (
    deps.startRun ?? startOpportunityIntelligenceAgentRun
  )({ opportunityId, workspaceSubject: owned });
  try {
    const result = await (
      deps.evaluate ?? evaluateOpportunityQuestionScreening
    )(prepared, {
      agentRunId,
      subject: owned,
      signal: AbortSignal.timeout(45000),
      loadCurrent: async () =>
        await prepareCurrentScreeningQuestionAssessment(
          owned,
          opportunityId,
          deps,
          {
            version: prepared.version,
            rolePreScreen: !!prepared.rolePreScreen,
          },
        ),
      revalidateAuthority: async () => {
        await fresh(owned, deps, async () => undefined);
      },
    });
    const published = await publish(prepared, result, owned, deps);
    await (deps.finishRun ?? finishOpportunityIntelligenceAgentRun)(
      agentRunId,
      'succeeded',
      '',
      owned,
    );
    return { result: published, reused: false };
  } catch (cause) {
    await (deps.finishRun ?? finishOpportunityIntelligenceAgentRun)(
      agentRunId,
      'failed',
      'question_screening_failed',
      owned,
    );
    throw cause;
  }
}
export async function runScreeningQuestionAssessment(
  subject: WorkspaceSubject,
  input: { opportunityId: string; fullReview?: boolean },
  deps: ScreeningQuestionAssessmentDependencies = {},
): Promise<{ result: OpportunityQuestionScreeningResult; reused: boolean }> {
  const opportunityId = exactId(input.opportunityId);
  return await (deps.lock ?? withOpportunityLifecycleLock)(
    opportunityId,
    async () =>
      await fresh(subject, deps, async (owned) => {
        const shared = await context(owned, deps);
        const full = await prepare(opportunityId, owned, deps, shared);
        // Completed full results take precedence; never charge to pre-screen them again.
        const existing = await receipt(full, owned, deps);
        if (existing)
          return {
            result: await publish(full, existing.result, owned, deps),
            reused: true,
          };
        if (!input.fullReview) {
          const preScreen = prepareOpportunityRolePreScreen(
            full,
            shared.profile,
          );
          if (preScreen) {
            const screened = await executePreparedScreening(
              preScreen,
              owned,
              deps,
            );
            if (screened.result.rolePreScreen?.outcome === 'unrelated')
              return screened;
          }
        }
        return await executePreparedScreening(full, owned, deps);
      }),
  );
}

export type ScreeningQuestionRecommendationRankBackfillOutcome =
  | 'projected'
  | 'already_current'
  | 'stale'
  | 'missing';

/**
 * Repairs the persisted rank for one owned opportunity from an already
 * completed native receipt. This deliberately has no evaluator, run, or
 * provider path: backfill cannot create intelligence work.
 */
export async function backfillCurrentScreeningQuestionRecommendationRank(
  subject: WorkspaceSubject,
  opportunityId: string,
  deps: ScreeningQuestionAssessmentDependencies = {},
): Promise<ScreeningQuestionRecommendationRankBackfillOutcome> {
  const id = exactId(opportunityId);
  return await (deps.lock ?? withOpportunityLifecycleLock)(
    id,
    async () =>
      await fresh(subject, deps, async (owned) => {
        try {
          const full = await prepare(id, owned, deps);
          const completed = await receipt(full, owned, deps);
          if (completed) {
            const prior = await saved(full, owned, deps);
            const wasCurrent =
              prior.length === 1 &&
              savedMatches(prior[0]!, completed.result, owned);
            await publish(full, completed.result, owned, deps);
            return wasCurrent ? 'already_current' : 'projected';
          }

          const legacyFull = await prepare(id, owned, deps, undefined, {
            version: OPPORTUNITY_QUESTION_SCREENING_VERSION,
          });
          const titleOnly = prepareOpportunityRolePreScreen(
            legacyFull,
            (await context(owned, deps)).profile,
          );
          if (!titleOnly) return 'missing';
          const titleReceipt = await receipt(titleOnly, owned, deps);
          if (
            !titleReceipt ||
            titleReceipt.result.rolePreScreen?.outcome !== 'unrelated'
          )
            return 'missing';
          const prior = await saved(titleOnly, owned, deps);
          const wasCurrent =
            prior.length === 1 &&
            savedMatches(prior[0]!, titleReceipt.result, owned);
          await publish(titleOnly, titleReceipt.result, owned, deps);
          return wasCurrent ? 'already_current' : 'projected';
        } catch (cause) {
          if (isOwnerAuthorityDenial(cause)) throw cause;
          return 'stale';
        }
      }),
  );
}

function projection(
  prepared: PreparedOpportunityQuestionScreening,
  actual: OpportunityQuestionScreeningResult,
): ScreeningQuestionAssessmentProjection {
  return {
    ...(actual.skillMatches ? { skillMatches: actual.skillMatches } : {}),
    ...(actual.rolePreScreen ? { rolePreScreen: actual.rolePreScreen } : {}),
    version: 'opportunity-question-screening-projection/v1',
    sourceStatus: 'current',
    model: actual.model,
    questions: prepared.questions,
    answers: actual.answers,
    aggregate: actual.aggregate,
  };
}
/** One owned saved-locator selection and one candidate/question snapshot, never whole-corpus hydration. */
export async function loadCurrentScreeningQuestionAssessmentProjections(
  input: { opportunities: Row[]; subject: WorkspaceSubject },
  deps: ScreeningQuestionAssessmentDependencies = {},
): Promise<ScreeningQuestionAssessmentProjectionMap> {
  const result: ScreeningQuestionAssessmentProjectionMap = Object.assign(
    new Map<string, ScreeningQuestionAssessmentProjection>(),
    {
      questionScreeningStatuses: new Map<string, 'current' | 'unknown'>(),
      questionScreeningEnabled: true,
    },
  );
  try {
    return await fresh(input.subject, deps, async (owned) => {
      let selectedQuestions: ScreeningQuestionSnapshot;
      try {
        selectedQuestions = await (
          deps.listQuestions ?? listAssessmentScreeningQuestions
        )(owned);
      } catch {
        result.blockedReason =
          'Current screening questions are unavailable for this workspace.';
        return result;
      }
      result.questionScreeningEnabled = !!(
        selectedQuestions.invalidQuestions.length ||
        selectedQuestions.errors.length ||
        selectedQuestions.questions.some((question) => question.active)
      );
      if (
        selectedQuestions.invalidQuestions.length ||
        selectedQuestions.errors.length ||
        !selectedQuestions.questions.some((question) => question.active)
      ) {
        result.blockedReason =
          selectedQuestions.errors[0] ??
          (selectedQuestions.invalidQuestions.length
            ? 'Repair invalid screening questions before running.'
            : 'Enable at least one screening question before running.');
      }
      const ids = [
        ...new Set(
          input.opportunities.flatMap((row) =>
            typeof row.id === 'string' && row.id ? [row.id] : [],
          ),
        ),
      ];
      if (!ids.length) return result;
      const ranks = await (
        deps.listRanks ?? listOwnedOpportunityRecommendationRanks
      )(owned, ids, { db: deps.db as never });
      const records = await (deps.listSaved ?? listPrivateRecords)(
        'OpportunityAssessment',
        owned,
        {
          where: {
            'opportunityId in': ids,
            'contractVersion in': [
              OPPORTUNITY_QUESTION_SCREENING_VERSION,
              OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
            ],
            status: 'question_screened',
          },
        },
      );
      const selected = [
        ...new Set(
          records
            .filter(
              (row) =>
                recordOwnedBySubject(row, owned) &&
                typeof row.opportunityId === 'string' &&
                ids.includes(row.opportunityId),
            )
            .map((row) => row.opportunityId as string),
        ),
      ];
      for (const id of selected)
        result.questionScreeningStatuses.set(id, 'unknown');
      if (!selected.length || result.blockedReason) return result;
      let shared: Context;
      try {
        shared = await context(owned, deps, selectedQuestions);
      } catch {
        result.blockedReason = 'Current screening material is unavailable.';
        return result;
      }
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, selected.length) }, async () => {
          while (next < selected.length) {
            const id = selected[next++]!;
            try {
              let prepared = await prepare(id, owned, deps, shared);
              let actual = await receipt(prepared, owned, deps);
              if (!actual) {
                const preScreen = prepareOpportunityRolePreScreen(
                  prepared,
                  shared.profile,
                );
                if (preScreen) {
                  const screened = await receipt(preScreen, owned, deps);
                  if (screened?.result.rolePreScreen?.outcome === 'unrelated') {
                    prepared = preScreen;
                    actual = screened;
                  }
                }
              }
              const current = records.filter(
                (row) =>
                  row.opportunityId === id &&
                  row.assessmentFingerprint ===
                    opportunityQuestionScreeningInputFingerprint(
                      prepared,
                      owned,
                    ),
              );
              if (
                !actual ||
                current.length !== 1 ||
                !savedMatches(current[0]!, actual.result, owned)
              )
                continue;
              const supplied = input.opportunities.find(
                (row) => row.id === id,
              )!;
              if (
                supplied.sourceContentFingerprint !==
                  prepared.sourceContentFingerprint ||
                Number(supplied.sourceContentVersion) !==
                  prepared.sourceContentVersion
              )
                continue;
              const currentRanks = ranks.filter(
                (rank) => rank.opportunityId === id,
              );
              if (
                currentRanks.length !== 1 ||
                !rankMatches(
                  currentRanks[0]!,
                  id,
                  supplied,
                  current[0]!,
                  actual,
                  owned,
                )
              )
                continue;
              result.set(id, projection(prepared, actual.result));
              result.questionScreeningStatuses.set(id, 'current');
            } catch {
              /* Current unknown marker remains; no fallback to stale answers. */
            }
          }
        }),
      );
      return result;
    });
  } catch (cause) {
    if (
      cause instanceof JobWorkspaceSubjectError ||
      isOwnerAuthorityDenial(cause)
    ) {
      result.blockedReason =
        'Current workspace permission is required to run screening.';
      return result;
    }
    throw cause;
  }
}
