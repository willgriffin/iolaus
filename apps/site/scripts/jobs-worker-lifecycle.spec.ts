import { describe, expect, it } from 'vitest';
import { drainJobWorkerRunners } from './jobs-worker-lifecycle.js';

describe('SIGTERM worker drain', () => {
  it('waits for an active task before allowing the entrypoint to exit', async () => {
    let finishActiveTask: (() => void) | undefined;
    const activeTask = new Promise<void>((resolve) => {
      finishActiveTask = resolve;
    });
    let taskStopCalled = false;
    let scheduleStopCalled = false;
    const draining = drainJobWorkerRunners({
      taskRunner: {
        stop: async () => {
          taskStopCalled = true;
          await activeTask;
        },
      },
      scheduleRunner: {
        stop: async () => {
          scheduleStopCalled = true;
        },
      },
    });

    await Promise.resolve();
    expect(taskStopCalled).toBe(true);
    expect(scheduleStopCalled).toBe(true);
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishActiveTask?.();
    await expect(draining).resolves.toBeUndefined();
    expect(drained).toBe(true);
  });
});
