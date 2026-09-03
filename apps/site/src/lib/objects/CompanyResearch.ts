import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'company_research',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class CompanyResearch extends SmrtObject {
  @field({ type: 'text' })
  organizationProfileId = '';
  @field({ type: 'text' })
  websiteUrl = '';
  @field({ type: 'text' })
  careersUrl = '';
  @field({ type: 'text' })
  linkedinUrl = '';
  @field({ type: 'text' })
  crunchbaseUrl = '';
  @field({ type: 'text' })
  ycUrl = '';
  @field({ type: 'text' })
  stage = 'unknown';
  @field({ type: 'text' })
  remotePolicy = 'unknown';
  @field({ type: 'text' })
  timezoneNotes = '';
  @field({ type: 'text' })
  fundingNotes = '';
  @field({ type: 'text' })
  productSummary = '';
  @field({ type: 'text' })
  technicalSummary = '';
  @field({ type: 'text' })
  whyInteresting = '';
  @field({ type: 'text' })
  concerns = '';
  @field({ type: 'text' })
  researchStatus = 'needed';
  @field({ type: 'text' })
  researchFolderPath = '';
  @field({ type: 'text' })
  hqPlaceId = '';
  @field({ type: 'text' })
  legacyHqLocation = '';
  @field({ type: 'text' })
  legacyIndustryTags = '';
}
