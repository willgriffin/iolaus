import { getCurrentPartialOpportunityAssessmentProjection } from './opportunity-partial-projection';
import type { OpportunityReviewEvidenceFit } from './server/opportunity-assessment-completeness';
import type { OpportunityResumeFitReviewProjection } from './server/opportunity-resume-fit-review-projection';

/** Equal criterion weights; unestablished supplied evidence remains zero, never absent ability. */
export function advisoryRelevanceMean(
  pairs: { probability: number }[],
  denominator: number,
): number | null {
  if (
    !Number.isSafeInteger(denominator) ||
    denominator < 0 ||
    pairs.length !== denominator ||
    pairs.some(
      (pair) =>
        !Number.isFinite(pair.probability) ||
        pair.probability < 0 ||
        pair.probability > 1,
    )
  )
    return null;
  return denominator
    ? pairs.reduce((sum, pair) => sum + pair.probability, 0) / denominator
    : null;
}

export function evidenceFitLabel(fit: OpportunityReviewEvidenceFit): string {
  switch (fit.status) {
    case 'supports_all_reviewed_criteria':
      return 'All reviewed criteria supported';
    case 'supported_with_uncertainties':
      return 'Supported with uncertainties';
    case 'needs_evidence':
      return 'Needs evidence';
    case 'no_applicant_criteria':
      return 'No applicant criteria established';
  }
}
/** Consistency validation only. Actual receipt replay establishes the authority. */
function consistentEvidenceFit(
  value: unknown,
  rows: Record<string, unknown>[],
): value is OpportunityReviewEvidenceFit {
  if (!object(value) || value.kind !== 'evidence_summary') return false;
  let supported = 0,
    uncertain = 0,
    sourceUnknown = 0,
    context = 0,
    classificationUnknown = 0;
  for (const row of rows) {
    if (row.sourceClassification === 'possible_requirement_unknown')
      classificationUnknown++;
    if (row.sourceDisposition === 'unknown') sourceUnknown++;
    else if (row.sourceDisposition === 'context') context++;
    else if (row.status === 'strength') supported++;
    else uncertain++;
  }
  const considered = supported + uncertain + sourceUnknown;
  const status = !considered
    ? 'no_applicant_criteria'
    : !supported
      ? 'needs_evidence'
      : !uncertain && !sourceUnknown && !classificationUnknown
        ? 'supports_all_reviewed_criteria'
        : 'supported_with_uncertainties';
  return (
    value.supportedCriterionCount === supported &&
    value.uncertainCriterionCount === uncertain &&
    value.sourceUnknownCriterionCount === sourceUnknown &&
    value.contextUnitCount === context &&
    value.sourceClassificationUnknownCount === classificationUnknown &&
    value.consideredCriterionCount === considered &&
    value.status === status &&
    value.supportLowerBound === (considered ? supported / considered : null)
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(text) &&
    new Set(value).size === value.length
  );
}
function citation(value: unknown): value is Record<string, unknown> {
  return (
    object(value) &&
    text(value.quote) &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    Number(value.start) >= 0 &&
    Number(value.end) > Number(value.start) &&
    value.quote.length === Number(value.end) - Number(value.start)
  );
}
/** Presentation validation only; the server's actual private receipt reader establishes authority. */
export function getCurrentOpportunityResumeFitReviewProjection(
  value: unknown,
): OpportunityResumeFitReviewProjection | null {
  if (
    !object(value) ||
    value.version !== 'opportunity-resume-fit-review-projection/v1' ||
    !['advisory', 'complete_material'].includes(String(value.mode)) ||
    value.sourceStatus !== 'current' ||
    !['openai/gpt-6.1-sol', 'openai/gpt-6-luna'].includes(
      String(value.model),
    ) ||
    !object(value.coverage) ||
    (value.mode === 'advisory' && value.coverage.fullFit !== 'unknown') ||
    !Number.isInteger(value.coverage.candidateSourceCount) ||
    Number(value.coverage.candidateSourceCount) < 1 ||
    typeof value.coverage.sourceComplete !== 'boolean' ||
    !ids(value.coverage.reviewedRequirementIds) ||
    !ids(value.coverage.unresolvedClauseIds) ||
    (value.mode === 'advisory' &&
      value.coverage.sourceComplete &&
      value.coverage.unresolvedClauseIds.length > 0) ||
    !Array.isArray(value.requirements) ||
    value.requirements.length === 0
  )
    return null;
  const requirementIds: string[] = [];
  for (const row of value.requirements) {
    if (
      !object(row) ||
      !text(row.id) ||
      !text(row.text) ||
      typeof row.note !== 'string' ||
      !['strength', 'uncertain'].includes(String(row.status)) ||
      !['supported', 'uncertain', 'not_applicable'].includes(
        String(row.seniority),
      ) ||
      !Array.isArray(row.candidateCitations) ||
      !Array.isArray(row.postingCitations) ||
      !row.candidateCitations.every(
        (item) =>
          citation(item) &&
          text(item.sourceId) &&
          text(item.title) &&
          text(item.kind),
      ) ||
      !row.postingCitations.every(
        (item) => citation(item) && text(item.clauseId),
      ) ||
      (row.status === 'strength' &&
        (!row.candidateCitations.length || !row.postingCitations.length))
    )
      return null;
    if (
      row.originalSolSuggestion !== undefined &&
      (value.model !== 'openai/gpt-6.1-sol' ||
        !object(value.verification) ||
        !object(row.originalSolSuggestion) ||
        !['strength', 'uncertain'].includes(
          String(row.originalSolSuggestion.status),
        ) ||
        !['supported', 'uncertain', 'not_applicable'].includes(
          String(row.originalSolSuggestion.seniority),
        ) ||
        typeof row.originalSolSuggestion.note !== 'string')
    )
      return null;
    requirementIds.push(row.id);
  }
  const reviewedIds = value.coverage.reviewedRequirementIds;
  if (
    new Set(requirementIds).size !== requirementIds.length ||
    requirementIds.length !== reviewedIds.length ||
    requirementIds.some((id) => !reviewedIds.includes(id))
  )
    return null;
  if (value.verification !== undefined) {
    const verification = value.verification;
    const countKeys = [
      'strengthClaimCount',
      'verifiedStrengthCount',
      'seniorityClaimCount',
      'verifiedSeniorityCount',
    ];
    if (
      value.mode !== 'complete_material' ||
      value.model !== 'openai/gpt-6.1-sol' ||
      !object(verification) ||
      verification.sourceStatus !== 'current' ||
      ![
        'opportunity-review-strength-verification/v1-independent-jev',
        'opportunity-review-strength-verification/v2-partial-relevance',
      ].includes(String(verification.version)) ||
      verification.model !== 'jev-1.13.0' ||
      !countKeys.every(
        (key) =>
          Number.isSafeInteger(verification[key]) &&
          Number(verification[key]) >= 0,
      ) ||
      Number(verification.strengthClaimCount) +
        Number(verification.seniorityClaimCount) +
        (verification.version ===
        'opportunity-review-strength-verification/v2-partial-relevance'
          ? Number(verification.partialClaimCount)
          : 0) <
        1 ||
      Number(verification.strengthClaimCount) >
        value.requirements.filter(
          (row) => row.sourceDisposition === 'criterion',
        ).length ||
      Number(verification.seniorityClaimCount) >
        value.requirements.filter(
          (row) => row.sourceDisposition === 'criterion',
        ).length ||
      Number(verification.verifiedStrengthCount) >
        Number(verification.strengthClaimCount) ||
      Number(verification.verifiedSeniorityCount) >
        Number(verification.seniorityClaimCount) ||
      verification.verifiedStrengthCount !==
        value.requirements.filter((row) => row.status === 'strength').length ||
      verification.verifiedSeniorityCount !==
        value.requirements.filter((row) => row.seniority === 'supported').length
    )
      return null;
    if (
      verification.version ===
      'opportunity-review-strength-verification/v2-partial-relevance'
    ) {
      const partialIds = verification.partialSupportedRequirementIds;
      const criterionRows = value.requirements.filter(
        (row) => row.sourceDisposition === 'criterion',
      );
      if (
        !Number.isSafeInteger(verification.partialClaimCount) ||
        Number(verification.partialClaimCount) < 0 ||
        !Number.isSafeInteger(verification.verifiedPartialCount) ||
        Number(verification.verifiedPartialCount) < 0 ||
        Number(verification.partialClaimCount) > criterionRows.length ||
        Number(verification.verifiedPartialCount) >
          Number(verification.partialClaimCount) ||
        !ids(partialIds) ||
        partialIds.length !== verification.verifiedPartialCount ||
        partialIds.some(
          (id) =>
            !criterionRows.some(
              (row) =>
                row.id === id &&
                row.status === 'uncertain' &&
                row.candidateCitations.length > 0 &&
                row.postingCitations.length > 0,
            ),
        )
      )
        return null;
    } else if (
      verification.partialClaimCount !== undefined ||
      verification.verifiedPartialCount !== undefined ||
      verification.partialSupportedRequirementIds !== undefined
    )
      return null;
  }
  if (
    value.mode === 'complete_material' &&
    value.model === 'openai/gpt-6.1-sol' &&
    !value.verification
  )
    return null;
  if (value.mode === 'complete_material') {
    if (
      !consistentEvidenceFit(value.evidenceFit, value.requirements) ||
      !consistentEvidenceFit(value.coverage.fullFit, value.requirements)
    )
      return null;
    const completion = value.completion;
    const clauses = value.coverage.sourceClauseConsideration;
    const metadata = value.coverage.metadataConsideration;
    const materialIds = value.coverage.reviewedMaterialClauseIds;
    if (
      value.resultContractVersion !==
        'opportunity-resume-fit-review/v4-complete-material' ||
      !object(completion) ||
      completion.status !== 'reviewed_with_unknowns' ||
      completion.consideredComplete !== true ||
      !ids(completion.unprocessedClauseIds) ||
      completion.unprocessedClauseIds.length ||
      !Number.isSafeInteger(completion.catalogClauseCount) ||
      !Number.isSafeInteger(completion.reviewedMaterialClauseCount) ||
      !Number.isSafeInteger(completion.possibleRequirementCount) ||
      !ids(materialIds) ||
      !Array.isArray(clauses) ||
      !clauses.length ||
      !Array.isArray(metadata) ||
      value.coverage.consideredComplete !== true ||
      value.coverage.sourceComplete !== true ||
      !['confirmed', 'uncertain'].includes(
        String(value.coverage.requirementsCertainty),
      )
    )
      return null;
    const material = clauses.filter(
      (row) => object(row) && row.status !== 'certified_nonrequirement',
    );
    if (
      !metadata.every(
        (row) =>
          object(row) &&
          text(row.fieldId) &&
          row.fieldId.startsWith('source-field:') &&
          text(row.path) &&
          /^sourceContentJson\.[A-Za-z][A-Za-z0-9]*$/.test(row.path) &&
          text(row.hash) &&
          ids(row.bodyClauseIds) &&
          ['represented_in_body', 'possible_requirement_unknown'].includes(
            String(row.status),
          ) &&
          (row.status !== 'represented_in_body' ||
            (row.bodyClauseIds.length > 0 &&
              row.bodyClauseIds.every((id: string) =>
                clauses.some(
                  (clause) => object(clause) && clause.clauseId === id,
                ),
              ))),
      ) ||
      new Set(metadata.map((row) => row.fieldId)).size !== metadata.length
    )
      return null;
    const materialFields = metadata.filter(
      (row) => row.status !== 'represented_in_body',
    );
    const materialUnitIds = [
      ...material.map((row) => row.clauseId),
      ...materialFields.map((row) => row.fieldId),
    ];
    if (
      !clauses.every(
        (row) =>
          object(row) &&
          text(row.clauseId) &&
          [
            'certified_nonrequirement',
            'confirmed_requirement',
            'possible_requirement_unknown',
          ].includes(String(row.status)),
      ) ||
      new Set(clauses.map((row) => row.clauseId)).size !== clauses.length ||
      new Set(materialUnitIds).size !== materialUnitIds.length ||
      completion.catalogClauseCount !== clauses.length + metadata.length ||
      completion.reviewedMaterialClauseCount !== materialUnitIds.length ||
      completion.possibleRequirementCount !==
        clauses.filter((row) => row.status === 'possible_requirement_unknown')
          .length +
          materialFields.length ||
      materialIds.length !== materialUnitIds.length ||
      materialUnitIds.some((id) => !materialIds.includes(id)) ||
      value.requirements.length !== materialUnitIds.length
    )
      return null;
    const linked = new Set<string>();
    for (const row of value.requirements) {
      if (
        !ids(row.originalRequirementIds) ||
        !['criterion', 'context', 'unknown'].includes(
          String(row.sourceDisposition),
        ) ||
        !['confirmed_requirement', 'possible_requirement_unknown'].includes(
          String(row.sourceClassification),
        ) ||
        row.postingCitations.length !== 1 ||
        !['whole_clause', 'whole_field'].includes(
          String(row.postingCitations[0].citationMode),
        ) ||
        (row.postingCitations[0].citationMode === 'whole_field' &&
          (row.postingCitations[0].start !== 0 ||
            !row.postingCitations[0].clauseId.startsWith('source-field:') ||
            typeof row.postingCitations[0].sourceFieldPath !== 'string' ||
            !/^sourceContentJson\.[A-Za-z][A-Za-z0-9]*$/.test(
              row.postingCitations[0].sourceFieldPath,
            ))) ||
        !row.candidateCitations.every(
          (cite: Record<string, unknown>) =>
            cite.citationMode === 'whole_fact' && cite.start === 0,
        )
      )
        return null;
      const clauseId = row.postingCitations[0].clauseId;
      if (row.postingCitations[0].citationMode === 'whole_field') {
        const field = materialFields.find((item) => item.fieldId === clauseId);
        if (
          !field ||
          field.path !== row.postingCitations[0].sourceFieldPath ||
          row.sourceClassification !== 'possible_requirement_unknown' ||
          linked.has(clauseId)
        )
          return null;
        linked.add(clauseId);
        continue;
      }
      const source = material.find((item) => item.clauseId === clauseId);
      if (
        !source ||
        source.status !== row.sourceClassification ||
        linked.has(clauseId)
      )
        return null;
      linked.add(clauseId);
    }
  }
  if (value.advisoryRelevance !== undefined) {
    const advisory = value.advisoryRelevance;
    const verification = value.verification;
    const considered = value.requirements.filter(
      (row) => row.sourceDisposition !== 'context',
    );
    if (
      value.mode !== 'complete_material' ||
      !object(verification) ||
      verification.version !==
        'opportunity-review-strength-verification/v2-partial-relevance' ||
      !object(advisory) ||
      advisory.kind !== 'supplied_evidence_relevance' ||
      !object(value.evidenceFit) ||
      advisory.denominator !== value.evidenceFit.consideredCriterionCount ||
      !Array.isArray(advisory.criterionProbabilityPairs)
    )
      return null;
    const pairs = advisory.criterionProbabilityPairs;
    const partialIds = verification.partialSupportedRequirementIds;
    if (!ids(partialIds)) return null;
    if (
      pairs.length !== considered.length ||
      !pairs.every(
        (pair, index) =>
          object(pair) &&
          pair.requirementId === considered[index].id &&
          typeof pair.probability === 'number' &&
          Number.isFinite(pair.probability) &&
          pair.probability >= 0 &&
          pair.probability <= 1 &&
          ['cited', 'unestablished'].includes(String(pair.evidenceStatus)) &&
          (pair.evidenceStatus === 'unestablished'
            ? pair.probability === 0
            : considered[index].sourceDisposition === 'criterion' &&
              considered[index].candidateCitations.length > 0 &&
              considered[index].postingCitations.length > 0),
      ) ||
      pairs.filter((pair) => pair.evidenceStatus === 'cited').length !==
        verification.partialClaimCount ||
      pairs
        .filter(
          (pair, index) =>
            pair.evidenceStatus === 'cited' &&
            pair.probability >= 0.85 &&
            considered[index].status === 'uncertain',
        )
        .some((pair) => !partialIds.includes(pair.requirementId)) ||
      partialIds.some(
        (id) =>
          !pairs.some(
            (pair) =>
              pair.requirementId === id &&
              pair.evidenceStatus === 'cited' &&
              pair.probability >= 0.85,
          ),
      ) ||
      advisory.weightedMean !==
        advisoryRelevanceMean(pairs, Number(advisory.denominator))
    )
      return null;
  }
  return value as unknown as OpportunityResumeFitReviewProjection;
}

export function getCurrentCompleteOpportunityReview(
  projection: unknown,
  completeReviewStatus?: unknown,
): OpportunityResumeFitReviewProjection | null {
  if (completeReviewStatus === 'unknown') return null;
  const current = getCurrentOpportunityResumeFitReviewProjection(projection);
  return current?.mode === 'complete_material' && current.evidenceFit
    ? current
    : null;
}

export function completeReviewLabel(
  review: OpportunityResumeFitReviewProjection,
): string {
  if (
    review.advisoryRelevance &&
    review.advisoryRelevance.weightedMean !== null
  )
    return 'Advisory relevance';
  return review.verification?.version ===
    'opportunity-review-strength-verification/v2-partial-relevance' &&
    Number(review.verification.verifiedPartialCount) > 0
    ? 'Partial evidence'
    : review.evidenceFit
      ? evidenceFitLabel(review.evidenceFit)
      : 'Review needs clarification';
}

export function hasUnavailableCompleteOpportunityReview(
  record: Record<string, unknown>,
): boolean {
  return (
    record.completeReviewStatus === 'unknown' ||
    (object(record.resumeFitReviewProjection) &&
      record.resumeFitReviewProjection.mode === 'complete_material' &&
      !getCurrentCompleteOpportunityReview(record.resumeFitReviewProjection))
  );
}

export function currentCitedSupport(record: Record<string, unknown>): {
  supportedCriterionCount: number;
  supportLowerBound: number | null;
  advisoryRelevanceMean?: number | null;
  partialSupportedCriterionCount?: number;
  partialSupportLowerBound?: number | null;
} | null {
  const complete = getCurrentCompleteOpportunityReview(
    record.resumeFitReviewProjection,
    record.completeReviewStatus,
  );
  if (complete?.evidenceFit)
    return {
      supportedCriterionCount: complete.evidenceFit.supportedCriterionCount,
      supportLowerBound: complete.evidenceFit.supportLowerBound,
      ...(complete.advisoryRelevance
        ? { advisoryRelevanceMean: complete.advisoryRelevance.weightedMean }
        : {}),
      ...(complete.verification?.version ===
        'opportunity-review-strength-verification/v2-partial-relevance' &&
      Number(complete.verification.verifiedPartialCount) > 0
        ? {
            partialSupportedCriterionCount:
              complete.verification.verifiedPartialCount,
            partialSupportLowerBound: complete.evidenceFit
              .consideredCriterionCount
              ? Number(complete.verification.verifiedPartialCount) /
                complete.evidenceFit.consideredCriterionCount
              : null,
          }
        : {}),
    };
  if (hasUnavailableCompleteOpportunityReview(record)) return null;
  const partial = getCurrentPartialOpportunityAssessmentProjection(
    record.partialAssessmentProjection,
  );
  return partial
    ? {
        supportedCriterionCount: partial.supportedCriterionCount,
        supportLowerBound: null,
      }
    : null;
}
