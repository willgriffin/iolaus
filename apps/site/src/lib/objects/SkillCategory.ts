import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'skill_categories',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class SkillCategory extends SmrtObject {
  @field({ type: 'text' })
  categoryKey = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
