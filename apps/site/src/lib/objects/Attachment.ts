import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'attachments',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class Attachment extends SmrtObject {
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
