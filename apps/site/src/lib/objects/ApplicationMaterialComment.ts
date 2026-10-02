import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'application_material_comments',
  // Review remarks can expose a candidate's application package and private
  // feedback. Only the subject-bound review service may access them.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
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
