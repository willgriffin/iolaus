import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'opportunity_intelligence_requests',
  // Provider request history may be a global source ledger or candidate-private
  // assessment accounting. It is served only through scoped workflows.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  // Keep mixed private/operator ledger identifiers out of native change feeds.
  sensitive: true,
})
export class OpportunityIntelligenceRequest extends SmrtObject {
  /** Blank only for preserved operator/source ledger history. */
  @field({ type: 'text', nullable: true })
  tenantId = '';
  @field({ type: 'text', nullable: true })
  ownerUserId = '';
  @field({ type: 'text', nullable: true })
  candidateProfileId = '';
  @field({ type: 'text', sensitive: true })
  requestId = '';
  @field({ type: 'text', sensitive: true })
  providerRequestId = '';
  @field({ type: 'text', sensitive: true })
  idempotencyKey = '';
  @field({ type: 'text' })
  feature = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text', sensitive: true })
  agentRunId = '';
  @field({ type: 'text' })
  contentFingerprint = '';
  @field({ type: 'text', sensitive: true })
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
