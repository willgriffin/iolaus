import { createHash } from 'node:crypto';
import { candidateWorkEligibilityFromProfile } from './candidate-work-eligibility.js';
import {
  type CandidateWorkEligibility,
  OPPORTUNITY_ASSESSMENT_RANKING_VERSION,
  OPPORTUNITY_ASSESSMENT_VERSION,
  type OpportunityAssessmentPreference,
  type OpportunityAssessmentResult,
  opportunityAssessmentMatchReadiness,
  rankOpportunityAssessment,
} from './opportunity-assessment.js';
import {
  createPrivateRecord,
  listPrivateRecords,
  type WorkspaceSubject,
} from './private-workspace.js';
import { loadWorkspaceCandidateEvidence } from './resume-data.js';

export interface OpportunityAssessmentProjection {
  coverage: {
    candidateTruncated: boolean;
    postingTruncated: boolean;
    requirementCount: number;
    requirementsTruncated: boolean;
  };
  conflicting: boolean;
  eligibilityBucket:
    | 'eligible'
    | 'sponsorship_possible'
    | 'location_restriction'
    | 'unknown'
    | 'conflicting';
  personalEligibility:
    | 'eligible_without_sponsorship'
    | 'sponsorship_possible'
    | 'incompatible'
    | 'unknown';
  matchReadiness: 'assessable' | 'needs_evidence' | 'needs_extraction';
  ranking: {
    eligibilityPriority: number;
    excluded: boolean;
    fitScore: number;
  };
  reason: string;
  sourceStatus: 'current';
}

function assessmentEligibilityBucket(
  assessment: OpportunityAssessmentResult,
  candidate: CandidateWorkEligibility,
): OpportunityAssessmentProjection['eligibilityBucket'] {
  if (assessment.claims.some((claim) => claim.value === 'conflicting')) {
    return 'conflicting';
  }
  switch (rankOpportunityAssessment(assessment, candidate, []).eligibility) {
    case 'eligible_without_sponsorship':
      return 'eligible';
    case 'sponsorship_possible':
      return 'sponsorship_possible';
    case 'incompatible':
      // This verdict is reached only through location, work authorization, or
      // sponsorship claims. It is deliberately a user-profile comparison,
      // not an immigration-law conclusion.
      return 'location_restriction';
    default:
      return 'unknown';
  }
}

function assessmentMatchReadiness(
  assessment: OpportunityAssessmentResult,
): OpportunityAssessmentProjection['matchReadiness'] {
  return opportunityAssessmentMatchReadiness({
    coverage: assessment.coverage,
    requirementCount: assessment.requirements.length,
  });
}

/**
 * A projection is current only when it is derived from the same posting and
 * the same complete private candidate evidence snapshot. Keeping this pure
 * makes profile/evidence invalidation testable without opening a collection.
 */
export function isCurrentOpportunityAssessmentRecord(
  row: Record<string, unknown>,
  expected: {
    candidateMaterialFingerprint: string;
    sourceContentFingerprint: string;
    sourceContentVersion: number;
  },
): boolean {
  return (
    row.candidateMaterialFingerprint ===
      expected.candidateMaterialFingerprint &&
    row.sourceContentFingerprint === expected.sourceContentFingerprint &&
    Number(row.sourceContentVersion) === expected.sourceContentVersion
  );
}

function storedOpportunityAssessment(
  row: Record<string, unknown>,
): OpportunityAssessmentResult | null {
  try {
    const parsed = JSON.parse(
      typeof row.assessmentJson === 'string' ? row.assessmentJson : '{}',
    ) as Record<string, unknown>;
    if (
      parsed.contractVersion !== OPPORTUNITY_ASSESSMENT_VERSION ||
      !Array.isArray(parsed.claims) ||
      !parsed.postingMaterial ||
      typeof parsed.postingMaterial !== 'object'
    ) {
      return null;
    }
    return parsed as unknown as OpportunityAssessmentResult;
  } catch {
    return null;
  }
}

/** Removes source passages, candidate facts, and model provenance from UI data. */
export function projectOpportunityAssessment(
  assessment: OpportunityAssessmentResult,
  candidate: CandidateWorkEligibility,
  preferences: OpportunityAssessmentPreference[],
): OpportunityAssessmentProjection {
  const ranking = rankOpportunityAssessment(assessment, candidate, preferences);
  const conflicting = assessment.claims.some(
    (claim) => claim.value === 'conflicting',
  );
  const matchReadiness = assessmentMatchReadiness(assessment);
  const scopedUncertain = assessment.requirements.filter(
    (requirement) =>
      requirement.support === 'uncertain' &&
      assessment.citationScopes?.some(
        (scope) => scope.requirementId === requirement.id && !scope.complete,
      ),
  ).length;
  return {
    coverage: {
      candidateTruncated: assessment.coverage.candidateTruncated,
      postingTruncated: assessment.coverage.postingTruncated,
      requirementCount: assessment.requirements.length,
      requirementsTruncated: assessment.coverage.requirementsTruncated,
    },
    conflicting,
    eligibilityBucket: assessmentEligibilityBucket(assessment, candidate),
    personalEligibility: ranking.eligibility,
    matchReadiness,
    ranking: {
      eligibilityPriority: ranking.eligibilityPriority,
      excluded: ranking.excluded,
      fitScore: ranking.fitScore,
    },
    reason:
      matchReadiness === 'needs_extraction'
        ? 'Needs structured role requirements before matching.'
        : matchReadiness === 'needs_evidence'
          ? 'Needs fuller posting or candidate evidence before matching.'
          : `${ranking.reasons[0] ?? 'Assessment needs clarification'}${scopedUncertain ? `; ${scopedUncertain} role requirements need clarification.` : ''}`,
    sourceStatus: 'current',
  };
}

/** A deterministic local-ranking revision; it never affects a model cache. */
export function opportunityAssessmentPreferencesFingerprint(
  preferences: OpportunityAssessmentPreference[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        rankingVersion: OPPORTUNITY_ASSESSMENT_RANKING_VERSION,
        preferences: preferences
          .map((preference) => ({
            active: preference.active !== false,
            category: preference.category,
            isHardFilter: preference.isHardFilter === true,
            name: preference.name ?? '',
            ruleJson: preference.ruleJson ?? '{}',
            weight: preference.weight,
          }))
          .sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
      }),
    )
    .digest('hex');
}

/**
 * The only query-time cache inputs for subject-scoped assessment rows. This
 * performs bounded private reads and never requests a model decision.
 */
export async function loadOpportunityAssessmentQueryContext(
  subject: WorkspaceSubject,
): Promise<{
  assessmentCandidateMaterialFingerprint: string;
  assessmentPreferencesFingerprint: string;
}> {
  const [evidence, preferences] = await Promise.all([
    loadWorkspaceCandidateEvidence(subject),
    loadOpportunityAssessmentPreferences(subject),
  ]);
  return {
    assessmentCandidateMaterialFingerprint: evidence.fingerprint,
    assessmentPreferencesFingerprint:
      opportunityAssessmentPreferencesFingerprint(preferences),
  };
}

/**
 * Stores a private immutable assessment material version. A caller must
 * re-check source/profile freshness immediately before calling this function;
 * this service rejects duplicates for the same private subject and material.
 */
export async function storeOpportunityAssessment(input: {
  agentRunId: string;
  assessment: OpportunityAssessmentResult;
  candidate: CandidateWorkEligibility;
  opportunityId: string;
  preferences: OpportunityAssessmentPreference[];
  subject: WorkspaceSubject;
}): Promise<{ created: boolean; projection: OpportunityAssessmentProjection }> {
  const projection = projectOpportunityAssessment(
    input.assessment,
    input.candidate,
    input.preferences,
  );
  const existing = await listPrivateRecords(
    'OpportunityAssessment',
    input.subject,
    {
      limit: 2,
      orderBy: 'created_at DESC',
      where: {
        assessmentFingerprint: input.assessment.fingerprint,
        opportunityId: input.opportunityId,
      },
    },
  );
  if (existing.length) return { created: false, projection };
  const payload = {
    agentRunId: input.agentRunId,
    assessmentFingerprint: input.assessment.fingerprint,
    assessmentJson: JSON.stringify(input.assessment),
    candidateMaterialFingerprint: input.assessment.candidateMaterialFingerprint,
    contractVersion: input.assessment.contractVersion,
    eligibilityBucket: projection.eligibilityBucket,
    eligibilityPriority: projection.ranking.eligibilityPriority,
    excluded: projection.ranking.excluded,
    fitScore: projection.ranking.fitScore,
    matchReadiness: projection.matchReadiness,
    model: input.assessment.provenance?.model ?? '',
    opportunityId: input.opportunityId,
    projectionJson: JSON.stringify(projection),
    provider: input.assessment.provenance?.provider ?? '',
    preferencesFingerprint: opportunityAssessmentPreferencesFingerprint(
      input.preferences,
    ),
    sourceContentFingerprint:
      input.assessment.postingMaterial.sourceContentFingerprint,
    sourceContentVersion: input.assessment.postingMaterial.sourceContentVersion,
    status: 'current',
  };
  try {
    await createPrivateRecord('OpportunityAssessment', input.subject, payload);
    return { created: true, projection };
  } catch (cause) {
    // The model's conflict key is the ownership tuple plus this immutable
    // assessment fingerprint. A concurrent identical worker is idempotent;
    // every other write failure remains visible to the caller.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/unique|duplicate|conflict/i.test(message)) throw cause;
    const concurrent = await listPrivateRecords(
      'OpportunityAssessment',
      input.subject,
      {
        limit: 1,
        where: {
          assessmentFingerprint: input.assessment.fingerprint,
          opportunityId: input.opportunityId,
        },
      },
    );
    if (!concurrent.length) throw cause;
    return { created: false, projection };
  }
}

/**
 * Rebuild materialized ranking fields after a private preference mutation.
 * It is bounded, fully subject-scoped, and uses persisted assessment facts;
 * no JEV request is made. SQL list/triage queries can require the resulting
 * preferences fingerprint before they filter, rank, and paginate.
 */
export async function refreshOpportunityAssessmentProjections(input: {
  limit?: number;
  subject: WorkspaceSubject;
}): Promise<{ refreshed: number; skipped: number }> {
  const [evidence, preferences] = await Promise.all([
    loadWorkspaceCandidateEvidence(input.subject),
    loadOpportunityAssessmentPreferences(input.subject),
  ]);
  const candidate = candidateWorkEligibilityFromProfile(evidence.candidate);
  const preferencesFingerprint =
    opportunityAssessmentPreferencesFingerprint(preferences);
  const rows = await listPrivateRecords(
    'OpportunityAssessment',
    input.subject,
    {
      limit: Math.min(Math.max(1, input.limit ?? 250), 500),
      orderBy: 'updated_at DESC',
      where: { status: 'current' },
    },
  );
  let refreshed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.candidateMaterialFingerprint !== evidence.fingerprint) {
      skipped += 1;
      continue;
    }
    const assessment = storedOpportunityAssessment(row);
    if (!assessment) {
      skipped += 1;
      continue;
    }
    const projection = projectOpportunityAssessment(
      assessment,
      candidate,
      preferences,
    );
    const nextJson = JSON.stringify(projection);
    if (
      row.preferencesFingerprint === preferencesFingerprint &&
      row.projectionJson === nextJson &&
      row.eligibilityBucket === projection.eligibilityBucket &&
      Number(row.eligibilityPriority) ===
        projection.ranking.eligibilityPriority &&
      Number(row.fitScore) === projection.ranking.fitScore &&
      row.matchReadiness === projection.matchReadiness &&
      row.excluded === projection.ranking.excluded
    ) {
      continue;
    }
    const mutable = row as Record<string, unknown> & {
      save?: () => Promise<void>;
    };
    if (!mutable.save) {
      skipped += 1;
      continue;
    }
    mutable.eligibilityBucket = projection.eligibilityBucket;
    mutable.eligibilityPriority = projection.ranking.eligibilityPriority;
    mutable.excluded = projection.ranking.excluded;
    mutable.fitScore = projection.ranking.fitScore;
    mutable.matchReadiness = projection.matchReadiness;
    mutable.preferencesFingerprint = preferencesFingerprint;
    mutable.projectionJson = nextJson;
    await mutable.save();
    refreshed += 1;
  }
  return { refreshed, skipped };
}

/** Preference changes rerank stored assessment facts locally and never invoke JEV. */
export async function loadOpportunityAssessmentPreferences(
  subject: WorkspaceSubject,
): Promise<OpportunityAssessmentPreference[]> {
  const records = await listPrivateRecords('PreferenceRule', subject, {
    limit: 200,
    orderBy: 'updated_at DESC',
  });
  return records.map((record) => ({
    active: record.active !== false,
    category: typeof record.category === 'string' ? record.category : 'scoring',
    isHardFilter: record.isHardFilter === true,
    name: typeof record.name === 'string' ? record.name : '',
    ruleJson: typeof record.ruleJson === 'string' ? record.ruleJson : '{}',
    weight:
      typeof record.weight === 'number'
        ? record.weight
        : Number(record.weight) || 0,
  }));
}

/** A scoped idempotence lookup; callers must still fence current posting input. */
export async function hasOpportunityAssessment(input: {
  assessmentFingerprint: string;
  opportunityId: string;
  subject: WorkspaceSubject;
}): Promise<boolean> {
  return (
    (
      await listPrivateRecords('OpportunityAssessment', input.subject, {
        limit: 1,
        where: {
          assessmentFingerprint: input.assessmentFingerprint,
          opportunityId: input.opportunityId,
        },
      })
    ).length > 0
  );
}

/**
 * Loads only source-current, UI-safe projections for one verified workspace.
 * Raw assessment JSON and candidate evidence never leave this server helper.
 */
export async function loadCurrentOpportunityAssessmentProjections(input: {
  opportunities: Array<{
    id: unknown;
    sourceContentFingerprint: unknown;
    sourceContentVersion: unknown;
  }>;
  subject: WorkspaceSubject;
}): Promise<Map<string, unknown>> {
  const expected = new Map(
    input.opportunities
      .map((opportunity) => {
        const id = typeof opportunity.id === 'string' ? opportunity.id : '';
        const fingerprint =
          typeof opportunity.sourceContentFingerprint === 'string'
            ? opportunity.sourceContentFingerprint
            : '';
        const version = Number(opportunity.sourceContentVersion) || 0;
        return id ? [id, { fingerprint, version }] : null;
      })
      .filter(
        (entry): entry is [string, { fingerprint: string; version: number }] =>
          Boolean(entry),
      ),
  );
  if (!expected.size) return new Map();
  // A posting-current result is still stale when any private candidate fact or
  // evidence changes. Load this once for the entire requested page and rerank
  // with current local preferences; neither operation invokes a provider.
  const [evidence, preferences] = await Promise.all([
    loadWorkspaceCandidateEvidence(input.subject),
    loadOpportunityAssessmentPreferences(input.subject),
  ]);
  const candidate = candidateWorkEligibilityFromProfile(evidence.candidate);
  const rows = await listPrivateRecords(
    'OpportunityAssessment',
    input.subject,
    {
      orderBy: 'updated_at DESC',
      where: { 'opportunityId in': [...expected.keys()], status: 'current' },
    },
  );
  const projections = new Map<string, unknown>();
  for (const row of rows) {
    const opportunityId =
      typeof row.opportunityId === 'string' ? row.opportunityId : '';
    const current = expected.get(opportunityId);
    if (
      !current ||
      projections.has(opportunityId) ||
      !isCurrentOpportunityAssessmentRecord(row, {
        candidateMaterialFingerprint: evidence.fingerprint,
        sourceContentFingerprint: current.fingerprint,
        sourceContentVersion: current.version,
      })
    )
      continue;
    const assessment = storedOpportunityAssessment(row);
    if (!assessment) continue;
    projections.set(
      opportunityId,
      projectOpportunityAssessment(assessment, candidate, preferences),
    );
  }
  return projections;
}
