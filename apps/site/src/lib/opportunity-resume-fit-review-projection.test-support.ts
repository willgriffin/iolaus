/** Fictional canonical-shaped review for presentation and filtering regressions. */
export function completeReviewFixture(
  options: {
    uncertain?: boolean;
    sourceUnknown?: boolean;
    context?: boolean;
  } = {},
) {
  const unknown = options.sourceUnknown ? 1 : 0;
  const context = options.context ? 1 : 0;
  const supported = !unknown && !context && !options.uncertain ? 1 : 0;
  const uncertain = !unknown && !context && options.uncertain ? 1 : 0;
  const considered = supported + uncertain + unknown;
  const evidenceFit = {
    kind: 'evidence_summary',
    supportedCriterionCount: supported,
    uncertainCriterionCount: uncertain,
    sourceUnknownCriterionCount: unknown,
    sourceClassificationUnknownCount: unknown,
    contextUnitCount: context,
    consideredCriterionCount: considered,
    supportLowerBound: considered ? supported / considered : null,
    status: !considered
      ? 'no_applicant_criteria'
      : !supported
        ? 'needs_evidence'
        : 'supports_all_reviewed_criteria',
  };
  return {
    version: 'opportunity-resume-fit-review-projection/v1',
    mode: 'complete_material',
    sourceStatus: 'current',
    model: 'openai/gpt-6-luna',
    resultContractVersion: 'opportunity-resume-fit-review/v4-complete-material',
    evidenceFit,
    completion: {
      status: 'reviewed_with_unknowns',
      consideredComplete: true,
      catalogClauseCount: 1,
      reviewedMaterialClauseCount: 1,
      possibleRequirementCount: unknown,
      unprocessedClauseIds: [],
    },
    coverage: {
      candidateSourceCount: 150,
      reviewedRequirementIds: ['material:c1'],
      unresolvedClauseIds: unknown ? ['c1'] : [],
      sourceComplete: true,
      fullFit: evidenceFit,
      consideredComplete: true,
      sourceClauseConsideration: [
        {
          clauseId: 'c1',
          status: unknown
            ? 'possible_requirement_unknown'
            : 'confirmed_requirement',
          requirementIds: unknown ? [] : ['original:r1'],
          originalRequirementIds: unknown ? [] : ['original:r1'],
          reason: unknown ? 'low_confidence' : 'audited_requirement',
        },
      ],
      metadataConsideration: [],
      reviewedMaterialClauseIds: ['c1'],
      requirementsCertainty: unknown ? 'uncertain' : 'confirmed',
    },
    requirements: [
      {
        id: 'material:c1',
        text: 'Build APIs',
        originalRequirementIds: unknown ? [] : ['original:r1'],
        sourceClassification: unknown
          ? 'possible_requirement_unknown'
          : 'confirmed_requirement',
        sourceDisposition: unknown
          ? 'unknown'
          : context
            ? 'context'
            : 'criterion',
        status: supported ? 'strength' : 'uncertain',
        seniority: supported ? 'supported' : 'uncertain',
        note: supported
          ? 'Candidate evidence supports this criterion.'
          : 'Support remains uncertain.',
        candidateCitations: supported
          ? [
              {
                sourceId: 'fact:1',
                title: 'API project',
                kind: 'project',
                start: 0,
                end: 9,
                quote: 'Led APIs.',
                citationMode: 'whole_fact',
              },
            ]
          : [],
        postingCitations: [
          {
            clauseId: 'c1',
            start: 0,
            end: 10,
            quote: 'Build APIs',
            citationMode: 'whole_clause',
          },
        ],
      },
    ],
  };
}
