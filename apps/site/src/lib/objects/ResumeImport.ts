import { SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Private operation catalogue entry for reviewed resume-import writes.
 *
 * The ingestion host performs the action through its reviewed execution
 * adapter; this non-public model exists so native permission resolution can
 * grant exactly `resumeimports.apply` without exposing private CRUD.
 */
@smrt({
  tableName: 'resume_import_operations',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class ResumeImport extends SmrtObject {
  /**
   * The reviewed ingestion execution adapter is the only caller. Generic
   * object invocation has no receipt, revision, or owner tuple to authorize.
   */
  async apply(): Promise<never> {
    throw new Error(
      'Resume imports must be applied through the reviewed ingestion workflow.',
    );
  }
}
