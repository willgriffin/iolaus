import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCachedPublishedResume: vi.fn(),
}));

vi.mock('./resume-data', () => ({
  getCachedPublishedResume: mocks.getCachedPublishedResume,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.getCachedPublishedResume.mockReset();
});

async function freshPrime() {
  return import('./resume-prime');
}

describe('startPublishedResumePrime', () => {
  it('is not settled before the warm load finishes', async () => {
    let release: () => void = () => {};
    mocks.getCachedPublishedResume.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const prime = await freshPrime();
    prime.startPublishedResumePrime();

    expect(prime.isPublishedResumePrimeSettled()).toBe(false);

    release();
    await vi.waitFor(() =>
      expect(prime.isPublishedResumePrimeSettled()).toBe(true),
    );
  });

  it('warms the cache exactly once no matter how often it is called', async () => {
    mocks.getCachedPublishedResume.mockResolvedValue({
      stamp: 'stamp-1',
      value: {},
    });

    const prime = await freshPrime();
    prime.startPublishedResumePrime();
    prime.startPublishedResumePrime();
    prime.startPublishedResumePrime();

    expect(mocks.getCachedPublishedResume).toHaveBeenCalledTimes(1);
  });

  it('settles on a deadline when the boot load hangs instead of failing', async () => {
    // Otherwise /health returns 503 forever, and because that path is also the
    // liveness probe, kubelet restarts the pod into a crash loop.
    vi.useFakeTimers();
    mocks.getCachedPublishedResume.mockReturnValue(new Promise(() => {}));

    const prime = await freshPrime();
    prime.startPublishedResumePrime(20_000);

    expect(prime.isPublishedResumePrimeSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(20_001);

    expect(prime.isPublishedResumePrimeSettled()).toBe(true);
    vi.useRealTimers();
  });

  it('settles even when the database is unreachable at boot', async () => {
    // Otherwise the readiness probe would never pass and the liveness probe
    // sharing that path would crash-loop the pod.
    mocks.getCachedPublishedResume.mockRejectedValue(
      new Error('database unavailable'),
    );

    const prime = await freshPrime();
    prime.startPublishedResumePrime();

    await vi.waitFor(() =>
      expect(prime.isPublishedResumePrimeSettled()).toBe(true),
    );
  });
});
