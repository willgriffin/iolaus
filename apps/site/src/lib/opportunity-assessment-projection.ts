/** A presentation-safe assessment summary; never reads candidate or provider data. */
export const ASSESSMENT_ELIGIBILITY_BUCKETS = [
  'eligible_without_sponsorship',
  'sponsorship_possible',
  'incompatible',
  'unknown',
  'conflicting',
] as const;
export type AssessmentEligibilityBucket =
  (typeof ASSESSMENT_ELIGIBILITY_BUCKETS)[number];

export type OpportunityAssessmentProjection = {
  buckets: AssessmentEligibilityBucket[];
  fitScore: number;
  eligibilityPriority: number;
  reason: string;
};

const priority: Record<AssessmentEligibilityBucket, number> = {
  eligible_without_sponsorship: 0,
  sponsorship_possible: 1,
  unknown: 2,
  conflicting: 3,
  incompatible: 4,
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
  const personal = value.personalEligibility;
  if (
    ![
      'eligible_without_sponsorship',
      'sponsorship_possible',
      'incompatible',
      'unknown',
    ].includes(String(personal))
  )
    return unknown;
  const bucket = personal as Exclude<
    AssessmentEligibilityBucket,
    'conflicting'
  >;
  const conflicting = value.conflicting === true;
  const ranking = value.ranking;
  const rank =
    ranking && typeof ranking === 'object' && !Array.isArray(ranking)
      ? (ranking as Record<string, unknown>)
      : {};
  const fitScore =
    typeof rank.fitScore === 'number' && Number.isFinite(rank.fitScore)
      ? rank.fitScore
      : 0;
  return {
    buckets: conflicting ? ['conflicting'] : [bucket],
    eligibilityPriority:
      typeof rank.eligibilityPriority === 'number' &&
      Number.isFinite(rank.eligibilityPriority)
        ? rank.eligibilityPriority
        : priority[conflicting ? 'conflicting' : bucket],
    fitScore,
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
