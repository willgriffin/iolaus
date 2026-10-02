import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'preference_rules',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
@TenantScoped()
export class PreferenceRule extends SmrtObject {
  @tenantId()
  tenantId = '';
  @field({ type: 'text', required: true })
  ownerUserId = '';
  @field({ type: 'text', required: true })
  candidateProfileId = '';
  @field({ type: 'text' })
  category = 'scoring';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  description = '';
  @field({ type: 'decimal' })
  weight = 0;
  @field({ type: 'boolean' })
  isHardFilter = false;
  @field({ type: 'text' })
  ruleJson = '{}';
  @field({ type: 'boolean' })
  active = true;
}
