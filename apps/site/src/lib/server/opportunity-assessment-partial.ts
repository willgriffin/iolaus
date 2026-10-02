import { createHash } from 'node:crypto';
import {
  type DecisionRequest,
  type DecisionResult,
  getAI,
} from '@happyvertical/ai';
import {
  assessmentDecisionOutputTokenCeiling,
  OPPORTUNITY_ASSESSMENT_CONFIDENCE,
  OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS,
  OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES,
  type OpportunityAssessmentCitation,
  type OpportunityAssessmentSource,
} from './opportunity-assessment.js';
import { buildPartialOpportunityAssessmentPostingInput } from './opportunity-assessment-input.js';
import { resolveOpportunityIntelligenceBudgetConfig } from './opportunity-intelligence-config.js';
import {
  executeGovernedOpportunityIntelligenceRequest,
  type OpportunityIntelligenceGovernanceStore,
} from './opportunity-intelligence-governance.js';
import {
  type PartialOpportunityRequirementEvidence,
  partialRequirementEvidenceFromAudit,
  prepareCapturedSourceCompositeRequirementEvidenceAudit,
  prepareCompositeRequirementEvidenceAudit,
  prepareRequirementEvidenceAudit,
  prepareSourceEligibilityCompositeRequirementEvidenceAudit,
  readPartialOpportunityRequirementEvidence,
} from './opportunity-requirement-coverage-provider.js';
import {
  createPrivateRecord,
  listPrivateRecords,
  type WorkspaceSubject,
} from './private-workspace.js';

export const OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION =
  'opportunity-assessment-partial/v1';
export interface PreparedPartialOpportunityAssessment {
  request: DecisionRequest;
  fingerprint: string;
  candidateMaterialFingerprint: string;
  evidenceFingerprint: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  sourceCatalog: OpportunityAssessmentCitation[];
  bindings: Record<string, { requirementId: string; candidateKey: string }>;
  requirements: Array<{
    id: string;
    text: string;
    postingSourceKeys: string[];
  }>;
}
export interface PartialOpportunityAssessmentResult {
  contractVersion: typeof OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION;
  mode: 'partial';
  matchReadiness: 'needs_evidence';
  fingerprint: string;
  requestId?: string;
  inputFingerprint?: string;
  candidateMaterialFingerprint: string;
  evidenceFingerprint: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  requirements: Array<{
    id: string;
    support: 'supported' | 'uncertain';
    candidateSourceKeys: string[];
    postingSourceKeys: string[];
  }>;
  sourceCatalog: OpportunityAssessmentCitation[];
  answerProbabilities: Record<string, number>;
  provenance: DecisionResult['provenance'];
  unresolvedClauses: Array<{
    clauseId: string;
    spanStart: number;
    spanEnd: number;
    hash: string;
    reason: string;
  }>;
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function candidatesFor(
  text: string,
  sources: OpportunityAssessmentSource[],
): OpportunityAssessmentSource[] {
  const tokens = (value: string) =>
    (value.toLowerCase().match(/[a-z0-9+#.]{2,}/gu) ?? [])
      .map((term) => term.replace(/\.+$/u, ''))
      .filter(Boolean);
  const terms = new Set(tokens(text));
  const stop = new Set([
    'and',
    'the',
    'for',
    'with',
    'using',
    'experience',
    'years',
    'year',
    'skills',
    'knowledge',
  ]);
  for (const term of stop) terms.delete(term);
  const score = (source: OpportunityAssessmentSource) => {
    const words = new Set(tokens(`${source.title} ${source.text}`));
    const overlap = [...terms].filter((term) => words.has(term)).length;
    return (
      overlap * (source.kind === 'skill' ? 30 : 10) +
      (source.kind === 'candidate_profile'
        ? 3
        : source.kind === 'employment'
          ? 2
          : source.kind === 'skill_context'
            ? 1
            : 0)
    );
  };
  return sources
    .filter((source) => source.kind !== 'skill')
    .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}

export function preflightPartialOpportunityAssessment(
  prepared: PreparedPartialOpportunityAssessment,
  runLimit = 80_000,
) {
  const requestBytes = Buffer.byteLength(
    JSON.stringify(prepared.request),
    'utf8',
  );
  const maxOutputTokens = assessmentDecisionOutputTokenCeiling(
    prepared.request,
  );
  const reservedTokens = requestBytes + maxOutputTokens;
  const scopeComplete =
    prepared.requirements.length > 0 &&
    prepared.requirements.every((row) =>
      Object.values(prepared.bindings).some(
        (binding) => binding.requirementId === row.id,
      ),
    );
  return {
    requestBytes,
    maxOutputTokens,
    reservedTokens,
    calls: 1,
    scopeComplete,
    fits:
      scopeComplete &&
      requestBytes <= OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES &&
      maxOutputTokens <= OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS &&
      reservedTokens <= Math.min(runLimit, 80_000),
  };
}

export function preparePartialOpportunityAssessment(input: {
  opportunityId: string;
  evidence: PartialOpportunityRequirementEvidence;
  candidateSources: OpportunityAssessmentSource[];
  candidateMaterialFingerprint: string;
  candidateCoverageTruncated?: boolean;
}): PreparedPartialOpportunityAssessment {
  if (
    input.candidateCoverageTruncated ||
    !input.candidateMaterialFingerprint ||
    !input.evidence.acceptedRequirements.length
  )
    throw new Error(
      'Partial matching requires complete candidate facts and at least one recorded accepted criterion.',
    );
  if (
    new Set(input.candidateSources.map((source) => source.id)).size !==
    input.candidateSources.length
  )
    throw new Error('Candidate evidence identities must be unique.');
  const canonicalEvidence = partialRequirementEvidenceFromAudit(
    input.evidence.capturedSource
      ? prepareCapturedSourceCompositeRequirementEvidenceAudit(
          input.evidence.context,
          input.evidence.ledger,
          {
            ...input.evidence.capturedSource,
          },
        )
      : input.evidence.audit.sourceEligibility
        ? prepareSourceEligibilityCompositeRequirementEvidenceAudit(
            input.evidence.context,
            input.evidence.ledger,
          )
        : input.evidence.audit.video
          ? prepareCompositeRequirementEvidenceAudit(
              input.evidence.context,
              input.evidence.ledger,
            )
          : prepareRequirementEvidenceAudit(
              input.evidence.context,
              input.evidence.ledger,
              { version: input.evidence.audit.version },
            ),
    input.evidence.audit,
  );
  if (
    canonicalEvidence.fingerprint !== input.evidence.fingerprint ||
    hash(canonicalEvidence.acceptedRequirements) !==
      hash(input.evidence.acceptedRequirements) ||
    hash(canonicalEvidence.unresolvedClauses) !==
      hash(input.evidence.unresolvedClauses)
  )
    throw new Error(
      'Partial accepted excerpts changed after the canonical source audit.',
    );
  const posting = buildPartialOpportunityAssessmentPostingInput(
    input.opportunityId,
    canonicalEvidence,
  );
  const requirements = posting.requirements.map((row, index) => ({
    id: row.id,
    text: row.text,
    postingSourceKeys: [`p${index}`],
  }));
  const sourceCatalog: OpportunityAssessmentCitation[] = [
    ...input.candidateSources.map((source, index) => ({
      key: `c${index}`,
      sourceId: source.id,
      kind: source.kind,
      ...(source.recordId ? { recordId: source.recordId } : {}),
      ...(source.sectionId ? { sectionId: source.sectionId } : {}),
    })),
    ...posting.postingSources.map((source, index) => ({
      key: `p${index}`,
      sourceId: source.id,
      kind: source.kind,
      recordId: input.opportunityId,
      ...(source.sourceSpans ? { sourceSpans: source.sourceSpans } : {}),
    })),
  ];
  const prepared: PreparedPartialOpportunityAssessment = {
    fingerprint: '',
    candidateMaterialFingerprint: input.candidateMaterialFingerprint,
    evidenceFingerprint: input.evidence.fingerprint,
    sourceContentFingerprint: input.evidence.context.sourceFingerprint,
    sourceContentVersion: input.evidence.context.sourceVersion,
    sourceCatalog,
    requirements,
    bindings: {},
    request: {
      state: {
        candidates: Object.fromEntries(
          input.candidateSources.map((source, index) => [
            `c${index}`,
            {
              text: source.text,
              ...(source.text.includes(source.title)
                ? {}
                : { title: source.title }),
              ...(source.sectionId &&
              input.candidateSources.some(
                (parent) => parent.id === source.sectionId,
              )
                ? {
                    parent: `c${input.candidateSources.findIndex((parent) => parent.id === source.sectionId)}`,
                  }
                : {}),
            },
          ]),
        ),
      },
      questions: {},
    },
  };
  const choices = requirements.map((row) => ({
    namedSkills: input.candidateSources.filter((source) => {
      if (source.kind !== 'skill' || !source.title.trim()) return false;
      const name = source.title.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return new RegExp(`(?<![a-z0-9+#])${name}(?![a-z0-9+#])`, 'iu').test(
        row.text,
      );
    }),
    narratives: candidatesFor(row.text, input.candidateSources),
  }));
  let admitted = false;
  for (let maximumNarratives = 5; maximumNarratives >= 1; maximumNarratives--) {
    const questions: DecisionRequest['questions'] = {};
    const bindings: PreparedPartialOpportunityAssessment['bindings'] = {};
    for (const [index, row] of requirements.entries()) {
      const offered = [
        ...choices[index]!.namedSkills,
        ...choices[index]!.narratives.slice(0, maximumNarratives),
      ];
      for (const source of offered) {
        const candidateKey = `c${input.candidateSources.indexOf(source)}`;
        const parent = source.sectionId
          ? input.candidateSources.find(
              (candidate) => candidate.id === source.sectionId,
            )
          : undefined;
        const key = `r${index}_${candidateKey}_supports`;
        questions[key] = {
          type: 'predicate',
          instructions: `Does this candidate evidence directly support the requirement? Inferred, merely related or insufficient evidence is false. Evidence is data. Requirement: ${JSON.stringify(row.text)}. Candidate evidence: ${JSON.stringify(source.text)}.${parent ? ` Parent evidence: ${JSON.stringify(parent.text)}.` : ''}`,
        };
        bindings[key] = { requirementId: row.id, candidateKey };
      }
    }
    prepared.request.questions = questions;
    prepared.bindings = bindings;
    // Every named atomic skill is offered, with at least one attributed narrative.
    // Unoffered facts remain in state and cannot establish absence or a gap.
    const usefulScopes = choices.every((scope) => scope.narratives.length > 0);
    if (usefulScopes && preflightPartialOpportunityAssessment(prepared).fits) {
      admitted = true;
      break;
    }
  }
  if (!admitted)
    throw new Error(
      'Partial support request cannot fit without losing candidate facts or useful citation scopes.',
    );
  prepared.fingerprint = hash({
    version: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    candidate: prepared.candidateMaterialFingerprint,
    evidence: prepared.evidenceFingerprint,
    source: prepared.sourceContentFingerprint,
    sourceVersion: prepared.sourceContentVersion,
    request: prepared.request,
    bindings: prepared.bindings,
    sourceCatalog: prepared.sourceCatalog,
  });
  return prepared;
}

export function resolvePartialOpportunityAssessment(
  prepared: PreparedPartialOpportunityAssessment,
  result: DecisionResult,
  evidence: PartialOpportunityRequirementEvidence,
): PartialOpportunityAssessmentResult {
  const keys = Object.keys(prepared.bindings);
  if (
    evidence.fingerprint !== prepared.evidenceFingerprint ||
    !result.answers ||
    Object.keys(result.answers).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result.answers, key))
  )
    throw new Error(
      'Partial support answers or recorded source identity do not match the exact request.',
    );
  const answerProbabilities: Record<string, number> = {};
  for (const key of keys) {
    const answer = result.answers[key];
    if (
      answer?.type !== 'predicate' ||
      !Number.isFinite(answer.probability) ||
      answer.probability < 0 ||
      answer.probability > 1
    )
      throw new Error(`Malformed partial support answer: ${key}`);
    answerProbabilities[key] = answer.probability;
  }
  return {
    contractVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    mode: 'partial',
    matchReadiness: 'needs_evidence',
    fingerprint: prepared.fingerprint,
    candidateMaterialFingerprint: prepared.candidateMaterialFingerprint,
    evidenceFingerprint: prepared.evidenceFingerprint,
    sourceContentFingerprint: prepared.sourceContentFingerprint,
    sourceContentVersion: prepared.sourceContentVersion,
    requirements: prepared.requirements.map((row) => {
      const candidateSourceKeys = keys
        .filter(
          (key) =>
            prepared.bindings[key]!.requirementId === row.id &&
            answerProbabilities[key]! >= OPPORTUNITY_ASSESSMENT_CONFIDENCE,
        )
        .map((key) => prepared.bindings[key]!.candidateKey);
      return {
        id: row.id,
        support: candidateSourceKeys.length
          ? ('supported' as const)
          : ('uncertain' as const),
        candidateSourceKeys,
        postingSourceKeys: row.postingSourceKeys,
      };
    }),
    sourceCatalog: prepared.sourceCatalog,
    answerProbabilities,
    provenance: result.provenance,
    unresolvedClauses: evidence.unresolvedClauses.map((clause) => ({
      clauseId: clause.id,
      spanStart: clause.spanStart,
      spanEnd: clause.spanEnd,
      hash: clause.hash,
      reason: clause.reason,
    })),
  };
}

export async function evaluatePartialOpportunityAssessment(
  prepared: PreparedPartialOpportunityAssessment,
  options: {
    agentRunId: string;
    opportunityId: string;
    subject: WorkspaceSubject;
    opportunity: Record<string, unknown>;
    subjectFingerprint: string;
    signal?: AbortSignal;
    store?: OpportunityIntelligenceGovernanceStore;
  },
): Promise<PartialOpportunityAssessmentResult> {
  if (process.env.OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED !== 'true')
    throw new Error('Private partial matching is disabled.');
  const actualFingerprint = hash({
    version: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    candidate: prepared.candidateMaterialFingerprint,
    evidence: prepared.evidenceFingerprint,
    source: prepared.sourceContentFingerprint,
    sourceVersion: prepared.sourceContentVersion,
    request: prepared.request,
    bindings: prepared.bindings,
    sourceCatalog: prepared.sourceCatalog,
  });
  if (actualFingerprint !== prepared.fingerprint)
    throw new Error('Partial request changed after preparation.');
  const evidence = await readPartialOpportunityRequirementEvidence(
    options.opportunity,
  );
  if (
    !evidence ||
    evidence.fingerprint !== prepared.evidenceFingerprint ||
    options.opportunity.id !== options.opportunityId ||
    !options.agentRunId ||
    !options.subjectFingerprint
  )
    throw new Error(
      'A current native GLOBAL evidence receipt and private reservation owner are required.',
    );
  const expectedPosting = buildPartialOpportunityAssessmentPostingInput(
    options.opportunityId,
    evidence,
  );
  const expectedRequirements = expectedPosting.requirements.map(
    (row, index) => ({
      id: row.id,
      text: row.text,
      postingSourceKeys: [`p${index}`],
    }),
  );
  const expectedCatalog = expectedPosting.postingSources.map(
    (source, index) => ({
      key: `p${index}`,
      sourceId: source.id,
      kind: source.kind,
      recordId: options.opportunityId,
      ...(source.sourceSpans ? { sourceSpans: source.sourceSpans } : {}),
    }),
  );
  if (
    hash(expectedRequirements) !== hash(prepared.requirements) ||
    hash(expectedCatalog) !==
      hash(prepared.sourceCatalog.filter((row) => row.key.startsWith('p')))
  )
    throw new Error(
      'Private partial criteria or attribution differs from the native accepted excerpts.',
    );
  const config = resolveOpportunityIntelligenceBudgetConfig();
  const preflight = preflightPartialOpportunityAssessment(
    prepared,
    config.run.inputTokens,
  );
  if (!preflight.fits)
    throw new Error(
      'Partial support request exceeds the existing run/request limits.',
    );
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      'TYPESAFE_API_KEY is required for partial support matching.',
    );
  const price = (name: string) => {
    const value = process.env[name];
    if (!value || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`Configure ${name} for partial support accounting.`);
    return Number(value);
  };
  config.pricing = {
    configured: true,
    inputMicrosPerMillion: price(
      'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
    ),
    outputMicrosPerMillion: price(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
    ),
  };
  const model =
    process.env.OPPORTUNITY_ASSESSMENT_DECISION_MODEL?.trim() ||
    process.env.OPPORTUNITY_SKILL_DECISION_MODEL?.trim() ||
    'jev-latest';
  const inputFingerprint = hash({
    prepared: prepared.fingerprint,
    subject: options.subjectFingerprint,
  });
  const { output, requestId } =
    await executeGovernedOpportunityIntelligenceRequest<DecisionResult>({
      config,
      estimatedInputTokens: preflight.requestBytes,
      inputTokenCeiling: preflight.requestBytes,
      maxOutputTokens: preflight.maxOutputTokens,
      identity: {
        agentRunId: options.agentRunId,
        opportunityId: options.opportunityId,
        contentFingerprint: prepared.sourceContentFingerprint,
        feature: 'opportunity-assessment-partial',
        inputFingerprint,
        model,
        outputSchemaVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
        promptVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
        preparedPayloadVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
        profile: 'typesafe-opportunity-assessment-partial',
      },
      store: options.store,
      workspaceSubject: options.subject,
      signal: options.signal,
      invoke: async () => {
        const client = await getAI({
          type: 'typesafe',
          apiKey,
          defaultModel: model,
        });
        if (!(await client.getCapabilities()).decisions || !client.decide)
          throw new Error('Partial matching requires typed decisions.');
        const result = await client.decide(prepared.request, {
          model,
          signal: options.signal,
          timeout: 30_000,
        });
        resolvePartialOpportunityAssessment(prepared, result, evidence);
        return { output: result, usage: result.usage };
      },
    });
  return {
    ...resolvePartialOpportunityAssessment(prepared, output, evidence),
    requestId,
    inputFingerprint,
  };
}

/** Full parser and ranked SQL require their own contract plus status=current. */
export async function storePartialOpportunityAssessment(input: {
  result: PartialOpportunityAssessmentResult;
  subject: WorkspaceSubject;
  opportunityId: string;
  agentRunId: string;
}): Promise<boolean> {
  const where = {
    opportunityId: input.opportunityId,
    assessmentFingerprint: input.result.fingerprint,
    contractVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
  };
  if (
    (
      await listPrivateRecords('OpportunityAssessment', input.subject, {
        limit: 1,
        where,
      })
    ).length
  )
    return false;
  const payload = {
    ...where,
    agentRunId: input.agentRunId,
    assessmentJson: JSON.stringify(input.result),
    projectionJson: JSON.stringify({
      mode: 'partial',
      matchReadiness: 'needs_evidence',
    }),
    candidateMaterialFingerprint: input.result.candidateMaterialFingerprint,
    sourceContentFingerprint: input.result.sourceContentFingerprint,
    sourceContentVersion: input.result.sourceContentVersion,
    status: 'partial',
    matchReadiness: 'needs_evidence',
    eligibilityBucket: 'unknown',
    eligibilityPriority: 2,
    excluded: false,
    model: input.result.provenance.model,
    provider: input.result.provenance.provider,
  };
  try {
    await createPrivateRecord('OpportunityAssessment', input.subject, payload);
    return true;
  } catch (cause) {
    if (
      !/unique|duplicate|conflict/iu.test(
        cause instanceof Error ? cause.message : String(cause),
      ) ||
      !(
        await listPrivateRecords('OpportunityAssessment', input.subject, {
          limit: 1,
          where,
        })
      ).length
    )
      throw cause;
    return false;
  }
}
