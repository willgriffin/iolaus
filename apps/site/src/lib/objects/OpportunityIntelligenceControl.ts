import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'opportunity_intelligence_controls',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class OpportunityIntelligenceControl extends SmrtObject {
  @field({ type: 'text' })
  controlKey = 'opportunity-intelligence';
  @field({ type: 'boolean' })
  enabled = false;
  @field({ type: 'text' })
  circuitState = 'open';
  @field({ type: 'text' })
  circuitReason = 'operator_enable_required';
  @field({ type: 'integer' })
  consecutiveAborts = 0;
  @field({ type: 'integer' })
  consecutiveFailures = 0;
  @field({ type: 'integer' })
  windowRequestCount = 0;
  @field({ type: 'integer' })
  windowInputTokens = 0;
  @field({ type: 'integer' })
  abortThreshold = 3;
  @field({ type: 'integer' })
  failureThreshold = 3;
  @field({ type: 'integer' })
  latencyThresholdMs = 100_000;
  @field({ type: 'integer' })
  requestThreshold = 20;
  @field({ type: 'integer' })
  inputTokenThreshold = 100_000;
  @field({ type: 'datetime', nullable: true })
  windowStartedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  lastRequestAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  openedAt: Date | null = null;
}
