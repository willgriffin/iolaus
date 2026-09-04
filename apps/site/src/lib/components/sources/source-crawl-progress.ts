export type CrawlStatusName =
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'pending'
  | 'queued'
  | 'running'
  | 'timed_out'
  | string;

export interface SourceCrawlCounts {
  candidates: number;
  created: number;
  duplicates: number;
  errors: number;
  pending: number;
  reused: number;
  skipped: number;
}

export interface SourceCrawlStatus {
  counts: SourceCrawlCounts;
  errors: string[];
  finishedAt: string | null;
  id: string;
  sourceId: string;
  startedAt: string | null;
  status: CrawlStatusName;
}

export const CRAWL_PROGRESS_POLL_INTERVAL_MS = 1_500;

const TERMINAL_STATUSES = new Set<CrawlStatusName>([
  'completed',
  'completed_with_errors',
  'failed',
  'timed_out',
]);

function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The canonical status operation has already redacted and bounded operational
 * errors. Keep the UI boundary bounded as well, and never render an arbitrary
 * failed-request response as a crawl error.
 */
function boundedErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(text)
    .filter(Boolean)
    .slice(0, 5)
    .map((message) => message.slice(0, 300));
}

export function isTerminalCrawlStatus(status: CrawlStatusName): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function normalizeSourceCrawlStatus(
  value: unknown,
): SourceCrawlStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = text(record.id);
  const sourceId = text(record.sourceId);
  const status = text(record.status);
  if (!id || !sourceId || !status) return null;
  const rawCounts =
    record.counts &&
    typeof record.counts === 'object' &&
    !Array.isArray(record.counts)
      ? (record.counts as Record<string, unknown>)
      : {};
  return {
    counts: {
      candidates: nonNegativeNumber(rawCounts.candidates),
      created: nonNegativeNumber(rawCounts.created),
      duplicates: nonNegativeNumber(rawCounts.duplicates),
      errors: nonNegativeNumber(rawCounts.errors),
      pending: nonNegativeNumber(rawCounts.pending),
      reused: nonNegativeNumber(rawCounts.reused),
      skipped: nonNegativeNumber(rawCounts.skipped),
    },
    errors: boundedErrors(record.errors),
    finishedAt: text(record.finishedAt) || null,
    id,
    sourceId,
    startedAt: text(record.startedAt) || null,
    status,
  };
}

export function readCrawlStatusResponse(
  payload: unknown,
  crawlId: string,
): SourceCrawlStatus | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const items = (payload as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  return (
    items
      .map(normalizeSourceCrawlStatus)
      .find((item): item is SourceCrawlStatus => item?.id === crawlId) ?? null
  );
}

export interface CrawlStatusPollerOptions {
  intervalMs?: number;
  load: () => Promise<SourceCrawlStatus | null>;
  onMissing: () => void;
  onStatus: (status: SourceCrawlStatus) => void;
  onUnavailable: () => void;
  schedule?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  unschedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Starts one status request at a time. It only schedules another request after
 * an active, successful response and cancels both queued and late responses
 * when its owner unmounts or changes crawl IDs.
 */
export function createCrawlStatusPoller(options: CrawlStatusPollerOptions) {
  const schedule =
    options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const unschedule = options.unschedule ?? ((handle) => clearTimeout(handle));
  const intervalMs = options.intervalMs ?? CRAWL_PROGRESS_POLL_INTERVAL_MS;
  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) {
      unschedule(timer);
      timer = undefined;
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const status = await options.load();
      if (stopped) return;
      if (!status) {
        options.onMissing();
        stop();
        return;
      }
      options.onStatus(status);
      if (isTerminalCrawlStatus(status.status)) {
        stop();
        return;
      }
      timer = schedule(() => {
        timer = undefined;
        void poll();
      }, intervalMs);
    } catch {
      if (!stopped) options.onUnavailable();
      stop();
    } finally {
      inFlight = false;
    }
  };

  return {
    start: () => void poll(),
    stop,
  };
}

export function crawlStateLabel(status: CrawlStatusName): string {
  switch (status) {
    case 'queued':
    case 'pending':
      return 'Your pull is queued.';
    case 'running':
      return 'Pulling current listings…';
    case 'completed':
      return 'Pull complete.';
    case 'completed_with_errors':
      return 'Pull complete with a few items needing attention.';
    case 'failed':
      return 'The pull could not finish.';
    case 'timed_out':
      return 'The pull took too long to finish.';
    default:
      return 'Checking pull progress…';
  }
}

export function crawlElapsedLabel(
  startedAt: string | null,
  finishedAt: string | null,
  now = Date.now(),
): string {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return 'Started time unavailable';
  const finished = finishedAt ? Date.parse(finishedAt) : now;
  const seconds = Math.max(
    0,
    Math.floor((Math.max(started, finished) - started) / 1_000),
  );
  if (seconds < 60) return `${seconds}s elapsed`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s elapsed`;
}
