import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'education',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class Education extends SmrtObject {
  @field({ type: 'text' })
  profileKey = 'default';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  institution = '';
  @field({ type: 'text' })
  detail = '';
  @field({ type: 'datetime', nullable: true })
  startDate: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  endDate: Date | null = null;
  @field({ type: 'decimal' })
  sortOrder = 0;
}
