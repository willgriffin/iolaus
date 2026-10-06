import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import type {
  CandidateSkillDiscoverySnapshot,
  CandidateSkillProposal,
} from '../candidate-skill-discovery.js';
import { parseConfirmedCandidateSkills } from '../candidate-skill-discovery.js';
import { parseSkillList } from '../opportunity-filters.js';
import {
  runOpportunityLifecycleTransaction,
  withOpportunityLifecycleLock,
} from './application-workflow.js';
import {
  discoveryHash,
  discoveryVocabulary,
  evaluateSkillDiscovery,
  type PreparedSkillDiscovery,
  preflightSkillDiscovery,
  prepareSkillDiscovery,
  resolveSkillDiscovery,
  SKILL_DISCOVERY_FEATURE,
  SKILL_DISCOVERY_PROFILE,
  SKILL_DISCOVERY_VERSION,
} from './candidate-skill-discovery-engine.js';
import { getDbConfig } from './db.js';
import {
  JobWorkspaceSubjectError,
  runAsRevalidatedJobWorkspaceSubject,
} from './job-workspace-subject.js';
import {
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import { isOwnerAuthorityDenial } from './owner-principal.js';
import {
  getPrivateRecord,
  listPrivateRecords,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import {
  loadWorkspaceCandidateEvidence,
  type WorkspaceCandidateEvidence,
} from './resume-data.js';
import { canonicalSkill } from './skill-matching.js';

type Row = Record<string, unknown>;
type Envelope = Record<string, unknown>;
interface StoredDiscovery {
  version: typeof SKILL_DISCOVERY_VERSION;
  revision: string;
  proposals: CandidateSkillProposal[];
  requestIds: string[];
  vocabulary: string[];
  assessedCount: number;
  batches: { requestId: string; labels: string[] }[];
  evidence: WorkspaceCandidateEvidence['evidence'];
}
export class CandidateSkillDiscoveryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CandidateSkillDiscoveryError';
  }
}
export interface CandidateSkillDiscoveryDependencies {
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  profile?: (subject: WorkspaceSubject) => Promise<Row | null>;
  evidence?: typeof loadWorkspaceCandidateEvidence;
  postings?: (subject: WorkspaceSubject) => Promise<Row[]>;
  compareAndSwap?: (
    subject: WorkspaceSubject,
    prior: Row,
    facts: string,
    preferences: string,
  ) => Promise<boolean>;
  evaluate?: typeof evaluateSkillDiscovery;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
  fits?: typeof preflightSkillDiscovery;
  lock?: typeof withOpportunityLifecycleLock;
  acceptedFacts?: (subject: WorkspaceSubject) => Promise<Row[]>;
  verify?: (
    subject: WorkspaceSubject,
    prepared: PreparedSkillDiscovery,
    requestId: string,
  ) => Promise<CandidateSkillProposal[]>;
}
async function database() {
  return getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
}
async function allPostings(_subject: WorkspaceSubject): Promise<Row[]> {
  const db = await database(),
    rows: Row[] = [];
  let after = '';
  for (;;) {
    const page = await db.query(
      'SELECT CAST(id AS TEXT) AS id, required_skills AS "requiredSkills", preferred_skills AS "preferredSkills" FROM opportunities WHERE CAST(id AS TEXT) > ? ORDER BY CAST(id AS TEXT) ASC LIMIT 500',
      after,
    );
    const found = page.rows as Row[];
    if (!Array.isArray(found))
      throw new CandidateSkillDiscoveryError(
        409,
        'Available posting catalog could not be read.',
      );
    rows.push(...found);
    if (found.length < 500) return rows;
    const next = String(found[found.length - 1]?.id ?? '');
    if (next <= after)
      throw new CandidateSkillDiscoveryError(
        409,
        'Posting pagination did not advance.',
      );
    after = next;
  }
}
function object(raw: unknown, name: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(String(raw || '{}'));
  } catch {
    throw new CandidateSkillDiscoveryError(409, `${name} is malformed.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CandidateSkillDiscoveryError(409, `${name} is malformed.`);
  return value as Envelope;
}
function facts(profile: Row) {
  const next = object(profile.factsJson, 'Profile facts');
  if (next.version !== undefined && next.version !== 1)
    throw new CandidateSkillDiscoveryError(
      409,
      'Profile facts version is unsupported.',
    );
  if (
    next.facts !== undefined &&
    (!next.facts || typeof next.facts !== 'object' || Array.isArray(next.facts))
  )
    throw new CandidateSkillDiscoveryError(409, 'Profile facts are malformed.');
  return {
    ...next,
    version: 1,
    facts: { ...(next.facts as Envelope | undefined) },
  };
}
function stored(profile: Row): StoredDiscovery | undefined {
  const value = object(
    profile.preferencesJson,
    'Profile preferences',
  ).skillDiscovery;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CandidateSkillDiscoveryError(
      409,
      'Saved discovery is malformed.',
    );
  const row = value as StoredDiscovery;
  if (
    row.version !== SKILL_DISCOVERY_VERSION ||
    typeof row.revision !== 'string' ||
    !Array.isArray(row.proposals) ||
    !Array.isArray(row.vocabulary) ||
    !Array.isArray(row.requestIds) ||
    !Number.isSafeInteger(row.assessedCount) ||
    !Array.isArray(row.batches) ||
    !Array.isArray(row.evidence)
  )
    throw new CandidateSkillDiscoveryError(
      409,
      'Saved discovery version or shape is invalid.',
    );
  return row;
}
async function fresh<T>(
  subject: WorkspaceSubject,
  deps: CandidateSkillDiscoveryDependencies,
  work: (owned: WorkspaceSubject, profile: Row) => Promise<T>,
): Promise<T> {
  try {
    return await (deps.runFresh ?? runAsRevalidatedJobWorkspaceSubject)(
      requireWorkspaceSubject(subject),
      'profile.manage',
      async (owned, run) => {
        await run.assertOperation('workflow', 'profile.manage');
        const profile = await (
          deps.profile ??
          ((s) => getPrivateRecord('CandidateProfile', s.profileId, s))
        )(owned);
        if (
          !profile ||
          profile.id !== owned.profileId ||
          profile.tenantId !== owned.tenantId ||
          profile.ownerUserId !== owned.userId ||
          profile.active !== true
        )
          throw new CandidateSkillDiscoveryError(
            403,
            'An active owned profile is required.',
          );
        return await work(owned, profile);
      },
    );
  } catch (error) {
    if (
      error instanceof JobWorkspaceSubjectError ||
      isOwnerAuthorityDenial(error)
    )
      throw new CandidateSkillDiscoveryError(
        403,
        'Current profile permission is required.',
      );
    throw error;
  }
}
async function catalog(
  subject: WorkspaceSubject,
  profile: Row,
  deps: CandidateSkillDiscoveryDependencies,
) {
  const loaded = await (deps.evidence ?? loadWorkspaceCandidateEvidence)(
    subject,
  );
  const postings = await (deps.postings ?? allPostings)(subject);
  const accepted = await (
    deps.acceptedFacts ??
    ((s) =>
      listPrivateRecords('FactCandidate', s, {
        where: { reviewStatus: 'accepted' },
        limit: 1001,
        orderBy: 'id ASC',
      }))
  )(subject);
  if (accepted.length > 1000)
    throw new CandidateSkillDiscoveryError(
      409,
      'Accepted career facts exceed the complete evidence catalog bound.',
    );
  const career = facts(profile).facts;
  const note = career.skillExperience as
    | { value?: unknown; provenance?: unknown }
    | undefined;
  loaded.evidence = loaded.evidence.map((row) =>
    row.id === `profile:${subject.profileId}`
      ? {
          ...row,
          text: [
            profile.title,
            profile.summary,
            note?.provenance === 'user_verified' &&
            typeof note.value === 'string'
              ? note.value
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      : row,
  );
  if (
    note?.provenance === 'user_verified' &&
    typeof note.value === 'string' &&
    note.value.trim()
  )
    loaded.evidence.push({
      id: `skill-experience:${subject.profileId}`,
      kind: 'candidate_profile',
      title: 'User verified skill experience',
      text: note.value,
    });
  for (const row of accepted)
    if (
      row.reviewStatus === 'accepted' &&
      row.targetEntityType === 'CandidateProfile' &&
      row.targetEntityId === subject.profileId &&
      row.tenantId === subject.tenantId &&
      row.ownerUserId === subject.userId &&
      row.candidateProfileId === subject.profileId
    ) {
      const text = String(row.editedStatement || row.statement || '').trim();
      if (text)
        loaded.evidence.push({
          id: `accepted-fact:${row.id}`,
          kind: 'candidate_profile',
          title: 'User accepted career fact',
          text,
        });
    }
  const labels = postings.flatMap((row) => [
    ...parseSkillList(String(row.requiredSkills ?? '')),
    ...parseSkillList(String(row.preferredSkills ?? '')),
  ]);
  const vocabulary = discoveryVocabulary(
    loaded.evidence.filter((row) => !row.id.startsWith('confirmed-skill:')),
    labels,
  );
  // Confirmations add no new original career source; avoid invalidating sibling proposals when confirming one.
  const originalFacts = facts(profile);
  delete originalFacts.facts.confirmedSkills;
  const originalEvidence = loaded.evidence
    .filter((row) => !row.id.startsWith('confirmed-skill:'))
    .map((row) =>
      row.id === `profile:${subject.profileId}`
        ? {
            ...row,
            text: [
              profile.title,
              profile.summary,
              JSON.stringify(originalFacts),
            ]
              .filter(Boolean)
              .join('\n'),
          }
        : row,
    );
  const revision = discoveryHash({
    subject,
    profileTitle: profile.title,
    profileSummary: profile.summary,
    evidence: originalEvidence,
    facts: originalFacts,
    postings: postings.map((row) => ({
      id: row.id,
      requiredSkills: row.requiredSkills,
      preferredSkills: row.preferredSkills,
    })),
    vocabulary,
  });
  return { loaded, vocabulary, revision };
}
function snapshot(
  profile: Row,
  current: Awaited<ReturnType<typeof catalog>>,
): CandidateSkillDiscoverySnapshot {
  const state = stored(profile);
  const confirmed = parseConfirmedCandidateSkills(profile.factsJson);
  const canonicalSkills = [
    ...new Set([
      ...current.loaded.evidence
        .filter((row) => row.kind === 'skill')
        .map((row) => row.text),
      ...confirmed.map((row) => row.label),
    ]),
  ];
  const canonical = new Set(canonicalSkills.map(canonicalSkill));
  const proposals = (state?.proposals ?? []).map((row) => ({
    ...row,
    status:
      row.status === 'pending' && canonical.has(row.canonicalLabel)
        ? ('duplicate' as const)
        : row.status,
  }));
  const assessedCount =
    state?.revision === current.revision ? state.assessedCount : 0;
  return {
    revision: state?.revision ?? current.revision,
    proposals,
    canonicalSkills,
    scope: {
      candidateEvidenceCount: current.loaded.evidence.length,
      vocabularyCount: current.vocabulary.length,
      assessedCount,
      remainingCount: Math.max(0, current.vocabulary.length - assessedCount),
      description:
        'All owned career evidence; vocabulary from explicit available posting skill labels, career skill labels and literal career occurrences of the documented alias vocabulary. Confirmation stores private evidence and its direct/introductory qualification; it does not publish resume skills.',
    },
    status: !state
      ? 'idle'
      : state.revision !== current.revision
        ? 'stale'
        : assessedCount === current.vocabulary.length
          ? 'complete'
          : 'partial',
  };
}
async function save(
  subject: WorkspaceSubject,
  prior: Row,
  nextFacts: Envelope,
  nextPreferences: Envelope,
  deps: CandidateSkillDiscoveryDependencies,
) {
  const factsText = JSON.stringify(nextFacts),
    preferencesText = JSON.stringify(nextPreferences);
  const success = deps.compareAndSwap
    ? await deps.compareAndSwap(subject, prior, factsText, preferencesText)
    : await runOpportunityLifecycleTransaction(
        async (db) =>
          await compareAndSwapSkillDiscovery(
            db,
            subject,
            prior,
            factsText,
            preferencesText,
          ),
      );
  if (!success)
    throw new CandidateSkillDiscoveryError(
      409,
      'Profile changed concurrently; reload before reviewing skills.',
    );
  return { ...prior, factsJson: factsText, preferencesJson: preferencesText };
}
export async function compareAndSwapSkillDiscovery(
  db: Pick<Awaited<ReturnType<typeof resolveDatabase>>, 'query'>,
  subject: WorkspaceSubject,
  prior: Row,
  factsText: string,
  preferencesText: string,
) {
  const result = await db.query(
    "UPDATE candidate_profiles SET facts_json = ?, preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND active = true AND facts_json = ? AND preferences_json = ? AND COALESCE(title, '') = ? AND COALESCE(summary, '') = ? AND COALESCE(name, '') = ? RETURNING id",
    factsText,
    preferencesText,
    subject.profileId,
    subject.tenantId,
    subject.userId,
    String(prior.factsJson ?? '{}'),
    String(prior.preferencesJson ?? '{}'),
    String(prior.title ?? ''),
    String(prior.summary ?? ''),
    String(prior.name ?? ''),
  );
  return Array.isArray(result.rows) && result.rows.length === 1;
}
export async function loadCandidateSkillDiscovery(
  subject: WorkspaceSubject,
  deps: CandidateSkillDiscoveryDependencies = {},
) {
  return await fresh(subject, deps, async (owned, profile) =>
    snapshot(profile, await catalog(owned, profile, deps)),
  );
}
async function discover(
  subject: WorkspaceSubject,
  deps: CandidateSkillDiscoveryDependencies = {},
) {
  return await fresh(subject, deps, async (owned, profile) => {
    const current = await catalog(owned, profile, deps),
      prior = stored(profile);
    if (
      prior?.revision === current.revision &&
      prior.assessedCount === current.vocabulary.length
    )
      return snapshot(profile, current);
    const proposals =
      prior?.revision === current.revision ? [...prior.proposals] : [];
    const requestIds =
      prior?.revision === current.revision ? [...prior.requestIds] : [];
    const batches =
      prior?.revision === current.revision ? [...prior.batches] : [];
    const evidence =
      prior?.revision === current.revision
        ? prior.evidence
        : current.loaded.evidence;
    let assessedCount =
      prior?.revision === current.revision ? prior.assessedCount : 0;
    const validate = async () => {
      await fresh(owned, deps, async (s, p) => {
        if ((await catalog(s, p, deps)).revision !== current.revision)
          throw new CandidateSkillDiscoveryError(
            409,
            'Career evidence or posting vocabulary changed during discovery.',
          );
      });
    };
    // Exact bounded batches retain every evidence fact. Native quota/spend limits govern every call.
    let calls = 0;
    while (assessedCount < current.vocabulary.length && calls < 1) {
      let count = Math.min(8, current.vocabulary.length - assessedCount);
      let prepared = prepareSkillDiscovery(
        evidence,
        current.vocabulary.slice(assessedCount, assessedCount + count),
        current.revision,
      );
      while (
        count > 0 &&
        !(deps.fits ?? preflightSkillDiscovery)(prepared).fits
      ) {
        count--;
        prepared = prepareSkillDiscovery(
          evidence,
          current.vocabulary.slice(assessedCount, assessedCount + count),
          current.revision,
        );
      }
      if (!count)
        throw new CandidateSkillDiscoveryError(
          409,
          'Complete career evidence does not fit the native decision context; nothing was truncated.',
        );
      const run = await (deps.startRun ?? startOpportunityIntelligenceAgentRun)(
        { opportunityId: '', workspaceSubject: owned },
      );
      try {
        const result = await (deps.evaluate ?? evaluateSkillDiscovery)(
          prepared,
          owned,
          run,
          validate,
        );
        proposals.push(...result.proposals);
        requestIds.push(result.requestId);
        batches.push({ requestId: result.requestId, labels: prepared.labels });
        calls++;
        assessedCount += count;
        await (deps.finishRun ?? finishOpportunityIntelligenceAgentRun)(
          run,
          'succeeded',
          '',
          owned,
        );
      } catch (error) {
        await (deps.finishRun ?? finishOpportunityIntelligenceAgentRun)(
          run,
          'failed',
          error instanceof Error ? error.message : 'Discovery failed.',
          owned,
        );
        throw error;
      }
      // Persist completed governed batches at a fresh fence so a budget interruption can resume safely.
      profile = await fresh(owned, deps, async (s, p) => {
        if ((await catalog(s, p, deps)).revision !== current.revision)
          throw new CandidateSkillDiscoveryError(
            409,
            'Discovery material is no longer current.',
          );
        const now = stored(p);
        if (
          now &&
          now.revision === current.revision &&
          now.assessedCount > assessedCount
        )
          throw new CandidateSkillDiscoveryError(
            409,
            'Another discovery completed concurrently; reload.',
          );
        const preferences = object(p.preferencesJson, 'Profile preferences');
        preferences.skillDiscovery = {
          version: SKILL_DISCOVERY_VERSION,
          revision: current.revision,
          proposals,
          vocabulary: current.vocabulary,
          requestIds,
          assessedCount,
          batches,
          evidence,
        } satisfies StoredDiscovery;
        return await save(s, p, facts(p), preferences, deps);
      });
    }
    return snapshot(profile, current);
  });
}
export async function discoverCandidateSkills(
  subject: WorkspaceSubject,
  deps: CandidateSkillDiscoveryDependencies = {},
) {
  const owned = requireWorkspaceSubject(subject);
  return await (deps.lock ?? withOpportunityLifecycleLock)(
    `skill-discovery:${owned.tenantId}:${owned.userId}:${owned.profileId}`,
    () => discover(owned, deps),
  );
}
async function verified(
  subject: WorkspaceSubject,
  prepared: PreparedSkillDiscovery,
  requestId: string,
): Promise<CandidateSkillProposal[]> {
  const result = await (await database()).query(
    `SELECT r.output_json FROM opportunity_intelligence_results r
    JOIN opportunity_intelligence_requests q ON q.request_id = r.request_id AND q.request_id = r.owner_request_id AND q.idempotency_key = r.idempotency_key
      AND q.agent_run_id = r.agent_run_id AND q.opportunity_id = r.opportunity_id AND q.content_fingerprint = r.content_fingerprint AND q.input_fingerprint = r.input_fingerprint
      AND q.feature = r.feature AND q.profile = r.profile AND q.model = r.model
      AND q.tenant_id = r.tenant_id AND q.owner_user_id = r.owner_user_id AND q.candidate_profile_id = r.candidate_profile_id
    JOIN agent_runs a ON CAST(a.id AS TEXT) = q.agent_run_id AND a.opportunity_id = q.opportunity_id
      AND a.tenant_id = q.tenant_id AND a.owner_user_id = q.owner_user_id AND a.candidate_profile_id = q.candidate_profile_id
    WHERE r.request_id = ? AND r.opportunity_id = '' AND r.content_fingerprint = ? AND r.input_fingerprint = ?
      AND r.feature = ? AND r.profile = ? AND r.model = 'jev-1.13.0'
      AND r.prompt_version = ? AND r.output_schema_version = ? AND r.prepared_payload_version = ?
      AND r.tenant_id = ? AND r.owner_user_id = ? AND r.candidate_profile_id = ?
      AND r.status = 'completed' AND q.status = 'succeeded' AND q.accounting_basis = 'actual' AND q.actual_total_tokens > 0
      AND a.status = 'succeeded' AND a.intelligence_actual_calls > 0 AND a.intelligence_actual_calls <= a.intelligence_call_limit
      AND a.intelligence_actual_spend_micros <= a.intelligence_spend_limit_micros LIMIT 2`,
    requestId,
    prepared.fingerprint,
    discoveryHash({ subject, prepared: prepared.preparedFingerprint }),
    SKILL_DISCOVERY_FEATURE,
    SKILL_DISCOVERY_PROFILE,
    SKILL_DISCOVERY_VERSION,
    SKILL_DISCOVERY_VERSION,
    SKILL_DISCOVERY_VERSION,
    subject.tenantId,
    subject.userId,
    subject.profileId,
  );
  if (result.rows.length !== 1)
    throw new CandidateSkillDiscoveryError(
      409,
      'Current owned native discovery receipt is required.',
    );
  try {
    return resolveSkillDiscovery(
      prepared,
      JSON.parse(String((result.rows[0] as Row).output_json)),
    );
  } catch {
    throw new CandidateSkillDiscoveryError(
      409,
      'Saved native discovery proof is invalid.',
    );
  }
}
async function review(
  subject: WorkspaceSubject,
  input: { id: string; expectedRevision: string },
  action: 'confirmed' | 'dismissed',
  deps: CandidateSkillDiscoveryDependencies,
) {
  if (
    typeof input.id !== 'string' ||
    typeof input.expectedRevision !== 'string'
  )
    throw new CandidateSkillDiscoveryError(
      400,
      'A saved proposal and revision are required.',
    );
  return await fresh(subject, deps, async (owned, profile) => {
    const current = await catalog(owned, profile, deps),
      state = stored(profile);
    if (
      !state ||
      state.revision !== input.expectedRevision ||
      current.revision !== state.revision
    )
      throw new CandidateSkillDiscoveryError(
        409,
        'Discovery is stale; run discovery again before confirming.',
      );
    const proposal = state.proposals.find((row) => row.id === input.id);
    if (!proposal || proposal.revision !== state.revision)
      throw new CandidateSkillDiscoveryError(
        404,
        'Saved skill proposal was not found.',
      );
    if (proposal.status === action) return snapshot(profile, current);
    if (proposal.status !== 'pending')
      throw new CandidateSkillDiscoveryError(
        409,
        'This proposal has already been reviewed.',
      );
    const nextFacts = facts(profile);
    const batch = state.batches.find((row) =>
      row.labels.includes(proposal.label),
    );
    if (action === 'confirmed') {
      if (
        !['direct', 'introductory'].includes(proposal.classification) ||
        !proposal.evidence.length ||
        !state.requestIds.length
      )
        throw new CandidateSkillDiscoveryError(
          409,
          'Only evidence-backed direct or introductory skills can be confirmed.',
        );
      if (!batch)
        throw new CandidateSkillDiscoveryError(
          409,
          'Saved discovery batch is missing.',
        );
      const original = (rows: WorkspaceCandidateEvidence['evidence']) =>
        rows.filter((row) => !row.id.startsWith('confirmed-skill:'));
      if (
        discoveryHash(original(state.evidence)) !==
        discoveryHash(original(current.loaded.evidence))
      )
        throw new CandidateSkillDiscoveryError(
          409,
          'Original discovery evidence changed.',
        );
      const prepared = prepareSkillDiscovery(
        state.evidence,
        batch.labels,
        state.revision,
      );
      const native = (
        await (deps.verify ?? verified)(owned, prepared, batch.requestId)
      ).find((row) => row.id === proposal.id);
      if (
        !native ||
        discoveryHash({ ...native, status: 'pending' }) !==
          discoveryHash({ ...proposal, status: 'pending' })
      )
        throw new CandidateSkillDiscoveryError(
          409,
          'Saved proposal does not match native discovery proof.',
        );
      const canonical = snapshot(profile, current).canonicalSkills.map(
        canonicalSkill,
      );
      if (canonical.includes(proposal.canonicalLabel))
        throw new CandidateSkillDiscoveryError(
          409,
          'This canonical skill is already recorded.',
        );
      const confirmed = nextFacts.facts.confirmedSkills;
      if (
        confirmed !== undefined &&
        (!Array.isArray(confirmed) ||
          parseConfirmedCandidateSkills(profile.factsJson).length !==
            confirmed.length)
      )
        throw new CandidateSkillDiscoveryError(
          409,
          'Confirmed skills are malformed.',
        );
      nextFacts.facts.confirmedSkills = [
        ...((confirmed as unknown[]) ?? []),
        {
          id: proposal.id,
          label: proposal.label,
          classification: proposal.classification,
          provenance: 'user_verified',
          evidence: proposal.evidence,
          discoveryRequestId: batch.requestId,
        },
      ];
    }
    const preferences = object(profile.preferencesJson, 'Profile preferences');
    preferences.skillDiscovery = {
      ...state,
      proposals: state.proposals.map((row) =>
        row.id === proposal.id ? { ...row, status: action } : row,
      ),
    };
    return await fresh(owned, deps, async (s, p) => {
      if (
        (await catalog(s, p, deps)).revision !== state.revision ||
        p.factsJson !== profile.factsJson ||
        p.preferencesJson !== profile.preferencesJson
      )
        throw new CandidateSkillDiscoveryError(
          409,
          'Career evidence or review state changed before confirmation.',
        );
      const updated = await save(s, p, nextFacts, preferences, deps);
      return snapshot(updated, await catalog(s, updated, deps));
    });
  });
}
export async function confirmCandidateSkillProposal(
  subject: WorkspaceSubject,
  input: { id: string; expectedRevision: string },
  deps: CandidateSkillDiscoveryDependencies = {},
) {
  const owned = requireWorkspaceSubject(subject);
  return await (deps.lock ?? withOpportunityLifecycleLock)(
    `skill-discovery:${owned.tenantId}:${owned.userId}:${owned.profileId}`,
    () => review(owned, input, 'confirmed', deps),
  );
}
export async function dismissCandidateSkillProposal(
  subject: WorkspaceSubject,
  input: { id: string; expectedRevision: string },
  deps: CandidateSkillDiscoveryDependencies = {},
) {
  const owned = requireWorkspaceSubject(subject);
  return await (deps.lock ?? withOpportunityLifecycleLock)(
    `skill-discovery:${owned.tenantId}:${owned.userId}:${owned.profileId}`,
    () => review(owned, input, 'dismissed', deps),
  );
}
