import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'opportunity_intelligence_requests',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class OpportunityIntelligenceRequest extends SmrtObject {
  @field({ type: 'text' })
  requestId = '';
  @field({ type: 'text' })
  providerRequestId = '';
  @field({ type: 'text' })
  idempotencyKey = '';
  @field({ type: 'text' })
  feature = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  agentRunId = '';
  @field({ type: 'text' })
  contentFingerprint = '';
  @field({ type: 'text' })
  inputFingerprint = '';
  @field({ type: 'text' })
  profile = '';
  @field({ type: 'text' })
  model = '';
  @field({ type: 'text' })
  provider = 'bifrost';
  @field({ type: 'text' })
  status = 'started';
  @field({ type: 'integer' })
  attempts = 0;
  @field({ type: 'integer' })
  estimatedInputTokens = 0;
  @field({ type: 'integer' })
  inputTokenCeiling = 0;
  @field({ type: 'integer' })
  requestedMaxOutputTokens = 0;
  @field({ type: 'integer' })
  reservedInputTokens = 0;
  @field({ type: 'integer' })
  actualInputTokens = 0;
  @field({ type: 'integer' })
  actualOutputTokens = 0;
  @field({ type: 'integer' })
  actualTotalTokens = 0;
  @field({ type: 'integer' })
  reservedSpendMicros = 0;
  @field({ type: 'integer' })
  actualSpendMicros = 0;
  @field({ type: 'text' })
  accountingBasis = '';
  @field({ type: 'integer' })
  durationMs = 0;
  @field({ type: 'text' })
  errorCode = '';
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  finishedAt: Date | null = null;
}
