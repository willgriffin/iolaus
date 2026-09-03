import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPublishedResumePrimeSettled: vi.fn(),
}));

vi.mock('$lib/server/resume-prime', () => ({
  isPublishedResumePrimeSettled: mocks.isPublishedResumePrimeSettled,
}));

import { GET } from './+server';

function health() {
  return GET({} as unknown as Parameters<typeof GET>[0]) as Response;
}

beforeEach(() => {
  mocks.isPublishedResumePrimeSettled.mockReset();
});

describe('health route', () => {
  it('reports not ready while the resume prime is still running', async () => {
    mocks.isPublishedResumePrimeSettled.mockReturnValue(false);

    const response = health();

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

    const response = health();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      resume: 'ready',
    });
  });
});
