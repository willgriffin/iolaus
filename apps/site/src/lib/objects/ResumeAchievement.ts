import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_achievements',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeAchievement extends SmrtObject {
  @field({ type: 'text' })
  positionId = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'text' })
  metric = '';
  @field({ type: 'text' })
  tags = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
