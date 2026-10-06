import type { PrincipalRun } from '@happyvertical/smrt-agents';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import {
  assertJobTenantMatchesRuntimeWorkspaceSubject,
  captureRuntimeWorkspaceSubject,
  type RuntimeWorkspaceSubject,
  requireActiveRunnerExecutionContext,
  runAsRevalidatedJobWorkspaceSubject,
  runtimeWorkspaceSubjectFromJobArgs,
} from './job-workspace-subject.js';
import {
  SOURCE_CRAWL_METHOD,
  SOURCE_CRAWL_QUEUE,
  SOURCE_JOB_OBJECT_TYPE,
} from './source-schedules.js';
import { isCurrentWorkspaceOperator } from './workspace-subject.js';

export type SourceCrawlWriteFence = <T>(work: () => Promise<T>) => Promise<T>;

/** Sources are installation catalog records, never candidate-owned CRUD. */
export function requireSourceCrawlOperator(): void {
  if (!isCurrentWorkspaceOperator()) {
    throw new Error('Source crawls require an active installation operator.');
  }
}

export function captureSourceCrawlOperator(): RuntimeWorkspaceSubject {
  requireSourceCrawlOperator();
  return captureRuntimeWorkspaceSubject();
}

export async function assertSourceCrawlOperations(
  run: PrincipalRun,
): Promise<void> {
  for (const collection of ['sources', 'opportunities', 'companies']) {
    for (const action of ['read', 'create', 'update']) {
      await run.assertOperation(collection, action);
    }
  }
  await run.assertOperation('sourcecrawls', 'read');
  await run.assertOperation('sourcecrawlitems', 'read');
}

/** A fresh native scope at every write fence observes identity/role revocation. */
export async function runAsSourceCrawlOperator<T>(
  args: Record<string, unknown>,
  context: JobExecutionContext,
  work: (
    subject: RuntimeWorkspaceSubject,
    writeFence: SourceCrawlWriteFence,
  ) => Promise<T>,
): Promise<T> {
  const runner = requireActiveRunnerExecutionContext(context);
  if (
    runner.job.queue !== SOURCE_CRAWL_QUEUE ||
    runner.job.objectType !== SOURCE_JOB_OBJECT_TYPE ||
    runner.job.method !== SOURCE_CRAWL_METHOD
  ) {
    throw new Error(
      'Source crawl requires its dedicated source-crawls runner dispatch.',
    );
  }
  const subject = runtimeWorkspaceSubjectFromJobArgs(args);
  assertJobTenantMatchesRuntimeWorkspaceSubject(runner.job, subject);
  const writeFence: SourceCrawlWriteFence = async (write) =>
    await runAsRevalidatedJobWorkspaceSubject(
      subject,
      'audit.record',
      async (_fresh, run) => {
        requireSourceCrawlOperator();
        await assertSourceCrawlOperations(run);
        return await write();
      },
    );
  return await writeFence(async () => await work(subject, writeFence));
}
