import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Version of the safe-to-sort, candidate-private recommendation projection. */
export const OPPORTUNITY_RECOMMENDATION_RANK_VERSION =
  'opportunity-recommendation-rank/v2';

export type OpportunityRecommendationAssessmentCompleteness =
  | 'full'
  | 'title_only';

/**
 * One current, receipt-proven recommendation per owned candidate and
 * opportunity. It contains only sortable scalar values and provenance IDs;
 * the assessment remains the authoritative private evidence record.
 */
@smrt({
  tableName: 'opportunity_recommendation_ranks',
  conflictColumns: [
    'tenant_id',
    'owner_user_id',
    'candidate_profile_id',
    'opportunity_id',
  ],
  indexes: [
    {
      name: 'opportunity_recommendation_ranks_current_lookup',
      columns: [
        'tenantId',
        'ownerUserId',
        'candidateProfileId',
        'candidateMaterialFingerprint',
        'questionSetFingerprint',
        'model',
        'projectionVersion',
        'sourceContentFingerprint',
        'sourceContentVersion',
        'recommendationPercent',
        'opportunityId',
      ],
    },
    {
      name: 'opportunity_recommendation_ranks_recommendation_order',
      columns: [
        'tenantId',
        'ownerUserId',
        'candidateProfileId',
        'candidateMaterialFingerprint',
        'questionSetFingerprint',
        'model',
        'projectionVersion',
        'recommendationPercent',
        'updated_at',
        'id',
      ],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
@TenantScoped()
export class OpportunityRecommendationRank extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text', required: true })
  opportunityId = '';
  @field({ type: 'decimal', nullable: true })
  recommendationPercent: number | null = null;
  @field({ type: 'decimal', nullable: true })
  evidenceCoveragePercent: number | null = null;
  @field({ type: 'integer' })
  mustHaveConflictCount = 0;
  @field({ type: 'text' })
  assessmentCompleteness: OpportunityRecommendationAssessmentCompleteness =
    'title_only';
  @field({ type: 'text', sensitive: true })
  sourceContentFingerprint = '';
  @field({ type: 'integer' })
  sourceContentVersion = 0;
  @field({ type: 'text', sensitive: true })
  candidateMaterialFingerprint = '';
  @field({ type: 'text', sensitive: true })
  questionSetFingerprint = '';
  /** Exact normalized raw opportunity requirements used by the query fence. */
  @field({ type: 'text', default: '', sensitive: true })
  requiredSkillsSnapshot = '';
  @field({ type: 'text', default: '', sensitive: true })
  preferredSkillsSnapshot = '';
  @field({ type: 'text' })
  contractVersion = '';
  @field({ type: 'text' })
  model = '';
  @field({ type: 'text' })
  projectionVersion = OPPORTUNITY_RECOMMENDATION_RANK_VERSION;
  @field({ type: 'text', sensitive: true })
  assessmentId = '';
  @field({ type: 'text', sensitive: true })
  intelligenceRequestId = '';
  @field({ type: 'text', sensitive: true })
  intelligenceResultId = '';
  @field({ type: 'text', sensitive: true })
  agentRunId = '';
  @field({ type: 'text', sensitive: true })
  assessmentFingerprint = '';
  @field({ type: 'datetime' })
  proofFinishedAt = new Date(0);
}
