import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'experience_companies',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ExperienceCompany extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  companyId = '';
  @field({ type: 'text' })
  relationship = 'employer';
  @field({ type: 'text' })
  companyNameSnapshot = '';
  @field({ type: 'text' })
  companyHrefSnapshot = '';
  @field({ type: 'boolean' })
  isPrimary = true;
  @field({ type: 'decimal' })
  sortOrder = 0;
}
