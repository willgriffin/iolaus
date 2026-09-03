import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'decisions',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class Decision extends SmrtObject {
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  applicationId = '';
  @field({ type: 'text' })
  taskId = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  evaluationScoreId = '';
  @field({ type: 'text' })
  agentRunId = '';
  @field({ type: 'text' })
  deciderProfileId = '';
  @field({ type: 'text' })
  deciderUserId = '';
  @field({ type: 'text' })
  decisionBy = 'owner';
  @field({ type: 'text' })
  decision = 'defer';
  @field({ type: 'text' })
  reason = '';
  @field({ type: 'text' })
  previousStatus = '';
  @field({ type: 'text' })
  newStatus = '';
  @field({ type: 'text' })
  decisionTags = '';
}
