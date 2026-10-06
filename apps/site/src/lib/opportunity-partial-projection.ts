import type { OpportunityPartialAssessmentProjection } from '$lib/server/opportunity-assessment-partial-projection';

export function getCurrentPartialOpportunityAssessmentProjection(
  projection: unknown,
): OpportunityPartialAssessmentProjection | null {
  if (
    !projection ||
    typeof projection !== 'object' ||
    Array.isArray(projection)
  )
    return null;
  const value = projection as OpportunityPartialAssessmentProjection;
  return value.version === 'opportunity-assessment-partial-projection/v1' &&
    value.mode === 'partial' &&
    value.sourceStatus === 'current' &&
    Number.isSafeInteger(value.criterionCount) &&
    value.criterionCount > 0 &&
    Number.isSafeInteger(value.supportedCriterionCount) &&
    value.supportedCriterionCount >= 0 &&
    value.supportedCriterionCount <= value.criterionCount &&
    Number.isSafeInteger(value.unresolvedSourceClauseCount) &&
    value.unresolvedSourceClauseCount >= 0 &&
    Array.isArray(value.requirements) &&
    value.requirements.length === value.criterionCount &&
    value.requirements.every((row) => row && typeof row === 'object') &&
    value.requirements.filter((row) => row.support === 'supported').length ===
      value.supportedCriterionCount &&
    value.requirements.every(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.text === 'string' &&
        ['supported', 'uncertain'].includes(row.support) &&
        Array.isArray(row.postingCitations) &&
        Array.isArray(row.candidateCitations) &&
        row.postingCitations.every(
          (citation) =>
            citation &&
            typeof citation === 'object' &&
            typeof citation.excerpt === 'string' &&
            typeof citation.clauseId === 'string' &&
            Number.isSafeInteger(citation.start) &&
            Number.isSafeInteger(citation.end) &&
            citation.start >= 0 &&
            citation.end > citation.start,
        ) &&
        row.candidateCitations.every(
          (citation) =>
            citation &&
            typeof citation === 'object' &&
            typeof citation.sourceId === 'string' &&
            typeof citation.title === 'string' &&
            typeof citation.excerpt === 'string',
        ),
    )
    ? value
    : null;
}
