import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'achievement_attachments',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class AchievementAttachment extends SmrtObject {
  @field({ type: 'text' })
  achievementId = '';
  @field({ type: 'text' })
  attachmentId = '';
  @field({ type: 'text' })
  usage = 'evidence';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
