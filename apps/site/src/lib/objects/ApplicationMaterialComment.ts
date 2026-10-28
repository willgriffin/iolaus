import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'application_material_comments',
  // Review remarks can expose a candidate's application package and private
  // feedback. Only the subject-bound review service may access them.
  // Candidate-owned record: the generic REST, CLI and MCP surfaces scope every
  // read and write to the verified workspace subject (scoped-resource-crud.ts)
  // and keep this class's guards; see docs/surface-parity.md.
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped()
export class ApplicationMaterialComment extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text' })
  applicationId = '';
  @field({ type: 'text' })
  materialType = 'packet';
  @field({ type: 'text' })
  materialRecordType = '';
  @field({ type: 'text' })
  materialRecordId = '';
  // SHA-256 fingerprint of the reviewed artifact. A later artifact revision
  // cannot inherit this review record.
  @field({ type: 'text' })
  materialVersion = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'text' })
  status = 'open';
  @field({ type: 'text' })
  reviewerUserId = '';
  @field({ type: 'text' })
  reviewerProfileId = '';
  @field({ type: 'datetime', nullable: true })
  resolvedAt: Date | null = null;
}
