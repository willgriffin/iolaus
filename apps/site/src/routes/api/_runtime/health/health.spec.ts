import { describe, expect, it, vi } from 'vitest';

const ready = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/application-runtime', () => ({
  applicationRuntime: { profile: 'local' },
  applicationRuntimeConfiguration: 'test-configuration',
  ensureApplicationRuntimeReady: ready,
}));
vi.mock('$lib/server/runtime-paths', () => ({
  getIolausSourceRoot: () => `${process.cwd()}/../..`,
  IOLAUS_APPLICATION_ID: 'iolaus',
}));

import { GET } from './+server';

describe('local desktop readiness', () => {
  it('refuses health until local initialization succeeds', async () => {
    ready.mockRejectedValueOnce(new Error('private database error'));
    const response = await GET({} as Parameters<typeof GET>[0]);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private database error');
  });
  it('reports ready only after the local runtime is initialized', async () => {
    ready.mockResolvedValueOnce(undefined);
    const response = await GET({} as Parameters<typeof GET>[0]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ready',
      application: 'iolaus',
    });
  });
});
