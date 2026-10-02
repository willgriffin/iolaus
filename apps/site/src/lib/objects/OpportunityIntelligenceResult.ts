import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'opportunity_intelligence_results',
  // `outputJson` can contain private candidate assessment evidence. Generic
  // data surfaces are closed for both private and operator-ledger rows.
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
  // A candidate assessment payload must never produce an observable change
  // signal, even with all sensitive fields stripped.
  sensitive: true,
})
export class OpportunityIntelligenceResult extends SmrtObject {
  /** Blank only for preserved operator/source ledger history. */
  @field({ type: 'text', nullable: true })
  tenantId = '';
  @field({ type: 'text', nullable: true })
  ownerUserId = '';
  @field({ type: 'text', nullable: true })
  candidateProfileId = '';
  @field({ type: 'text', sensitive: true })
  idempotencyKey = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text', sensitive: true })
  agentRunId = '';
  @field({ type: 'text' })
  contentFingerprint = '';
  @field({ type: 'text', sensitive: true })
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
  @field({ type: 'text', sensitive: true })
  ownerRequestId = '';
  @field({ type: 'text', sensitive: true })
  requestId = '';
  @field({ type: 'text', sensitive: true })
  outputJson = '{}';
  @field({ type: 'text' })
  errorCode = '';
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  finishedAt: Date | null = null;
}
