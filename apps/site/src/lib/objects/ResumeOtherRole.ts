import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_other_roles',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeOtherRole extends SmrtObject {
  @field({ type: 'text' })
  role = '';
  @field({ type: 'text' })
  company = '';
  @field({ type: 'text' })
  period = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'text' })
  tags = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
