import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkApplicationRuntimeReadiness: vi.fn(),
  isPublishedResumePrimeSettled: vi.fn(),
}));

vi.mock('$lib/server/application-runtime', () => ({
  checkApplicationRuntimeReadiness: mocks.checkApplicationRuntimeReadiness,
}));

vi.mock('$lib/server/resume-prime', () => ({
  isPublishedResumePrimeSettled: mocks.isPublishedResumePrimeSettled,
}));

import { GET } from './+server';

async function health() {
  return await GET({} as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
  mocks.isPublishedResumePrimeSettled.mockReset();
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
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      runtime: 'unavailable',
    });
  });
});
