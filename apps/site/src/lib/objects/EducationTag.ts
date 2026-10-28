import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'education_tags',
  // Candidate-owned résumé record: the generic REST, CLI and MCP surfaces
  // scope every read and write to the verified workspace subject
  // (scoped-resource-crud.ts); see docs/surface-parity.md.
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped()
export class EducationTag extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text', required: true })
  educationId = '';
  @crossPackageRef('@happyvertical/smrt-tags:Tag', {
    idType: 'text',
    required: true,
    validate: true,
  })
  tagId = '';
  @field({ type: 'text', required: true })
  tagRole = 'skill';
}
