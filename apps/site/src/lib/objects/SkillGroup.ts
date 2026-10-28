import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'skill_groups',
  // Candidate-owned résumé record: the generic REST, CLI and MCP surfaces
  // scope every read and write to the verified workspace subject
  // (scoped-resource-crud.ts); see docs/surface-parity.md.
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped()
export class SkillGroup extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  groupKey = '';
  @field({ type: 'text' })
  label = '';
  @field({ type: 'text' })
  blurb = '';
  /** Private, source-backed resume-import observations. */
  @field({ type: 'text', sensitive: true })
  evidenceJson = '[]';
  @field({ type: 'decimal' })
  sortOrder = 0;
  @field({ type: 'boolean' })
  useOnResume = true;
}
