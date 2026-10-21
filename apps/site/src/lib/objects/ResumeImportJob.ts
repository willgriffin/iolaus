import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  backgroundEligible,
  type JobExecutionContext,
} from '@happyvertical/smrt-jobs';

@smrt({
  tableName: 'resume_import_jobs',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class ResumeImportJob extends SmrtObject {
  /** Durable ingestion dispatches carry IDs only; the runtime reloads scope. */
  @backgroundEligible()
  async process(
    args: Record<string, unknown> = {},
    context?: JobExecutionContext,
  ) {
    const { runResumeImportIngestionJob } = await import(
      '../server/resume-import-runtime.js'
    );
    return await runResumeImportIngestionJob(args, context, this._db);
  }
}
