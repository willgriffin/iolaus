import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'evaluation_scores',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class EvaluationScore extends SmrtObject {
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  sourceCrawlId = '';
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  sourceId = '';
  @field({ type: 'text' })
  sourceContentFingerprint = '';
  @field({ type: 'integer' })
  sourceContentVersion = 0;
  @field({ type: 'text' })
  agentRunId = '';
  @field({ type: 'decimal', nullable: true })
  score: number | null = null;
  @field({ type: 'text' })
  recommendation = 'unknown';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'text' })
  reasonJson = '{}';
  @field({ type: 'text' })
  createdByProfileId = '';
}
