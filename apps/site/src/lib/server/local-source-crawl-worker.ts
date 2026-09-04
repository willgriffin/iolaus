import { createTaskRunner, type TaskRunner } from '@happyvertical/smrt-jobs';
import { getLocalApplicationRuntime } from './application-runtime.js';
import { SOURCE_CRAWL_QUEUE } from './source-schedules.js';

type LocalRuntime = Pick<
  Awaited<ReturnType<typeof getLocalApplicationRuntime>>,
  'db'
>;

export interface LocalSourceCrawlWorkerDependencies {
  createRunner?: (input: {
    concurrency: number;
    pollInterval: number;
    queues: string[];
    retention: false;
  }) => Pick<TaskRunner, 'initialize' | 'start'>;
  getRuntime?: () => Promise<LocalRuntime>;
}

let localSourceCrawlWorker: Promise<void> | undefined;

/**
 * Start one local-only worker for explicitly requested source crawls. The
 * durable queue remains the contract in every profile; hosted deployments
 * retain their separate worker topology and never call this helper.
 */
export async function ensureLocalSourceCrawlWorker(
  dependencies: LocalSourceCrawlWorkerDependencies = {},
): Promise<void> {
  if (!dependencies.createRunner && !dependencies.getRuntime) {
    localSourceCrawlWorker ??= startLocalSourceCrawlWorker();
    try {
      await localSourceCrawlWorker;
    } catch (cause) {
      localSourceCrawlWorker = undefined;
      throw cause;
    }
    return;
  }

  await startLocalSourceCrawlWorker(dependencies);
}

async function startLocalSourceCrawlWorker(
  dependencies: LocalSourceCrawlWorkerDependencies = {},
): Promise<void> {
  const runtime = await (
    dependencies.getRuntime ?? getLocalApplicationRuntime
  )();
  const runner = (dependencies.createRunner ?? createTaskRunner)({
    concurrency: 1,
    pollInterval: 250,
    queues: [SOURCE_CRAWL_QUEUE],
    retention: false,
  });
  await runner.initialize(runtime.db);
  await runner.start();
}

export function resetLocalSourceCrawlWorkerForTests(): void {
  localSourceCrawlWorker = undefined;
}
