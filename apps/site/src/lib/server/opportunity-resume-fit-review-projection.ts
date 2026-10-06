import { advisoryRelevanceMean } from '../opportunity-resume-fit-review-projection.js';
import type { OpportunityReviewEvidenceFit } from './opportunity-assessment-completeness.js';
import {
  OPPORTUNITY_RESUME_FIT_REVIEW_COMPLETE_VERSION,
  OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION,
  OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
  type OpportunityResumeFitReviewResult,
  readCurrentOpportunityResumeFitReview,
} from './opportunity-resume-fit-review.js';
import {
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION,
  type OpportunityReviewStrengthVerificationResult,
  type OpportunityReviewStrengthVerificationVersion,
  readCurrentOpportunityReviewStrengthVerification,
} from './opportunity-review-strength-verification.js';
import { listPrivateRecords } from './private-workspace.js';
import {
  requireCandidateWorkspaceSubject,
  type WorkspaceSubject,
} from './workspace-subject.js';

export interface OpportunityAdvisoryRelevance {
  kind: 'supplied_evidence_relevance';
  criterionProbabilityPairs: {
    requirementId: string;
    probability: number;
    evidenceStatus: 'cited' | 'unestablished';
  }[];
  denominator: number;
  weightedMean: number | null;
}

/** Private advisory DTO. Authority comes only from the native attested reader. */
export interface OpportunityResumeFitReviewProjection {
  version: 'opportunity-resume-fit-review-projection/v1';
  mode: 'advisory' | 'complete_material';
  resultContractVersion?: OpportunityResumeFitReviewResult['contractVersion'];
  evidenceFit?: OpportunityReviewEvidenceFit;
  advisoryRelevance?: OpportunityAdvisoryRelevance;
  verification?: Pick<
    OpportunityReviewStrengthVerificationResult['verification'],
    | 'version'
    | 'model'
    | 'strengthClaimCount'
    | 'verifiedStrengthCount'
    | 'seniorityClaimCount'
    | 'verifiedSeniorityCount'
  > & {
    sourceStatus: 'current';
    partialClaimCount?: number;
    verifiedPartialCount?: number;
    partialSupportedRequirementIds?: string[];
  };
  completion?: {
    status: 'reviewed_with_unknowns';
    consideredComplete: true;
    catalogClauseCount: number;
    reviewedMaterialClauseCount: number;
    possibleRequirementCount: number;
    unprocessedClauseIds: string[];
  };
  sourceStatus: 'current';
  model: OpportunityResumeFitReviewResult['model'];
  coverage: OpportunityResumeFitReviewResult['coverage'];
  requirements: Array<
    OpportunityResumeFitReviewResult['requirements'][number] & {
      originalSolSuggestion?: Pick<
        OpportunityResumeFitReviewResult['requirements'][number],
        'status' | 'seniority' | 'note'
      >;
    }
  >;
}

export interface OpportunityResumeFitReviewProjectionMap
  extends Map<string, OpportunityResumeFitReviewProjection> {
  completeReviewStatuses: Map<string, 'current' | 'unknown'>;
}

export async function loadCurrentOpportunityResumeFitReviewProjections(input: {
  opportunities: Record<string, unknown>[];
  subject: WorkspaceSubject;
}): Promise<OpportunityResumeFitReviewProjectionMap> {
  const subject = requireCandidateWorkspaceSubject(input.subject);
  const uniqueOpportunities = Array.from(
    new Map(
      input.opportunities
        .filter(
          (record) => typeof record.id === 'string' && record.id.length > 0,
        )
        .map((record) => [record.id as string, record]),
    ).values(),
  );
  const projections = Object.assign(
    new Map<string, OpportunityResumeFitReviewProjection>(),
    {
      completeReviewStatuses: new Map<string, 'current' | 'unknown'>(),
    },
  );
  if (!uniqueOpportunities.length) return projections;
  // Saved rows locate reviews; only the actual reader can authorize their contents.
  const saved = await listPrivateRecords('OpportunityAssessment', subject, {
    where: {
      'opportunityId in': uniqueOpportunities.map((record) => record.id),
      'contractVersion in': [
        OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
        OPPORTUNITY_RESUME_FIT_REVIEW_QUOTE_VERSION,
        OPPORTUNITY_RESUME_FIT_REVIEW_COMPLETE_VERSION,
        OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
        OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION,
      ],
      'status in': ['advisory', 'reviewed_with_unknowns', 'strength_verified'],
    },
  });
  const savedIds = new Set(saved.map((record) => record.opportunityId));
  const completeIds = new Set(
    saved
      .filter(
        (record) =>
          record.contractVersion ===
            OPPORTUNITY_RESUME_FIT_REVIEW_COMPLETE_VERSION &&
          record.status === 'reviewed_with_unknowns',
      )
      .map((record) => record.opportunityId),
  );
  const verifiedVersions = new Map<
    unknown,
    OpportunityReviewStrengthVerificationVersion
  >();
  for (const record of saved) {
    if (record.status !== 'strength_verified') continue;
    if (
      record.contractVersion ===
      OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION
    )
      verifiedVersions.set(
        record.opportunityId,
        OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION,
      );
    else if (
      record.contractVersion ===
        OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION &&
      !verifiedVersions.has(record.opportunityId)
    )
      verifiedVersions.set(
        record.opportunityId,
        OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_V1_VERSION,
      );
  }
  for (const opportunity of uniqueOpportunities) {
    if (completeIds.has(opportunity.id) || verifiedVersions.has(opportunity.id))
      projections.completeReviewStatuses.set(
        opportunity.id as string,
        'unknown',
      );
  }
  const opportunities = uniqueOpportunities.filter((record) =>
    savedIds.has(record.id),
  );
  let next = 0;
  // Bound fresh private receipt/catalog reconstruction independently of page size.
  await Promise.all(
    Array.from({ length: Math.min(4, opportunities.length) }, async () => {
      while (next < opportunities.length) {
        const opportunity = opportunities[next++];
        const selectedVerificationVersion = verifiedVersions.get(
          opportunity.id,
        );
        const selectedVerified = selectedVerificationVersion !== undefined;
        const selectedComplete =
          selectedVerified || completeIds.has(opportunity.id);
        const verified = selectedVerified
          ? await readCurrentOpportunityReviewStrengthVerification(
              opportunity,
              subject,
              { version: selectedVerificationVersion },
            )
          : undefined;
        if (
          selectedVerified &&
          (!verified ||
            verified.contractVersion !== selectedVerificationVersion ||
            verified.verification?.version !== selectedVerificationVersion ||
            verified.mode !== 'independent_strength_verification' ||
            verified.model !== OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_MODEL ||
            verified.effectiveReview.model !== 'openai/gpt-6.1-sol' ||
            verified.originalReview.model !== 'openai/gpt-6.1-sol')
        )
          continue;
        const result = selectedVerified
          ? verified?.effectiveReview
          : selectedComplete
            ? await readCurrentOpportunityResumeFitReview(
                opportunity,
                subject,
                {
                  version: OPPORTUNITY_RESUME_FIT_REVIEW_COMPLETE_VERSION,
                  model: 'openai/gpt-6-luna',
                },
              )
            : await readCurrentOpportunityResumeFitReview(opportunity, subject);
        if (!result) continue;
        if (
          selectedComplete &&
          (result.contractVersion !==
            OPPORTUNITY_RESUME_FIT_REVIEW_COMPLETE_VERSION ||
            result.model !==
              (selectedVerified ? 'openai/gpt-6.1-sol' : 'openai/gpt-6-luna') ||
            result.mode !== 'complete_material')
        )
          continue;
        if (!selectedComplete && result.mode === 'complete_material') continue;
        // V4 display waits for the native reader's canonical QA acceptance,
        // independently of any model-supplied consideration flag.
        const completion = result.coverage.completion;
        if (
          result.mode === 'complete_material' &&
          (!result.evidenceFit ||
            completion?.status !== 'reviewed_with_unknowns' ||
            completion.consideredComplete !== true ||
            completion.unprocessedClauseIds.length)
        )
          continue;
        const probabilityPairs =
          verified?.contractVersion ===
          OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION
            ? result.requirements
                .filter((row) => row.sourceDisposition !== 'context')
                .map((row) => {
                  const judgment = verified.judgments.find(
                    (item) =>
                      item.dimension === 'partial_relevance' &&
                      item.requirementId === row.id,
                  );
                  const cited =
                    row.sourceDisposition === 'criterion' &&
                    row.candidateCitations.length > 0 &&
                    row.postingCitations.length > 0 &&
                    !!judgment;
                  return {
                    requirementId: row.id,
                    probability: cited ? judgment.probability : 0,
                    evidenceStatus: cited
                      ? ('cited' as const)
                      : ('unestablished' as const),
                  };
                })
            : undefined;
        const advisoryRelevance: OpportunityAdvisoryRelevance | undefined =
          probabilityPairs && result.evidenceFit
            ? {
                kind: 'supplied_evidence_relevance',
                criterionProbabilityPairs: probabilityPairs,
                denominator: result.evidenceFit.consideredCriterionCount,
                weightedMean: advisoryRelevanceMean(
                  probabilityPairs,
                  result.evidenceFit.consideredCriterionCount,
                ),
              }
            : undefined;
        if (selectedComplete)
          projections.completeReviewStatuses.set(
            opportunity.id as string,
            'current',
          );
        projections.set(opportunity.id as string, {
          version: 'opportunity-resume-fit-review-projection/v1',
          mode: result.mode,
          resultContractVersion: result.contractVersion,
          ...(advisoryRelevance ? { advisoryRelevance } : {}),
          ...(verified
            ? {
                verification: {
                  sourceStatus: 'current' as const,
                  version: verified.verification.version,
                  model: verified.verification.model,
                  strengthClaimCount: verified.verification.strengthClaimCount,
                  verifiedStrengthCount:
                    verified.verification.verifiedStrengthCount,
                  seniorityClaimCount:
                    verified.verification.seniorityClaimCount,
                  verifiedSeniorityCount:
                    verified.verification.verifiedSeniorityCount,
                  ...(verified.verification.version ===
                  OPPORTUNITY_REVIEW_STRENGTH_VERIFICATION_VERSION
                    ? {
                        partialClaimCount:
                          verified.verification.partialClaimCount,
                        verifiedPartialCount:
                          verified.verification.verifiedPartialCount,
                        partialSupportedRequirementIds: [
                          ...(verified.verification
                            .partialSupportedRequirementIds ?? []),
                        ],
                      }
                    : {}),
                },
              }
            : {}),
          ...(result.mode === 'complete_material' && completion
            ? {
                evidenceFit: structuredClone(result.evidenceFit),
                completion: {
                  status: 'reviewed_with_unknowns' as const,
                  consideredComplete: true as const,
                  catalogClauseCount: completion.catalogClauseCount,
                  reviewedMaterialClauseCount:
                    completion.reviewedMaterialClauseCount,
                  possibleRequirementCount: completion.possibleRequirementCount,
                  unprocessedClauseIds: [...completion.unprocessedClauseIds],
                },
              }
            : {}),
          sourceStatus: 'current',
          model: result.model,
          coverage: structuredClone(result.coverage),
          requirements: structuredClone(
            result.requirements.map((row) => {
              const original = verified?.originalReview.requirements.find(
                (item) => item.id === row.id,
              );
              return original &&
                (original.status === 'strength' ||
                  original.seniority === 'supported')
                ? {
                    ...row,
                    originalSolSuggestion: {
                      status: original.status,
                      seniority: original.seniority,
                      note: original.note,
                    },
                  }
                : row;
            }),
          ),
        });
      }
    }),
  );
  return projections;
}
