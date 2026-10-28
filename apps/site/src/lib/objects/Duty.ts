import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'duties',
  // Candidate-owned résumé record: the generic REST, CLI and MCP surfaces
  // scope every read and write to the verified workspace subject
  // (scoped-resource-crud.ts); see docs/surface-parity.md.
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped()
export class Duty extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  projectId = '';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  body = '';
  @field({ type: 'decimal' })
  sortOrder = 0;
  @field({ type: 'boolean' })
  useOnResume = true;
}
