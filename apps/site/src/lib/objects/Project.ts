import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'projects',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class Project extends SmrtObject {
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  projectKey = '';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  url = '';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'datetime', nullable: true })
  startDate: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  endDate: Date | null = null;
  @field({ type: 'text' })
  startPrecision = 'year';
  @field({ type: 'text' })
  endPrecision = 'year';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
