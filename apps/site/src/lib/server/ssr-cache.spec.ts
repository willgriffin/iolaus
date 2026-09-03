import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStampedCache } from './ssr-cache';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function harness(overrides: { stampTtlMs?: number; staleTtlMs?: number } = {}) {
  const loader = vi.fn(async () => ({ payload: loader.mock.calls.length }));
  const loadStamp = vi.fn(async () => 'stamp-1');
  const cache = createStampedCache({
    loadStamp,
    loader,
    stampTtlMs: overrides.stampTtlMs ?? 5_000,
    staleTtlMs: overrides.staleTtlMs ?? 60_000,
  });
  return { cache, loadStamp, loader };
}

describe('createStampedCache', () => {
  it('serves repeat reads inside the stamp window without touching the database', async () => {
    const { cache, loadStamp, loader } = harness();

    await cache.get();
    expect(loadStamp).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);

    await cache.get();
    await cache.get();

    expect(loadStamp).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('rechecks the stamp after the window but skips the loader when it matches', async () => {
    const { cache, loadStamp, loader } = harness({ stampTtlMs: 5_000 });

    const first = await cache.get();
    vi.advanceTimersByTime(5_001);
    const second = await cache.get();

    expect(loadStamp).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(second.value).toBe(first.value);
  });

  it('reloads when the stamp changes', async () => {
    const { cache, loadStamp, loader } = harness({ stampTtlMs: 5_000 });

    const first = await cache.get();
    loadStamp.mockResolvedValue('stamp-2');
    vi.advanceTimersByTime(5_001);
    const second = await cache.get();

    expect(loader).toHaveBeenCalledTimes(2);
    expect(second.value).not.toBe(first.value);
    expect(second.stamp).toBe('stamp-2');
  });

  it('coalesces concurrent misses into one load', async () => {
    const { cache, loadStamp, loader } = harness();

    const [a, b, c] = await Promise.all([
      cache.get(),
      cache.get(),
      cache.get(),
    ]);

    expect(loadStamp).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(a.value).toBe(b.value);
    expect(b.value).toBe(c.value);
  });

  it('coalesces concurrent stamp rechecks', async () => {
    const { cache, loadStamp, loader } = harness({ stampTtlMs: 5_000 });

    await cache.get();
    vi.advanceTimersByTime(5_001);
    await Promise.all([cache.get(), cache.get(), cache.get()]);

    expect(loadStamp).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves the cached payload while the stamp probe is failing', async () => {
    const { cache, loader, loadStamp } = harness({
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = await cache.get();
    loadStamp.mockRejectedValue(new Error('database unavailable'));
    vi.advanceTimersByTime(5_001);
    const second = await cache.get();

    expect(second.value).toBe(first.value);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('grants a long-lived entry the full stale window when the probe starts failing', async () => {
    // The production steady state: an entry loaded hours ago whose stamp has
    // matched ever since. Anchoring the stale window to load time would give it
    // no grace at all and turn the first probe failure into a 500.
    const { cache, loader, loadStamp } = harness({
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = await cache.get();
    for (let i = 0; i < 100; i += 1) {
      vi.advanceTimersByTime(5_001);
      await cache.get();
    }
    expect(loader).toHaveBeenCalledTimes(1);

    loadStamp.mockRejectedValue(new Error('database unavailable'));
    vi.advanceTimersByTime(5_001);

    await expect(cache.get()).resolves.toMatchObject({ value: first.value });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('measures the stale window from the last verification, not the last load', async () => {
    const { cache, loader, loadStamp } = harness({
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    await cache.get();
    // Verified repeatedly across well beyond one stale window.
    for (let i = 0; i < 30; i += 1) {
      vi.advanceTimersByTime(5_001);
      await cache.get();
    }

    loadStamp.mockRejectedValue(new Error('database unavailable'));
    vi.advanceTimersByTime(30_000);
    await cache.get();
    expect(loader).toHaveBeenCalledTimes(1);

    // ...but the grace still expires relative to that last good verification.
    vi.advanceTimersByTime(40_000);
    await cache.get();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not let a failing probe extend its own stale window', async () => {
    const { cache, loader, loadStamp } = harness({
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    await cache.get();
    loadStamp.mockRejectedValue(new Error('database unavailable'));

    // Repeated failed probes must not keep renewing the grace period.
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(5_001);
      await cache.get().catch(() => undefined);
    }

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('stops serving stale data once the stale window closes', async () => {
    const { cache, loader, loadStamp } = harness({
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    await cache.get();
    loadStamp.mockRejectedValue(new Error('database unavailable'));
    vi.advanceTimersByTime(60_001);

    await cache.get();

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('serves a recently verified payload when the reload itself fails', async () => {
    // The stamp moved, so we know this payload is behind — but stale by seconds
    // beats a 500, and the probe-failure branch already makes that trade from a
    // worse information state.
    const { cache, loadStamp, loader } = harness({
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = await cache.get();
    loadStamp.mockResolvedValue('stamp-2');
    loader.mockRejectedValue(new Error('database unavailable'));
    vi.advanceTimersByTime(5_001);

    await expect(cache.get()).resolves.toMatchObject({ value: first.value });
  });

  it('does not let a failed reload renew its own grace period', async () => {
    const { cache, loadStamp, loader } = harness({
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    await cache.get();
    loadStamp.mockResolvedValue('stamp-2');
    loader.mockRejectedValue(new Error('database unavailable'));

    vi.advanceTimersByTime(30_000);
    await expect(cache.get()).resolves.toBeDefined();

    // Past the window measured from the last good verification, the failure
    // must surface rather than serving unbounded stale content.
    vi.advanceTimersByTime(40_000);
    await expect(cache.get()).rejects.toThrow('database unavailable');
  });

  it('surfaces loader failures instead of caching them', async () => {
    const { cache, loader } = harness();
    loader.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(cache.get()).rejects.toThrow('database unavailable');

    loader.mockResolvedValueOnce({ payload: 99 });
    await expect(cache.get()).resolves.toMatchObject({
      stamp: 'stamp-1',
      value: { payload: 99 },
    });
  });

  it('reloads immediately after invalidate', async () => {
    const { cache, loader } = harness();

    await cache.get();
    cache.invalidate();
    await cache.get();

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keeps partitions isolated by key', async () => {
    let key = 'a';
    const loader = vi.fn(async () => ({ key }));
    const loadStamp = vi.fn(async () => `stamp-${key}`);
    const cache = createStampedCache({
      getKey: () => key,
      loadStamp,
      loader,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = await cache.get();
    key = 'b';
    const second = await cache.get();
    key = 'a';
    const third = await cache.get();

    expect(first.value).toEqual({ key: 'a' });
    expect(second.value).toEqual({ key: 'b' });
    expect(third.value).toBe(first.value);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache entirely when the key cannot be resolved', async () => {
    const loader = vi.fn(async () => ({ payload: 1 }));
    const loadStamp = vi.fn(async () => 'stamp-1');
    const cache = createStampedCache({
      getKey: () => undefined,
      loadStamp,
      loader,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = await cache.get();
    const second = await cache.get();

    expect(first.stamp).toBeNull();
    expect(second.stamp).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loadStamp).not.toHaveBeenCalled();
  });

  it('does not wedge every reader when the stamp probe hangs instead of failing', async () => {
    // A blackholed connection stalls rather than rejects. Unbounded, the shared
    // in-flight refresh would never settle and every later request would await
    // that same dead promise forever, with no eviction path.
    const loader = vi.fn(async () => ({ payload: 1 }));
    const loadStamp = vi.fn(() => new Promise<string>(() => {}));
    const cache = createStampedCache({
      loadStamp,
      loader,
      stampTimeoutMs: 2_000,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const pending = cache.get();
    await vi.advanceTimersByTimeAsync(2_001);

    await expect(pending).resolves.toMatchObject({ stamp: null });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves the cached payload when a later stamp probe hangs', async () => {
    const loader = vi.fn(async () => ({ payload: 1 }));
    const loadStamp = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('stamp-1')
      .mockImplementation(() => new Promise<string>(() => {}));
    const cache = createStampedCache({
      loadStamp,
      loader,
      stampTimeoutMs: 2_000,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = await cache.get();
    vi.advanceTimersByTime(5_001);
    const pending = cache.get();
    await vi.advanceTimersByTimeAsync(2_001);

    await expect(pending).resolves.toMatchObject({ value: first.value });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('fails fast while a hung loader is still pending, then recovers when it settles', async () => {
    let releaseFirst: (value: { payload: number }) => void = () => {};
    const loader = vi
      .fn<() => Promise<{ payload: number }>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue({ payload: 2 });
    const cache = createStampedCache({
      loadStamp: async () => 'stamp-1',
      loader,
      loaderTimeoutMs: 3_000,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const pending = expect(cache.get()).rejects.toThrow(/exceeded/);
    await vi.advanceTimersByTimeAsync(3_001);
    await pending;

    // The first call is still outstanding, so a retry must not stack another
    // query on top of it — it fails immediately instead.
    await expect(cache.get()).rejects.toThrow(/still pending/);
    expect(loader).toHaveBeenCalledTimes(1);

    // Once it settles the gate reopens and the next read loads normally.
    releaseFirst({ payload: 1 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(cache.get()).resolves.toMatchObject({ value: { payload: 2 } });
  });

  it('reports a content hash computed once per load, not per read', async () => {
    const hashValue = vi.fn(
      (value: { payload: number }) => `h${value.payload}`,
    );
    const loader = vi.fn(async () => ({ payload: 1 }));
    const cache = createStampedCache({
      hashValue,
      loadStamp: async () => 'stamp-1',
      loader,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = await cache.get();
    const second = await cache.get();

    expect(first.contentHash).toBe('h1');
    expect(second.contentHash).toBe('h1');
    expect(hashValue).toHaveBeenCalledTimes(1);
  });

  it('rehashes when the payload is reloaded', async () => {
    let payload = 1;
    const loadStamp = vi.fn(async () => `stamp-${payload}`);
    const cache = createStampedCache({
      hashValue: (value: { payload: number }) => `h${value.payload}`,
      loadStamp,
      loader: async () => ({ payload }),
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    expect((await cache.get()).contentHash).toBe('h1');
    payload = 2;
    vi.advanceTimersByTime(5_001);
    expect((await cache.get()).contentHash).toBe('h2');
  });

  it('reports a null content hash when no hash function is supplied', async () => {
    const { cache } = harness();
    expect((await cache.get()).contentHash).toBeNull();
  });

  it('never has more than one stamp query outstanding', async () => {
    // A timeout unblocks the caller but cannot cancel the query underneath.
    // Ungated, each window would stack another call on a hung one until the pool
    // gave out.
    let started = 0;
    let settled = 0;
    const loadStamp = vi.fn(() => {
      started += 1;
      return new Promise<string>(() => {});
    });
    const cache = createStampedCache({
      loadStamp,
      loader: async () => ({ payload: 1 }),
      stampTimeoutMs: 2_000,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = cache.get();
    await vi.advanceTimersByTimeAsync(2_001);
    await first;

    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(5_001);
      await cache.get().catch(() => {
        settled += 1;
      });
    }

    expect(started).toBe(1);
    expect(settled).toBe(0);
  });

  it('reissues the stamp query once the previous one settles', async () => {
    let resolveStamp: (value: string) => void = () => {};
    const loadStamp = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveStamp = resolve;
          }),
      )
      .mockResolvedValue('stamp-2');
    const cache = createStampedCache({
      loadStamp,
      loader: async () => ({ payload: 1 }),
      stampTimeoutMs: 2_000,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = cache.get();
    await vi.advanceTimersByTimeAsync(2_001);
    await first;

    // The hung call finishes; the gate must reopen.
    resolveStamp('stamp-1');
    await vi.advanceTimersByTimeAsync(5_001);
    await cache.get();

    expect(loadStamp).toHaveBeenCalledTimes(2);
  });

  it('never has more than one payload load outstanding', async () => {
    let started = 0;
    const loader = vi.fn(() => {
      started += 1;
      return new Promise<{ payload: number }>(() => {});
    });
    const cache = createStampedCache({
      loadStamp: async () => 'stamp-1',
      loader,
      loaderTimeoutMs: 3_000,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    for (let i = 0; i < 5; i += 1) {
      const pending = cache.get().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(3_001);
      await pending;
      await vi.advanceTimersByTimeAsync(5_001);
    }

    expect(started).toBe(1);
  });

  it('gates per partition, so one stuck database cannot block another', async () => {
    // The gate exists to stop a hung connection stacking queries. It must not
    // do that across partitions: partitions address different databases and
    // tenants, so a stuck one must not stall a healthy one.
    let key = 'stuck';
    const loadStamp = vi.fn((): Promise<string> => {
      if (key === 'stuck') return new Promise<string>(() => {});
      return Promise.resolve('stamp-healthy');
    });
    const loader = vi.fn(async () => ({ key }));
    const cache = createStampedCache({
      getKey: () => key,
      loadStamp,
      loader,
      stampTimeoutMs: 2_000,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    // Wedge the first partition.
    const stuck = cache.get();
    await vi.advanceTimersByTimeAsync(2_001);
    await stuck;

    // The other partition must still work, repeatedly, while that one hangs.
    key = 'healthy';
    for (let i = 0; i < 3; i += 1) {
      await expect(cache.get()).resolves.toMatchObject({
        stamp: 'stamp-healthy',
        value: { key: 'healthy' },
      });
      await vi.advanceTimersByTimeAsync(5_001);
    }
  });

  it('keeps a partition with work outstanding out of the idle sweep', async () => {
    const loadStamp = vi.fn(() => new Promise<string>(() => {}));
    const cache = createStampedCache({
      idleTtlMs: 1_000,
      loadStamp,
      loader: async () => ({ payload: 1 }),
      stampTimeoutMs: 2_000,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    const first = cache.get();
    await vi.advanceTimersByTimeAsync(2_001);
    await first;

    // Pruning the entry would drop the pending flag and let the gate reopen
    // against a query that is still outstanding.
    await vi.advanceTimersByTimeAsync(1_001);
    await cache.get();

    expect(loadStamp).toHaveBeenCalledTimes(1);
  });

  it('drops idle partitions so per-tenant entries cannot grow without bound', async () => {
    const loader = vi.fn(async () => ({ payload: 1 }));
    const cache = createStampedCache({
      idleTtlMs: 1_000,
      loadStamp: async () => 'stamp-1',
      loader,
      stampTtlMs: 5_000,
      staleTtlMs: 60_000,
    });

    await cache.get();
    vi.advanceTimersByTime(1_001);
    await cache.get();

    expect(loader).toHaveBeenCalledTimes(2);
  });
});
