import {
  OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
  type OpportunityResumeFitReviewResult,
  readCurrentOpportunityResumeFitReview,
} from './opportunity-resume-fit-review.js';
import { listPrivateRecords } from './private-workspace.js';
import {
  requireCandidateWorkspaceSubject,
  type WorkspaceSubject,
} from './workspace-subject.js';

/** Private advisory DTO. Authority comes only from the native attested reader. */
export interface OpportunityResumeFitReviewProjection {
  version: 'opportunity-resume-fit-review-projection/v1';
  mode: 'advisory';
  sourceStatus: 'current';
  coverage: OpportunityResumeFitReviewResult['coverage'];
  requirements: OpportunityResumeFitReviewResult['requirements'];
}

export async function loadCurrentOpportunityResumeFitReviewProjections(input: {
  opportunities: Record<string, unknown>[];
  subject: WorkspaceSubject;
}): Promise<Map<string, OpportunityResumeFitReviewProjection>> {
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
  const projections = new Map<string, OpportunityResumeFitReviewProjection>();
  if (!uniqueOpportunities.length) return projections;
  // Saved rows locate reviews; only the actual reader can authorize their contents.
  const saved = await listPrivateRecords('OpportunityAssessment', subject, {
    where: {
      'opportunityId in': uniqueOpportunities.map((record) => record.id),
      contractVersion: OPPORTUNITY_RESUME_FIT_REVIEW_VERSION,
      status: 'advisory',
    },
  });
  const savedIds = new Set(saved.map((record) => record.opportunityId));
  const opportunities = uniqueOpportunities.filter((record) =>
    savedIds.has(record.id),
  );
  let next = 0;
  // Bound fresh private receipt/catalog reconstruction independently of page size.
  await Promise.all(
    Array.from({ length: Math.min(4, opportunities.length) }, async () => {
      while (next < opportunities.length) {
        const opportunity = opportunities[next++];
        const result = await readCurrentOpportunityResumeFitReview(
          opportunity,
          subject,
        );
        if (!result) continue;
        projections.set(opportunity.id as string, {
          version: 'opportunity-resume-fit-review-projection/v1',
          mode: 'advisory',
          sourceStatus: 'current',
          coverage: structuredClone(result.coverage),
          requirements: structuredClone(result.requirements),
        });
      }
    }),
  );
  return projections;
}
