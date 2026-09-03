/**
 * In-process caches for read-heavy / write-rare SSR data.
 *
 * `createStampedCache` keys a cached payload on a cheap database-derived version
 * stamp instead of wall-clock expiry alone. Repeated reads inside the stamp
 * window are served from memory with no database work at all; past it, one small
 * stamp query decides whether the expensive loader has to run again.
 *
 * This is what lets multiple replicas converge without cross-process messaging:
 * every pod derives the same stamp from the same rows, so a write made on one
 * replica is observed by the others on their next stamp check rather than
 * waiting out a TTL. `invalidate()` still exists to make the writing replica
 * refresh immediately.
 *
 * Concurrent reads during a refresh share one in-flight operation, so a cold or
 * newly-invalidated cache never stampedes the database. Because that shared
 * promise is what every concurrent reader awaits, both database calls are
 * bounded by a timeout: a query that stalls instead of failing would otherwise
 * wedge the entry permanently, and no reader could ever make progress again.
 */

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Bound an operation that is expected to fail fast but might not.
 *
 * A blackholed connection, an exhausted pool, or a stalled driver produces a
 * promise that never settles. Left unbounded inside the shared in-flight
 * refresh, that hangs every subsequent reader with no self-healing path.
 */
function withTimeout<T>(
  operation: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return operation();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Track whether an operation is still outstanding for one cache partition.
 *
 * A timeout unblocks the *caller*; it cannot cancel the query underneath. Left
 * ungated, every stamp window would start another database call on top of one
 * still pending, so a blackholed connection would pile up unresolved queries
 * until the pool — or the process — gave out, and would then flood the database
 * the moment connectivity returned. Bound it to one outstanding call: while the
 * previous one hangs, report unavailability immediately, which is exactly what
 * the caller already knows how to degrade through.
 *
 * The gate is per partition, never per cache. Partitions address different
 * databases and tenants, so one stuck connection must not stop a healthy
 * partition from making progress — that would trade a local failure for a
 * process-wide one.
 */
async function runGated<T, K extends string, E extends Record<K, boolean>>(
  entry: E,
  field: K,
  operation: () => Promise<T>,
  label: string,
): Promise<T> {
  if (entry[field]) throw new Error(`${label} still pending; not reissued`);
  entry[field] = true as E[K];
  try {
    return await operation();
  } finally {
    entry[field] = false as E[K];
  }
}

export interface StampedResult<T> {
  /**
   * Digest of the payload actually being returned, when a hash function was
   * supplied. Unlike the stamp, this cannot disagree with the bytes it labels:
   * the stamp is read before the payload load, so a write landing between the
   * two would file fresh content under the previous stamp. Anything that must
   * identify a *representation* — an HTTP validator above all — has to key off
   * this, not the stamp.
   */
  contentHash: string | null;
  stamp: string | null;
  value: T;
}

export interface StampedCache<T> {
  get(): Promise<StampedResult<T>>;
  invalidate(): void;
}

export interface StampedCacheOptions<T> {
  /**
   * Cache partition key, or `undefined` to bypass the cache entirely (used when
   * the database identity cannot be established and reuse would be unsafe).
   */
  getKey?: () => string | undefined;
  /** Optional payload digest, computed once per load rather than per read. */
  hashValue?: (value: T) => string;
  /** Drop idle partitions after this long so per-tenant entries cannot grow without bound. */
  idleTtlMs?: number;
  /** Cheap version probe. Rejections degrade to `staleTtlMs`, never to an error. */
  loadStamp: () => Promise<string>;
  /** Expensive payload load, run only when the stamp changes. */
  loader: () => Promise<T>;
  /** Bound on the payload load. Exceeding it rejects rather than wedging readers. */
  loaderTimeoutMs?: number;
  /** Bound on the stamp probe. Exceeding it is treated as a probe failure. */
  stampTimeoutMs?: number;
  /** How long a verified stamp is trusted before it is re-checked. */
  stampTtlMs: number;
  /**
   * How long a cached payload may keep being served after the stamp probe starts
   * failing, measured from its last successful verification.
   */
  staleTtlMs: number;
}

const DEFAULT_IDLE_TTL_MS = 600_000;

/**
 * Elapsed time must come from a monotonic source, not the wall clock.
 *
 * An NTP step correction backwards makes `Date.now()` subtraction go negative,
 * which reads as "no time has passed" and suppresses stamp probes until the
 * clock catches up — silently stretching staleness by the size of the jump.
 */
function monotonicNow(): number {
  return performance.now();
}
const STAMP_FAILURE_LOG_INTERVAL_MS = 60_000;

let lastStampFailureLogAt = Number.NEGATIVE_INFINITY;

function reportStampFailure(error: unknown): void {
  const now = monotonicNow();
  if (now - lastStampFailureLogAt < STAMP_FAILURE_LOG_INTERVAL_MS) return;
  lastStampFailureLogAt = now;
  console.warn(
    '[ssr-cache] version stamp probe failed; serving on the stale-TTL fallback',
    error,
  );
}
const DEFAULT_STAMP_TIMEOUT_MS = 2_000;
const DEFAULT_LOADER_TIMEOUT_MS = 15_000;

export function createStampedCache<T>({
  getKey = () => 'default',
  hashValue,
  idleTtlMs = DEFAULT_IDLE_TTL_MS,
  loadStamp,
  loader,
  loaderTimeoutMs = DEFAULT_LOADER_TIMEOUT_MS,
  stampTimeoutMs = DEFAULT_STAMP_TIMEOUT_MS,
  stampTtlMs,
  staleTtlMs,
}: StampedCacheOptions<T>): StampedCache<T> {
  type CacheEntry = {
    contentHash: string | null;
    hasValue: boolean;
    inflight: Promise<StampedResult<T>> | null;
    lastAccessedAt: number;
    lastVerifiedAt: number;
    loaderPending: boolean;
    stamp: string | null;
    stampCheckedAt: number;
    stampPending: boolean;
    value: T | undefined;
  };

  const entries = new Map<string, CacheEntry>();

  function pruneIdleEntries(now: number): void {
    for (const [key, entry] of entries) {
      const busy = entry.inflight || entry.stampPending || entry.loaderPending;
      if (!busy && now - entry.lastAccessedAt >= idleTtlMs) entries.delete(key);
    }
  }

  function settled(entry: CacheEntry): StampedResult<T> {
    return {
      contentHash: entry.contentHash,
      stamp: entry.stamp,
      value: entry.value as T,
    };
  }

  async function probeStamp(entry: CacheEntry): Promise<string | null> {
    try {
      return await withTimeout(
        () => runGated(entry, 'stampPending', loadStamp, 'stamp probe'),
        stampTimeoutMs,
        'stamp probe',
      );
    } catch (error) {
      // A failing or stalled stamp probe must not take the page down. The caller
      // falls back to serving the cached payload within `staleTtlMs`, or to a
      // full reload.
      //
      // Say so, though. A *permanent* probe failure — schema drift, a dropped
      // column, revoked permissions — silently downgrades this to the wall-clock
      // TTL cache it replaced, stretching cross-replica convergence from seconds
      // to the full stale window. Callers keep serving correct content and
      // (because the validator comes from the payload, not the stamp) correct
      // validators, so this log is the only outward sign it happened.
      reportStampFailure(error);
      return null;
    }
  }

  async function refresh(entry: CacheEntry): Promise<StampedResult<T>> {
    const stamp = await probeStamp(entry);
    const checkedAt = monotonicNow();

    if (entry.hasValue) {
      if (stamp !== null && stamp === entry.stamp) {
        entry.stampCheckedAt = checkedAt;
        entry.lastVerifiedAt = checkedAt;
        return settled(entry);
      }
      if (stamp === null && checkedAt - entry.lastVerifiedAt < staleTtlMs) {
        // The probe is failing, but this payload was confirmed current recently:
        // serve it and avoid hammering a database that is already unhappy.
        //
        // The window measures time since the last *successful verification*, not
        // the payload's age. Anchoring it to load time would give a long-lived
        // entry — the steady state this cache exists to produce — no grace at
        // all, turning the first probe failure into a 500.
        entry.stampCheckedAt = checkedAt;
        return settled(entry);
      }
    }

    let value: T;
    try {
      value = await withTimeout(
        () => runGated(entry, 'loaderPending', loader, 'cache loader'),
        loaderTimeoutMs,
        'cache loader',
      );
    } catch (error) {
      // The reload failed. If this entry still holds a payload that was verified
      // current recently, serve that rather than 500 the page: stale-by-seconds
      // beats unavailable, and the probe-failure branch above already makes that
      // trade from a strictly worse information state.
      //
      // `lastVerifiedAt` is deliberately not renewed — this payload is known to
      // be behind, so every subsequent read retries until the grace runs out.
      if (
        entry.hasValue &&
        monotonicNow() - entry.lastVerifiedAt < staleTtlMs
      ) {
        entry.stampCheckedAt = monotonicNow();
        return settled(entry);
      }
      throw error;
    }
    const loadedAt = monotonicNow();
    entry.value = value;
    entry.contentHash = hashValue ? hashValue(value) : null;
    entry.hasValue = true;
    entry.stamp = stamp;
    entry.lastVerifiedAt = loadedAt;
    entry.stampCheckedAt = loadedAt;
    return settled(entry);
  }

  return {
    async get(): Promise<StampedResult<T>> {
      const now = monotonicNow();
      pruneIdleEntries(now);

      const key = getKey();
      if (key === undefined) {
        // The uncached path has no partition to gate against and no cached
        // payload to fall back on, so it runs bounded but ungated. It is reached
        // only for a live or unidentifiable database handle, which is per-request
        // and rare, so it cannot accumulate the way a polled partition would.
        const value = await withTimeout(
          loader,
          loaderTimeoutMs,
          'cache loader',
        );
        return {
          contentHash: hashValue ? hashValue(value) : null,
          stamp: null,
          value,
        };
      }

      const entry = entries.get(key) ?? {
        contentHash: null,
        hasValue: false,
        inflight: null,
        lastAccessedAt: now,
        lastVerifiedAt: 0,
        loaderPending: false,
        stamp: null,
        stampCheckedAt: 0,
        stampPending: false,
        value: undefined,
      };
      entry.lastAccessedAt = now;
      entries.set(key, entry);

      if (entry.hasValue && now - entry.stampCheckedAt < stampTtlMs)
        return settled(entry);
      if (entry.inflight) return entry.inflight;

      entry.inflight = refresh(entry).finally(() => {
        entry.inflight = null;
      });
      return entry.inflight;
    },
    invalidate() {
      entries.clear();
    },
  };
}
