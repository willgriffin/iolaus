import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'source_crawls',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class SourceCrawl extends SmrtObject {
  @field({ type: 'text' })
  sourceId = '';
  @field({ type: 'text' })
  crawlType = 'manual';
  @field({ type: 'text' })
  status = 'queued';
  @field({ type: 'text' })
  actorProfileId = '';
  @field({ type: 'text' })
  initiatedByUserId = '';
  @field({ type: 'text' })
  agentRunId = '';
  @field({ type: 'text' })
  jobId = '';
  @field({ type: 'integer' })
  jobAttempt = 0;
  @field({ type: 'text' })
  requestKey = '';
  @field({ type: 'text' })
  query = '';
  @field({ type: 'text' })
  tagsJson = '[]';
  @field({ type: 'text' })
  filtersJson = '{}';
  @field({ type: 'text' })
  preferenceSnapshotJson = '{}';
  @field({ type: 'text' })
  integrationMethod = 'manual';
  @field({ type: 'decimal', nullable: true })
  resultCount: number | null = null;
  @field({ type: 'decimal', nullable: true })
  newOpportunityCount: number | null = null;
  @field({ type: 'decimal', nullable: true })
  duplicateCount: number | null = null;
  @field({ type: 'decimal', nullable: true })
  recommendedCount: number | null = null;
  @field({ type: 'decimal', nullable: true })
  skippedCount: number | null = null;
  @field({ type: 'integer' })
  attemptCount = 0;
  @field({ type: 'integer' })
  terminalCount = 0;
  @field({ type: 'integer' })
  pendingCount = 0;
  @field({ type: 'integer' })
  reusedCount = 0;
  @field({ type: 'integer' })
  relistedCount = 0;
  @field({ type: 'integer' })
  failedPersistenceCount = 0;
  @field({ type: 'integer' })
  intelligenceEnqueueCap = 0;
  @field({ type: 'integer' })
  intelligenceEnqueuedCount = 0;
  @field({ type: 'integer' })
  intelligenceDuplicateCount = 0;
  @field({ type: 'integer' })
  intelligenceSkippedCount = 0;
  @field({ type: 'integer' })
  intelligenceCallLimit = 0;
  @field({ type: 'integer' })
  intelligenceInputTokenLimit = 0;
  @field({ type: 'integer' })
  intelligenceSpendLimitMicros = 0;
  @field({ type: 'integer' })
  intelligenceReservedCalls = 0;
  @field({ type: 'integer' })
  intelligenceReservedInputTokens = 0;
  @field({ type: 'integer' })
  intelligenceReservedSpendMicros = 0;
  @field({ type: 'integer' })
  intelligenceActualCalls = 0;
  @field({ type: 'integer' })
  intelligenceActualInputTokens = 0;
  @field({ type: 'integer' })
  intelligenceActualOutputTokens = 0;
  @field({ type: 'integer' })
  intelligenceActualSpendMicros = 0;
  @field({ type: 'text' })
  error = '';
  @field({ type: 'text' })
  notes = '';
  @field({ type: 'text' })
  rawOutputPath = '';
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  finishedAt: Date | null = null;
}
