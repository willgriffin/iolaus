import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'resume_assets',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ResumeAsset extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text' })
  applicationId = '';
  @field({ type: 'text' })
  sourceAssetId = '';
  @field({ type: 'text' })
  assetType = 'resume';
  @field({ type: 'text' })
  status = 'generated';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  sourcePath = '';
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
  @field({ type: 'text' })
  pdfBasename = '';
  @field({ type: 'text' })
  outputSlug = '';
  @field({ type: 'text' })
  tailoringId = '';
  @field({ type: 'boolean' })
  isPublished = false;
  @field({ type: 'datetime', nullable: true })
  generatedAt: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  publishedAt: Date | null = null;
  @field({ type: 'text' })
  targetOpportunityId = '';
  @field({ type: 'text' })
  notes = '';
}
