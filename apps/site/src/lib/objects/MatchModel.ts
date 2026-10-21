import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Private per-profile Stage-4 reranker; it never contributes to global priors. */
@smrt({
  tableName: 'match_models',
  conflictColumns: [
    'tenant_id',
    'owner_user_id',
    'candidate_profile_id',
    'model_version',
  ],
  indexes: [
    {
      name: 'match_models_owner_lookup',
      columns: [
        'tenantId',
        'ownerUserId',
        'candidateProfileId',
        'modelVersion',
      ],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
@TenantScoped()
export class MatchModel extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' }) modelVersion = 'match-model/v1';
  @field({ type: 'text', sensitive: true }) weightsJson = '{}';
  @field({ type: 'decimal' }) calibrationIntercept = 0;
  @field({ type: 'integer' }) trainingDecisionCount = 0;
}
