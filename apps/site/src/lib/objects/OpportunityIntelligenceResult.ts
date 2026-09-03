import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'opportunity_intelligence_results',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class OpportunityIntelligenceResult extends SmrtObject {
  @field({ type: 'text' })
  idempotencyKey = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  agentRunId = '';
  @field({ type: 'text' })
  contentFingerprint = '';
  @field({ type: 'text' })
  inputFingerprint = '';
  @field({ type: 'text' })
  preparedPayloadVersion = '';
  @field({ type: 'text' })
  promptVersion = '';
  @field({ type: 'text' })
  outputSchemaVersion = '';
  @field({ type: 'text' })
  feature = '';
  @field({ type: 'text' })
  profile = '';
  @field({ type: 'text' })
  model = '';
  @field({ type: 'text' })
  status = 'started';
  @field({ type: 'text' })
  ownerRequestId = '';
  @field({ type: 'text' })
  requestId = '';
  @field({ type: 'text' })
  outputJson = '{}';
  @field({ type: 'text' })
  errorCode = '';
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  finishedAt: Date | null = null;
}
