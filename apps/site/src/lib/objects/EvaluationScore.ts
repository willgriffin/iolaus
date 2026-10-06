import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'evaluation_scores',
  conflictColumns: [
    'tenant_id',
    'owner_user_id',
    'candidate_profile_id',
    'opportunity_id',
    'scoring_material_fingerprint',
  ],
  // Scores contain private candidate evidence and are served only by scoped projections.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
/**
 * A candidate-scoped machine score. `createdByProfileId` remains human
 * provenance only; tenant/owner/profile are the authorization boundary.
 */
@TenantScoped()
export class EvaluationScore extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  sourceId = '';
  @field({ type: 'text' })
  sourceContentFingerprint = '';
  @field({ type: 'integer' })
  sourceContentVersion = 0;
  /** Stable, model-independent candidate/posting material identity. */
  @field({ type: 'text' })
  scoringMaterialFingerprint = '';
  @field({ type: 'text' })
  agentRunId = '';
  @field({ type: 'decimal', nullable: true })
  score: number | null = null;
  @field({ type: 'text' })
  recommendation = 'unknown';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'text' })
  reasonJson = '{}';
  @field({ type: 'text' })
  createdByProfileId = '';
}
