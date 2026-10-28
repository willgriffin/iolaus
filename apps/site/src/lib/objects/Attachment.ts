import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  tableName: 'attachments',
  // Candidate-owned résumé record: the generic REST, CLI and MCP surfaces
  // scope every read and write to the verified workspace subject
  // (scoped-resource-crud.ts); see docs/surface-parity.md.
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped()
export class Attachment extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text', required: true }) ownerUserId = '';
  @field({ type: 'text', required: true }) candidateProfileId = '';
  @field({ type: 'text' })
  filePath = '';
  @field({ type: 'text' })
  kind = 'document';
  @field({ type: 'text' })
  title = '';
  @field({ type: 'text' })
  caption = '';
  @field({ type: 'text' })
  altText = '';
  @field({ type: 'text' })
  mimeType = '';
  @field({ type: 'decimal', nullable: true })
  width: number | null = null;
  @field({ type: 'decimal', nullable: true })
  height: number | null = null;
  @field({ type: 'text' })
  sourceUrl = '';
  @field({ type: 'text' })
  visibility = 'private';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
