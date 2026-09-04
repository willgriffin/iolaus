import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureLocalSourceCrawlWorker,
  resetLocalSourceCrawlWorkerForTests,
} from './local-source-crawl-worker.js';

describe('ensureLocalSourceCrawlWorker', () => {
  afterEach(() => resetLocalSourceCrawlWorkerForTests());

  it('starts a bounded source-crawl-only worker against the local runtime', async () => {
    const runner = {
      initialize: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
    };
    const database = { type: 'sqlite' };
    const getRuntime = vi.fn(async () => ({ db: database as never }));
    const createRunner = vi.fn(() => runner);

    await ensureLocalSourceCrawlWorker({ createRunner, getRuntime });

    expect(createRunner).toHaveBeenCalledWith({
      concurrency: 1,
      pollInterval: 250,
      queues: ['source-crawls'],
      retention: false,
    });
    expect(runner.initialize).toHaveBeenCalledWith(database);
    expect(runner.start).toHaveBeenCalledOnce();
  });
});
