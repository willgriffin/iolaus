import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** Nonexpiring evidence that a private source write may still be unsettled.
 * Deleted only after fully accepted receive, or documented operator quiescence.
 * Never expose through generated surfaces; locators are private recovery data.
 */
@smrt({
  tableName: 'resume_import_write_operations',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class ResumeImportWriteOperation extends SmrtObject {
  @field({ type: 'text' })
  tenantId = '';
  @field({ type: 'text' })
  userId = '';
  @field({ type: 'text' })
  profileId = '';
  @field({ type: 'text' })
  sourceId = '';
  @field({ type: 'text' })
  deliveryKey = '';
}
