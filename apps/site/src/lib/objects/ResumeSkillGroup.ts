import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_skill_groups',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeSkillGroup extends SmrtObject {
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
