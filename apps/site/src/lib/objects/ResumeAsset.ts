import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'resume_assets',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ResumeAsset extends SmrtObject {
  @field({ type: 'text' })
  applicationId = '';
  @field({ type: 'text' })
  sourceAssetId = '';
  @field({ type: 'text' })
  candidateProfileId = '';
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
