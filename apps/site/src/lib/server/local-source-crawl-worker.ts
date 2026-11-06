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
  }) => Pick<TaskRunner, 'initialize' | 'start' | 'stop'>;
  getRuntime?: () => Promise<LocalRuntime>;
}

let localSourceCrawlWorker: Promise<void> | undefined;

/**
 * Start one local-only worker for the durable source crawl queue. Manual
 * enqueue and enabled local startup share this worker for the process.
 */
export async function ensureLocalSourceCrawlWorker(
  dependencies: LocalSourceCrawlWorkerDependencies = {},
): Promise<void> {
  if (!dependencies.createRunner && !dependencies.getRuntime) {
    localSourceCrawlWorker ??= startManagedLocalSourceCrawlWorker();
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

async function startManagedLocalSourceCrawlWorker(): Promise<void> {
  const startup = startLocalSourceCrawlWorker();
  const stop = () => {
    void startup
      .then(
        (runner) => runner.stop(),
        () => undefined,
      )
      .catch(() => console.warn('Local source crawl worker failed to stop.'));
  };
  process.once('sveltekit:shutdown', stop);
  try {
    await startup;
  } catch (cause) {
    process.off('sveltekit:shutdown', stop);
    throw cause;
  }
}

async function startLocalSourceCrawlWorker(
  dependencies: LocalSourceCrawlWorkerDependencies = {},
) {
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
  return runner;
}

export function resetLocalSourceCrawlWorkerForTests(): void {
  localSourceCrawlWorker = undefined;
}
