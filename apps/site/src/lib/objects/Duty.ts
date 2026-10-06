import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'duties',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class Duty extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  projectId = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
