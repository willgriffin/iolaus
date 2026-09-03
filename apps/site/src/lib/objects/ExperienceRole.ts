import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'experience_roles',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ExperienceRole extends SmrtObject {
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  roleId = '';
  @field({ type: 'text' })
  titleSnapshot = '';
  @field({ type: 'datetime', nullable: true })
  startDate: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  endDate: Date | null = null;
  @field({ type: 'text' })
  startPrecision = 'year';
  @field({ type: 'text' })
  endPrecision = 'year';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'boolean' })
  isPrimary = true;
  @field({ type: 'decimal' })
  sortOrder = 0;
}
