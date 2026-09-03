import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_links',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeLink extends SmrtObject {
  @field({ type: 'text' })
  profileKey = 'default';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'text' })
  href = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
