import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  name: 'EmploymentPerson',
  tableName: 'people',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class EmploymentPerson extends SmrtObject {
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  email = '';
  @field({ type: 'text' })
  linkedinUrl = '';
  @field({ type: 'text' })
  githubUrl = '';
  @field({ type: 'text' })
  websiteUrl = '';
  @field({ type: 'text' })
  roleTitle = '';
  @field({ type: 'text' })
  companyId = '';
  @field({ type: 'text' })
  notes = '';
}
