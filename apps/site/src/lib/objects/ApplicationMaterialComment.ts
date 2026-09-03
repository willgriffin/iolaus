import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'application_material_comments',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ApplicationMaterialComment extends SmrtObject {
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
