import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkApplicationRuntimeReadiness: vi.fn(),
  isPublishedResumePrimeSettled: vi.fn(),
  startPublishedResumePrime: vi.fn(),
  getCachedPublishedResume: vi.fn(),
}));

vi.mock('$lib/server/application-runtime', () => ({
  checkApplicationRuntimeReadiness: mocks.checkApplicationRuntimeReadiness,
}));

vi.mock('$lib/server/resume-prime', () => ({
  isPublishedResumePrimeSettled: mocks.isPublishedResumePrimeSettled,
  startPublishedResumePrime: mocks.startPublishedResumePrime,
}));

vi.mock('$lib/server/resume-data', () => ({
  getCachedPublishedResume: mocks.getCachedPublishedResume,
}));

import { GET } from './+server';

async function health() {
  return await GET({} as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
  mocks.isPublishedResumePrimeSettled.mockReset();
  mocks.startPublishedResumePrime.mockReset();
  mocks.checkApplicationRuntimeReadiness.mockReset();
  mocks.checkApplicationRuntimeReadiness.mockResolvedValue(true);
});

describe('health route', () => {
  it('reports not ready while the resume prime is still running', async () => {
    mocks.isPublishedResumePrimeSettled.mockReturnValue(false);

    const response = await health();

    // Kubernetes takes the replica out of the load balancer, so no public
    // request pays the cold read plan.
    expect(response.status).toBe(503);
    expect(mocks.startPublishedResumePrime).toHaveBeenCalledTimes(1);
    // The body must not claim ok on a probe failure — an operator reads this.
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      resume: 'priming',
    });
  });

  it('reports ready once the prime has settled', async () => {
    mocks.isPublishedResumePrimeSettled.mockReturnValue(true);

    const response = await health();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      resume: 'ready',
    });
  });

  it('drains on a bounded deployed dependency readiness failure', async () => {
    mocks.isPublishedResumePrimeSettled.mockReturnValue(true);
    mocks.checkApplicationRuntimeReadiness.mockResolvedValue(false);

    const response = await health();

    expect(response.status).toBe(503);
    expect(mocks.startPublishedResumePrime).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      runtime: 'unavailable',
    });
  });

  it('recovers an unstarted stalled prime on its deadline after runtime readiness succeeds', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    Reflect.deleteProperty(
      globalThis,
      Symbol.for('iolaus.published-resume-prime.v1'),
    );
    vi.doUnmock('$lib/server/resume-prime');
    mocks.getCachedPublishedResume.mockReturnValue(new Promise(() => {}));
    try {
      const { GET: recoveredGET } = await import('./+server');
      const probe = () =>
        recoveredGET({} as unknown as Parameters<typeof GET>[0]);
      mocks.checkApplicationRuntimeReadiness.mockResolvedValueOnce(false);

      expect((await probe()).status).toBe(503);
      expect(mocks.getCachedPublishedResume).not.toHaveBeenCalled();
      expect((await probe()).status).toBe(503);
      expect(mocks.getCachedPublishedResume).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(19_999);
      expect((await probe()).status).toBe(503);
      await vi.advanceTimersByTimeAsync(1);
      const recovered = await probe();
      expect(recovered.status).toBe(200);
      expect(mocks.getCachedPublishedResume).toHaveBeenCalledTimes(1);
      await expect(recovered.json()).resolves.toMatchObject({
        ok: true,
        resume: 'ready',
        runtime: 'ready',
      });
    } finally {
      vi.useRealTimers();
      vi.doMock('$lib/server/resume-prime', () => ({
        isPublishedResumePrimeSettled: mocks.isPublishedResumePrimeSettled,
        startPublishedResumePrime: mocks.startPublishedResumePrime,
      }));
      Reflect.deleteProperty(
        globalThis,
        Symbol.for('iolaus.published-resume-prime.v1'),
      );
    }
  });
});
