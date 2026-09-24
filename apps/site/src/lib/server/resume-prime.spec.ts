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

describe('startPublishedResumePrime logging (#100)', () => {
  it('logs the outcome and duration of a successful prime', async () => {
    mocks.getCachedPublishedResume.mockResolvedValue(undefined);
    const log = { info: vi.fn() };

    const prime = await freshPrime();
    prime.startPublishedResumePrime(20_000, log);

    await vi.waitFor(() =>
      expect(prime.isPublishedResumePrimeSettled()).toBe(true),
    );
    expect(log.info).toHaveBeenCalledWith('[startup] resume prime started');
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[startup\] resume prime settled: loaded in \d+ms$/u,
      ),
    );
  });

  it('logs a failed prime by error class only', async () => {
    mocks.getCachedPublishedResume.mockRejectedValue(
      new TypeError('postgres://user:secret@db refused'),
    );
    const log = { info: vi.fn() };

    const prime = await freshPrime();
    prime.startPublishedResumePrime(20_000, log);

    await vi.waitFor(() =>
      expect(prime.isPublishedResumePrimeSettled()).toBe(true),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[startup\] resume prime settled: failed \(TypeError\) in \d+ms$/u,
      ),
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('secret');
  });

  it('logs when the deadline settles a stalled prime, exactly once', async () => {
    mocks.getCachedPublishedResume.mockReturnValue(new Promise(() => {}));
    const log = { info: vi.fn() };

    const prime = await freshPrime();
    prime.startPublishedResumePrime(5, log);

    await vi.waitFor(() =>
      expect(prime.isPublishedResumePrimeSettled()).toBe(true),
    );
    const settled = log.info.mock.calls.filter(([line]) =>
      String(line).includes('settled'),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.[0]).toMatch(
      /settled: deadline \(5ms, load continues\)/u,
    );
  });
});
