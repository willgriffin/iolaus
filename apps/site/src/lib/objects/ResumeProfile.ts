import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'resume_profiles',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class ResumeProfile extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text' })
  ownerUserId = '';
  @field({ type: 'text' })
  candidateProfileId = '';
  @field({ type: 'text' })
  profileKey = 'default';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  email = '';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'boolean' })
  active = true;
}
