import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'skill_groups',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class SkillGroup extends SmrtObject {
  @field({ type: 'text' })
  groupKey = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'text' })
  blurb = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
