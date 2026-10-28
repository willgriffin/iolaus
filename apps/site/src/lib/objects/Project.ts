import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'projects',
  // Candidate-owned résumé record: the generic REST, CLI and MCP surfaces
  // scope every read and write to the verified workspace subject
  // (scoped-resource-crud.ts); see docs/surface-parity.md.
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped()
export class Project extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  experienceId = '';
  @field({ type: 'text' })
  projectKey = '';
  @field({ type: 'text' })
  name = '';
  @field({ type: 'text' })
  url = '';
  @field({ type: 'text' })
  summary = '';
  @field({ type: 'datetime', nullable: true })
  startDate: Date | null = null;
  @field({ type: 'datetime', nullable: true })
  endDate: Date | null = null;
  @field({ type: 'text' })
  startPrecision = 'year';
  @field({ type: 'text' })
  endPrecision = 'year';
  @field({ type: 'decimal' })
  sortOrder = 0;
  @field({ type: 'boolean' })
  useOnResume = true;
}
