import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'achievements',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class Achievement extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  projectId = '';
  @field({ type: 'text' })
  resumePlacement = 'auto';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'text' })
  metric = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
