import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'experience_roles',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ExperienceRole extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  roleId = '';
  @field({ type: 'text' })
  titleSnapshot = '';
  @field({ type: 'datetime', nullable: true })
  startDate: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  endDate: Date | null = null;
  @field({ type: 'text' })
  startPrecision = 'year';
  @field({ type: 'text' })
  endPrecision = 'year';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'boolean' })
  isPrimary = true;
  @field({ type: 'decimal' })
  sortOrder = 0;
}
