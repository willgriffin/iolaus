import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_skill_categories',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeSkillCategory extends SmrtObject {
  @field({ type: 'text' })
  categoryId = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
