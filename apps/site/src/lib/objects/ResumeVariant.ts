import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'resume_variants',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ResumeVariant extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text' })
  ownerUserId = '';
  @field({ type: 'text' })
  candidateProfileId = '';
  @field({ type: 'text' })
  applicationId = '';
  @field({ type: 'text' })
  sourceVariantId = '';
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  companyId = '';
  @field({ type: 'text' })
  resumeAssetId = '';
  @field({ type: 'text' })
  tailoringConfigId = '';
  @field({ type: 'text' })
  tailoringConfigPath = '';
  @field({ type: 'text' })
  status = 'draft';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  outputSlug = '';
  @field({ type: 'text' })
  titleOverride = '';
  @field({ type: 'text' })
  summaryOverride = '';
  @field({ type: 'text' })
  emphasizeTags = '';
  @field({ type: 'text' })
  excludeTags = '';
  @field({ type: 'text' })
  includePositionIds = '';
  @field({ type: 'text' })
  excludePositionIds = '';
  @field({ type: 'text' })
  generatedPath = '';
  @field({ type: 'text' })
  markdownPath = '';
  @field({ type: 'text' })
  textPath = '';
  @field({ type: 'text' })
  htmlPath = '';
  @field({ type: 'text' })
  pdfPath = '';
  @field({ type: 'datetime', nullable: true })
  generatedAt: Date | null = null;
  @field({ type: 'text' })
  notes = '';
}
