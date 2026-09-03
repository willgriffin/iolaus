import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'achievements',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class Achievement extends SmrtObject {
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  projectId = '';
  @field({ type: 'text' })
  resumePlacement = 'auto';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'text' })
  metric = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
