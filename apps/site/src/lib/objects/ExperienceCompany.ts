import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'experience_companies',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class ExperienceCompany extends SmrtObject {
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  companyId = '';
  @field({ type: 'text' })
  relationship = 'employer';
  @field({ type: 'text' })
  companyNameSnapshot = '';
  @field({ type: 'text' })
  companyHrefSnapshot = '';
  @field({ type: 'boolean' })
  isPrimary = true;
  @field({ type: 'decimal' })
  sortOrder = 0;
}
