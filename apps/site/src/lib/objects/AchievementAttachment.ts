import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'achievement_attachments',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class AchievementAttachment extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  achievementId = '';
  @field({ type: 'text' })
  attachmentId = '';
  @field({ type: 'text' })
  usage = 'evidence';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
