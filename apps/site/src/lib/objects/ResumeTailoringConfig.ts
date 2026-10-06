import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'resume_tailoring_configs',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ResumeTailoringConfig extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  configSlug = '';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  company = '';
  @field({ type: 'text' })
  configJson = '{}';
  @field({ type: 'boolean' })
  active = true;
}
