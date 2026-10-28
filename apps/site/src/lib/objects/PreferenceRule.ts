import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'preference_rules',
  // Candidate-owned record: the generic REST, CLI and MCP surfaces scope every
  // read and write to the verified workspace subject (scoped-resource-crud.ts)
  // and keep this class's guards; see docs/surface-parity.md.
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
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
