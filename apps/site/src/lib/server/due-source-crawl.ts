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
