import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'employment_roles',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class EmploymentRole extends SmrtObject {
  @field({ type: 'text' })
  roleKey = '';
  @field({ type: 'text' })
  roleSlug = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'text' })
  description = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
