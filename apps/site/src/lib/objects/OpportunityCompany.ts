import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'opportunity_companies',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class OpportunityCompany extends SmrtObject {
  @field({ type: 'text' })
  opportunityId = '';
  @field({ type: 'text' })
  organizationProfileId = '';
  @field({ type: 'text' })
  companyResearchId = '';
  @field({ type: 'text' })
  legacyCompanyId = '';
  @field({ type: 'text' })
  companyRole = 'employer';
  @field({ type: 'boolean' })
  isPrimary = false;
  @field({ type: 'text' })
  sourceCrawlItemId = '';
  @field({ type: 'text' })
  notes = '';
}
