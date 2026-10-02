import {
  type CandidateWorkEligibility,
  type OpportunityAssessmentPreference,
  type OpportunityAssessmentResult,
  rankOpportunityAssessment,
} from './opportunity-assessment.js';
import {
  createPrivateRecord,
  listPrivateRecords,
  type WorkspaceSubject,
} from './private-workspace.js';

export interface OpportunityAssessmentProjection {
  conflicting: boolean;
  personalEligibility:
    | 'eligible_without_sponsorship'
    | 'sponsorship_possible'
    | 'incompatible'
    | 'unknown';
  ranking: {
    eligibilityPriority: number;
    excluded: boolean;
    fitScore: number;
  };
  reason: string;
  sourceStatus: 'current';
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
  return {
    conflicting,
    personalEligibility: ranking.eligibility,
    ranking: {
      eligibilityPriority: ranking.eligibilityPriority,
      excluded: ranking.excluded,
      fitScore: ranking.fitScore,
    },
    reason: ranking.reasons[0] ?? 'Assessment needs clarification',
    sourceStatus: 'current',
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
  await createPrivateRecord('OpportunityAssessment', input.subject, {
    agentRunId: input.agentRunId,
    assessmentFingerprint: input.assessment.fingerprint,
    assessmentJson: JSON.stringify(input.assessment),
    candidateMaterialFingerprint: input.assessment.candidateMaterialFingerprint,
    contractVersion: input.assessment.contractVersion,
    model: input.assessment.provenance?.model ?? '',
    opportunityId: input.opportunityId,
    projectionJson: JSON.stringify(projection),
    provider: input.assessment.provenance?.provider ?? '',
    sourceContentFingerprint:
      input.assessment.postingMaterial.sourceContentFingerprint,
    sourceContentVersion: input.assessment.postingMaterial.sourceContentVersion,
    status: 'current',
  });
  return { created: true, projection };
}
