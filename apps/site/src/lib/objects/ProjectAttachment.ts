import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'project_attachments',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ProjectAttachment extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  projectId = '';
  @field({ type: 'text' })
  attachmentId = '';
  @field({ type: 'text' })
  usage = 'artifact';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
