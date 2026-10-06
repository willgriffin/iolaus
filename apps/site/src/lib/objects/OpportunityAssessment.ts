import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * A machine-generated, candidate-private view of a global opportunity. This
 * model deliberately excludes generated/public data surfaces: callers obtain
 * it only through server-side workspace ownership checks.
 */
@smrt({
  tableName: 'opportunity_assessments',
  conflictColumns: [
    'tenant_id',
    'owner_user_id',
    'candidate_profile_id',
    'opportunity_id',
    'assessment_fingerprint',
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class OpportunityAssessment extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  assessmentFingerprint = '';
  @field({ type: 'text', sensitive: true })
  candidateMaterialFingerprint = '';
  @field({ type: 'text' })
  eligibilityBucket = 'unknown';
  @field({ type: 'integer' })
  eligibilityPriority = 2;
  @field({ type: 'integer' })
  fitScore = 0;
  /** Whether the stored evidence can support a meaningful match ranking. */
  @field({ type: 'text' })
  matchReadiness = 'needs_extraction';
  @field({ type: 'boolean' })
  excluded = false;
  @field({ type: 'text' })
  preferencesFingerprint = '';
  @field({ type: 'text' })
  sourceContentFingerprint = '';
  @field({ type: 'integer' })
  sourceContentVersion = 0;
  @field({ type: 'text' })
  contractVersion = '';
  @field({ type: 'text' })
  model = '';
  @field({ type: 'text' })
  provider = '';
  /** Full source-attributed output is private candidate context. */
  @field({ type: 'text', sensitive: true })
  assessmentJson = '{}';
  /** UI-safe projection has no raw resume or posting passages. */
  @field({ type: 'text' })
  projectionJson = '{}';
  @field({ type: 'text' })
  status = 'current';
  @field({ type: 'text' })
  agentRunId = '';
}
