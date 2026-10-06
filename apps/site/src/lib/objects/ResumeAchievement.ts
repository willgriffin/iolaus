import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'resume_achievements',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ResumeAchievement extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  positionId = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'text' })
  metric = '';
  @field({ type: 'text' })
  tags = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
