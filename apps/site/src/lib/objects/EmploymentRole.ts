import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'employment_roles',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class EmploymentRole extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  roleKey = '';
  @field({ type: 'text' })
  roleSlug = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'text' })
  description = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
