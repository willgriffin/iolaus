import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'duties',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class Duty extends SmrtObject {
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  projectId = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
