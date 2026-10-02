/** A presentation-safe assessment summary; never reads candidate or provider data. */
export const ASSESSMENT_ELIGIBILITY_BUCKETS = [
  'eligible',
  'sponsorship_possible',
  'location_restriction',
  'unknown',
  'conflicting',
] as const;
export type AssessmentEligibilityBucket =
  (typeof ASSESSMENT_ELIGIBILITY_BUCKETS)[number];

export const assessmentEligibilityLabels: Record<
  AssessmentEligibilityBucket,
  string
> = {
  eligible: 'Eligible for your work location',
  sponsorship_possible: 'Sponsorship possible',
  location_restriction: 'Location or authorization restriction',
  unknown: 'Unknown',
  conflicting: 'Conflicting',
};

export type OpportunityAssessmentProjection = {
  buckets: AssessmentEligibilityBucket[];
  sourceStatus: 'current' | 'unknown';
  matchReadiness:
    | 'assessable'
    | 'needs_extraction'
    | 'needs_evidence'
    | 'unknown';
  coverage: {
    candidateTruncated: boolean;
    postingTruncated: boolean;
    requirementsTruncated: boolean;
    requirementCount: number;
  } | null;
  fitScore: number;
  eligibilityPriority: number;
  reason: string;
};

const priority: Record<AssessmentEligibilityBucket, number> = {
  eligible: 0,
  sponsorship_possible: 1,
  unknown: 2,
  conflicting: 3,
  location_restriction: 4,
};

export function getOpportunityAssessmentProjection(
  assessment?: unknown,
): OpportunityAssessmentProjection {
  const unknown: OpportunityAssessmentProjection = {
    buckets: ['unknown'],
    sourceStatus: 'unknown',
    matchReadiness: 'unknown',
    coverage: null,
    eligibilityPriority: priority.unknown,
    fitScore: 0,
    reason: 'No current assessment is available.',
  };
  if (
    !assessment ||
    typeof assessment !== 'object' ||
    Array.isArray(assessment)
  )
    return unknown;
  const value = assessment as Record<string, unknown>;
  if (value.sourceStatus !== 'current') return unknown;
  const rawBucket = value.eligibilityBucket;
  if (
    !ASSESSMENT_ELIGIBILITY_BUCKETS.includes(
      rawBucket as AssessmentEligibilityBucket,
    )
  )
    return unknown;
  const bucket = rawBucket as AssessmentEligibilityBucket;
  const ranking = value.ranking;
  const rank =
    ranking && typeof ranking === 'object' && !Array.isArray(ranking)
      ? (ranking as Record<string, unknown>)
      : {};
  if (
    typeof rank.fitScore !== 'number' ||
    !Number.isFinite(rank.fitScore) ||
    typeof rank.eligibilityPriority !== 'number' ||
    !Number.isFinite(rank.eligibilityPriority)
  )
    return unknown;
  const coverage = safeAssessmentCoverage(value.coverage);
  const verifiedMatchReadiness = consistentAssessmentReadiness(
    value.matchReadiness,
    coverage,
  );
  return {
    buckets: [bucket],
    sourceStatus: 'current',
    matchReadiness:
      coverage &&
      (value.matchReadiness === 'assessable' ||
        value.matchReadiness === 'needs_extraction' ||
        value.matchReadiness === 'needs_evidence')
        ? verifiedMatchReadiness
        : 'unknown',
    coverage,
    eligibilityPriority: rank.eligibilityPriority,
    fitScore: rank.fitScore,
    reason: typeof value.reason === 'string' ? value.reason : '',
  };
}

function consistentAssessmentReadiness(
  value: unknown,
  coverage: OpportunityAssessmentProjection['coverage'],
): OpportunityAssessmentProjection['matchReadiness'] {
  if (!coverage) return 'unknown';
  if (value === 'needs_extraction' || value === 'needs_evidence') return value;
  if (
    coverage.requirementCount === 0 ||
    coverage.candidateTruncated ||
    coverage.postingTruncated ||
    coverage.requirementsTruncated
  ) {
    return 'unknown';
  }
  return value === 'assessable' ? value : 'unknown';
}

function safeAssessmentCoverage(
  value: unknown,
): OpportunityAssessmentProjection['coverage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const coverage = value as Record<string, unknown>;
  if (
    typeof coverage.candidateTruncated !== 'boolean' ||
    typeof coverage.postingTruncated !== 'boolean' ||
    typeof coverage.requirementsTruncated !== 'boolean' ||
    typeof coverage.requirementCount !== 'number' ||
    !Number.isInteger(coverage.requirementCount) ||
    coverage.requirementCount < 0
  )
    return null;
  return {
    candidateTruncated: coverage.candidateTruncated,
    postingTruncated: coverage.postingTruncated,
    requirementsTruncated: coverage.requirementsTruncated,
    requirementCount: coverage.requirementCount,
  };
}

export function assessmentMatchReadinessLabel(
  projection: OpportunityAssessmentProjection,
): string {
  switch (projection.matchReadiness) {
    case 'assessable':
      return 'Match assessment ready';
    case 'needs_extraction':
      return 'Needs extraction';
    case 'needs_evidence':
      return 'Needs evidence';
    default:
      return 'Match assessment unavailable';
  }
}

export function assessmentCoverageMessages(
  projection: OpportunityAssessmentProjection,
): string[] {
  const coverage = projection.coverage;
  if (!coverage) return [];
  return [
    ...(coverage.requirementCount === 0
      ? ['No structured role requirements were extracted.']
      : []),
    ...(coverage.postingTruncated ? ['Posting material was truncated.'] : []),
    ...(coverage.candidateTruncated
      ? ['Candidate evidence was truncated.']
      : []),
    ...(coverage.requirementsTruncated
      ? ['Role requirements may be incomplete.']
      : []),
  ];
}

export function matchesAssessmentEligibility(
  assessment: unknown,
  selected: readonly AssessmentEligibilityBucket[],
): boolean {
  return (
    selected.length === 0 ||
    selected.some((bucket) =>
      getOpportunityAssessmentProjection(assessment).buckets.includes(bucket),
    )
  );
}

export function compareAssessmentEligibility(
  left: unknown,
  right: unknown,
): number {
  const a = getOpportunityAssessmentProjection(left);
  const b = getOpportunityAssessmentProjection(right);
  return (
    a.eligibilityPriority - b.eligibilityPriority ||
    (a.matchReadiness === 'assessable' && b.matchReadiness === 'assessable'
      ? b.fitScore - a.fitScore
      : 0)
  );
}
