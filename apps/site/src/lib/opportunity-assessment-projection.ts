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
  return {
    buckets: [bucket],
    eligibilityPriority: rank.eligibilityPriority,
    fitScore: rank.fitScore,
    reason: typeof value.reason === 'string' ? value.reason : '',
  };
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
    a.eligibilityPriority - b.eligibilityPriority || b.fitScore - a.fitScore
  );
}
