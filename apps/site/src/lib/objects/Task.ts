import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'tasks',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class Task extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  externalTaskId = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  description = '';
  @field({ type: 'text' })
  status = 'open';
  @field({ type: 'text' })
  taskType = 'other';
  @field({ type: 'text' })
  kanbanColumn = 'inbox';
  @field({ type: 'text' })
  assigneeRole = 'owner';
  @field({ type: 'text' })
  blockerReason = '';
  @field({ type: 'text' })
  blockerOwnerRole = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  applicationId = '';
  @field({ type: 'text' })
  decisionId = '';
  @field({ type: 'text' })
  companyId = '';
  @field({ type: 'text' })
  organizationProfileId = '';
  @field({ type: 'text' })
  sourceId = '';
  @field({ type: 'text' })
  artifactRefsJson = '{}';
  @field({ type: 'datetime', nullable: true })
  dueAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  completedAt: Date | null = null;
  @field({ type: 'text' })
  createdByProfileId = '';
  @field({ type: 'text' })
  assignedToProfileId = '';
  @field({ type: 'text' })
  createdBy = 'owner';
}
