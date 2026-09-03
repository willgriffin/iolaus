import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'opportunity_roles',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class OpportunityRole extends SmrtObject {
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  roleId = '';
  @field({ type: 'text' })
  titleSnapshot = '';
  @field({ type: 'text' })
  seniority = 'unknown';
  @field({ type: 'text' })
  source = 'manual';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
