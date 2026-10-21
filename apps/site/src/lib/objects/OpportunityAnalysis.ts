import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
@smrt({
  tableName: 'opportunity_analyses',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class OpportunityAnalysis extends SmrtObject {
  @foreignKey('Opportunity', { onDelete: 'CASCADE' }) opportunityId = '';
  @field({ type: 'text' }) sourceContentFingerprint = '';
  @field({ type: 'integer' }) sourceContentVersion = 0;
  @field({ type: 'text' }) sourceContentDigest = '';
  @field({ type: 'text' }) analysisVersion = 'opportunity-analysis/v1';
  @field({ type: 'text' }) status = 'pending';
  @field({ type: 'text' }) normalizedTitle = '';
  @field({ type: 'text' }) seniority = 'unknown';
  @field({ type: 'text' }) function = 'unknown';
  @field({ type: 'text' }) workMode = 'unknown';
  @field({ type: 'text' }) employmentType = 'unknown';
  @field({ type: 'text' }) skillsJson = '[]';
  @field({ type: 'text' }) requirementsJson = '[]';
  @field({ type: 'text' }) eligibilityJson = '{}';
  @field({ type: 'text' }) compensationJson = '{}';
  @field({ type: 'text' }) summaryJson = '[]';
  @field({ type: 'text' }) countriesJson = '[]';
  @field({ type: 'text' }) skillSlugsJson = '[]';
  @field({ type: 'text' }) model = '';
  @field({ type: 'text' }) promptVersion = '';
  @field({ type: 'text' }) outputSchemaVersion = 'opportunity-analysis/v1';
  @field({ type: 'integer' }) inputTokens = 0;
  @field({ type: 'integer' }) outputTokens = 0;
  @field({ type: 'integer' }) costMicros = 0;
  @field({ type: 'text' }) requestId = '';
  @field({ type: 'text' }) errorCode = '';
}
