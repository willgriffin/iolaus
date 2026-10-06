import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'resume_positions',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ResumePosition extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  positionId = '';
  @field({ type: 'text' })
  role = '';
  @field({ type: 'text' })
  company = '';
  @field({ type: 'text' })
  companyHref = '';
  @field({ type: 'decimal' })
  weight = 0;
  @field({ type: 'text' })
  start = '';
  @field({ type: 'text' })
  endLabel = '';
  @field({ type: 'text' })
  blurb = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
