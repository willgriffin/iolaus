import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  tableName: 'company_attachments',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
export class CompanyAttachment extends SmrtObject {
  @field({ type: 'text' })
  companyId = '';
  @field({ type: 'text' })
  attachmentId = '';
  @field({ type: 'text' })
  usage = 'artifact';
  @field({ type: 'decimal' })
  sortOrder = 0;
}
