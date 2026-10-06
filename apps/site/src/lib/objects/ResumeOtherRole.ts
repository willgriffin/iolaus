import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'resume_other_roles',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ResumeOtherRole extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  role = '';
  @field({ type: 'text' })
  company = '';
  @field({ type: 'text' })
  period = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'text' })
  tags = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
