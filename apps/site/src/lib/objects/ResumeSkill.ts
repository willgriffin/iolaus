import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_skills',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeSkill extends SmrtObject {
  @field({ type: 'text' })
  skillId = '';
  @field({ type: 'text' })
  categoryId = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
