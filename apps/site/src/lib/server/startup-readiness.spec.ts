import { describe, expect, it, vi } from 'vitest';
import {
  describeStartupFailure,
  startRuntimeThenPrime,
} from './startup-readiness';

class FakeRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly component: string,
  ) {
    super(message);
    this.name = 'DeployedRuntimeError';
  }
}

describe('startRuntimeThenPrime', () => {
  it('retries a failed runtime start with backoff, then primes once', async () => {
    const failure = new FakeRuntimeError(
      'provider_unavailable',
      'postgres://user:secret@db/app refused',
      'database',
    );
    const ensureRuntime = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue();
    const prime = vi.fn();
    const sleep = vi.fn(async (_ms: number) => {});
    const log = { info: vi.fn(), warn: vi.fn() };

    await startRuntimeThenPrime({ ensureRuntime, log, prime, sleep });

    expect(ensureRuntime).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000]);
    expect(prime).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      '[startup] runtime not ready (attempt 1, DeployedRuntimeError code=provider_unavailable component=database); retrying in 2000ms',
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(/^\[startup\] runtime ready after 3 attempt\(s\)/u),
    );
    // Messages can carry connection details; they never reach the logs.
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls]);
    expect(logged).not.toContain('secret');
  });

  it('caps the backoff delay', async () => {
    let calls = 0;
    const ensureRuntime = vi.fn(async () => {
      calls += 1;
      if (calls < 7) throw new Error('down');
    });
    const sleep = vi.fn(async (_ms: number) => {});

    await startRuntimeThenPrime({
      ensureRuntime,
      log: { info: vi.fn(), warn: vi.fn() },
      prime: vi.fn(),
      sleep,
    });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });
});

describe('describeStartupFailure', () => {
  it('keeps only the error class, code and component', () => {
    expect(describeStartupFailure(new TypeError('secret detail'))).toBe(
      'TypeError',
    );
    expect(describeStartupFailure('boom')).toBe('non-error rejection');
  });
});
