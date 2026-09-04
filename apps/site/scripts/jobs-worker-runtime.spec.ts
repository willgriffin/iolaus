import { describe, expect, it, vi } from 'vitest';
import { startTaskWorker } from './jobs-worker-runtime.js';

describe('task worker startup', () => {
  it('starts only the task claim loop; schedule polling is a separate workload', async () => {
    const start = vi.fn().mockResolvedValue(undefined);

    await startTaskWorker({ start });

    expect(start).toHaveBeenCalledOnce();
  });
});
