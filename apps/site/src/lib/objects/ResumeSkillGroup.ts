import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'resume_skill_groups',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ResumeSkillGroup extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  groupId = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'text' })
  blurb = '';
  @field({ type: 'text' })
  skillIds = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
