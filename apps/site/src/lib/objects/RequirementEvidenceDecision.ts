import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** A user-billed, content-addressed Stage-3 requirement decision. */
@smrt({
  tableName: 'requirement_evidence_decisions',
  conflictColumns: [
    'tenant_id',
    'owner_user_id',
    'candidate_profile_id',
    'requirement_hash',
    'candidate_material_fingerprint',
    'evidence_hash',
    'model',
    'decision_version',
  ],
  indexes: [
    {
      name: 'requirement_evidence_decisions_owner_lookup',
      columns: [
        'tenantId',
        'ownerUserId',
        'candidateProfileId',
        'candidateMaterialFingerprint',
        'requirementHash',
        'decisionVersion',
      ],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  sensitive: true,
})
@TenantScoped()
export class RequirementEvidenceDecision extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text', required: true, sensitive: true }) requirementHash =
    '';
  @field({ type: 'text', required: true, sensitive: true })
  candidateMaterialFingerprint = '';
  @field({ type: 'text' }) decisionVersion = 'requirement-evidence-decision/v1';
  @field({ type: 'text', sensitive: true }) evidenceHash = '';
  @field({ type: 'text' }) model = '';
  @field({ type: 'text', sensitive: true }) quote = '';
  @field({ type: 'decimal' }) coverage = 0;
  @field({ type: 'text' }) decision = 'unknown';
  @field({ type: 'decimal' }) confidence = 0;
  @field({ type: 'text', sensitive: true }) evidenceJson = '[]';
  @field({ type: 'text', sensitive: true }) intelligenceRequestId = '';
  @field({ type: 'text', sensitive: true }) intelligenceResultId = '';
}
