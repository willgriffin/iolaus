import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
@smrt({
  tableName: 'opportunity_skills',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class OpportunitySkill extends SmrtObject {
  @foreignKey('Opportunity', { onDelete: 'CASCADE' }) opportunityId = '';
  @foreignKey('OpportunityAnalysis', { onDelete: 'CASCADE' }) analysisId = '';
  @field({ type: 'text' }) skillSlug = '';
  @field({ type: 'text' }) kind = 'required';
  @field({ type: 'decimal' }) confidence = 1;
}
