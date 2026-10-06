import { cronForSourceCadence, nextRunForCron } from './source-schedules.js';

/**
 * Operator-run recurring crawl for shared hosted deployments.
 *
 * Shared mode refuses unbound `Source.crawl` jobs (they need an explicit operator
 * dispatch) and no hosted runner dispatches the bound ones, so scheduled crawls
 * never run there. This selects the sources whose own cadence says they are due
 * so a Kubernetes CronJob (an explicit operator action) can crawl them in
 * bounded batches with the existing crawler, then advance each source's
 * `nextCheckAt` itself.
 */

export interface DueSourceCandidate {
  id?: string | null;
  isActive?: boolean | null;
  lastCheckedAt?: Date | string | null;
  name?: string | null;
  nextCheckAt?: Date | string | null;
  parentSourceId?: string | null;
  refreshCadence?: string | null;
  sourceRole?: string | null;
}

/** Cooldown after a failed crawl so a broken source is not retried every tick. */
export const FAILED_CRAWL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function instant(value: Date | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Active root sources with a cadence whose `nextCheckAt` has passed (or was
 * never set), most overdue first, at most `max`.
 */
export function selectDueSources<T extends DueSourceCandidate>(
  sources: readonly T[],
  now: Date,
  max: number,
): T[] {
  const limit = Math.max(0, Math.floor(max));
  const due = sources
    .filter((source) => {
      if (source.isActive !== true) return false;
      if (source.sourceRole !== 'root') return false;
      if (source.parentSourceId) return false;
      if (!cronForSourceCadence(source.refreshCadence, source)) return false;
      const next = instant(source.nextCheckAt);
      return next === null || next <= now.getTime();
    })
    .map((source) => ({
      source,
      next: instant(source.nextCheckAt) ?? Number.NEGATIVE_INFINITY,
    }));
  due.sort(
    (a, b) =>
      a.next - b.next ||
      String(a.source.id ?? '').localeCompare(String(b.source.id ?? '')),
  );
  return due.slice(0, limit).map((entry) => entry.source);
}

/** The next time a source is due after a crawl finished at `now`. */
export function nextCheckAfter(
  source: DueSourceCandidate,
  now: Date,
  failed: boolean,
): Date {
  if (failed) return new Date(now.getTime() + FAILED_CRAWL_COOLDOWN_MS);
  const cron = cronForSourceCadence(source.refreshCadence, source);
  return cron
    ? nextRunForCron(cron, now)
    : new Date(now.getTime() + FAILED_CRAWL_COOLDOWN_MS);
}

export interface CrawlableDueSource extends DueSourceCandidate {
  lastCheckedAt?: Date | string | null;
  nextCheckAt?: Date | string | null;
  save?: () => Promise<unknown>;
}

export interface CrawlDueSourceDependencies<S extends CrawlableDueSource> {
  crawl: (
    source: S,
    signal: AbortSignal,
  ) => Promise<{ candidates: number; created: number; errors: string[] }>;
  /** Fresh read of one source; the startup snapshot is never trusted. */
  get: (id: string) => Promise<S | null | undefined>;
  now?: () => Date;
  timeoutMs: number;
}

export interface CrawlDueSourceResult {
  candidates: number;
  created: number;
  outcome: 'crawled' | 'failed' | 'skipped' | 'timed-out';
}

function stillDue(source: DueSourceCandidate | null | undefined): boolean {
  return (
    Boolean(source) &&
    source?.isActive === true &&
    source.sourceRole === 'root' &&
    !source.parentSourceId
  );
}

/**
 * Crawl one due source. The source is re-read right before the crawl and again
 * before bookkeeping so an operator edit made during a long run (deactivating a
 * source, changing its cadence) is respected and never overwritten; only
 * `lastCheckedAt` and `nextCheckAt` are written.
 */
export async function crawlDueSource<S extends CrawlableDueSource>(
  id: string,
  dependencies: CrawlDueSourceDependencies<S>,
): Promise<CrawlDueSourceResult> {
  const now = dependencies.now ?? (() => new Date());
  const source = await dependencies.get(id);
  if (!source || !stillDue(source)) {
    return { candidates: 0, created: 0, outcome: 'skipped' };
  }
  let result: CrawlDueSourceResult;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Settle the race as a timeout before aborting, or the abort's own
        // rejection would win and be misreported as an ordinary failure.
        reject(new Error('timed out'));
        controller.abort();
      }, dependencies.timeoutMs);
    });
    const summary = await Promise.race([
      dependencies.crawl(source, controller.signal),
      timeout,
    ]);
    // Board reconciliation needs a verified workspace subject in shared mode and
    // is reported as an error; a crawl that still saw postings is a success.
    const failed = summary.candidates === 0 && summary.errors.length > 0;
    result = {
      candidates: summary.candidates,
      created: summary.created,
      outcome: failed ? 'failed' : 'crawled',
    };
  } catch (error) {
    result = {
      candidates: 0,
      created: 0,
      outcome:
        error instanceof Error && error.message === 'timed out'
          ? 'timed-out'
          : 'failed',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const latest = await dependencies.get(id);
  if (latest && stillDue(latest)) {
    const finished = now();
    latest.lastCheckedAt = finished;
    latest.nextCheckAt = nextCheckAfter(
      latest,
      finished,
      result.outcome === 'failed' || result.outcome === 'timed-out',
    );
    await latest.save?.();
  }
  return result;
}
