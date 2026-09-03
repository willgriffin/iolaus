import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_positions',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumePosition extends SmrtObject {
  @field({ type: 'text' })
  positionId = '';
  @field({ type: 'text' })
  role = '';
  @field({ type: 'text' })
  company = '';
  @field({ type: 'text' })
  companyHref = '';
  @field({ type: 'decimal' })
  weight = 0;
  @field({ type: 'text' })
  start = '';
  @field({ type: 'text' })
  endLabel = '';
  @field({ type: 'text' })
  blurb = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
