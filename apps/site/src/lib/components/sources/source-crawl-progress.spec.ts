import { describe, expect, it, vi } from 'vitest';
import {
  crawlElapsedLabel,
  createCrawlStatusPoller,
  normalizeSourceCrawlStatus,
  readCrawlStatusResponse,
  type SourceCrawlStatus,
} from './source-crawl-progress.js';

const CRAWL_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';

function status(overrides: Partial<SourceCrawlStatus> = {}): SourceCrawlStatus {
  return {
    counts: {
      candidates: 3,
      created: 2,
      duplicates: 0,
      errors: 0,
      pending: 1,
      reused: 0,
      skipped: 0,
    },
    errors: [],
    finishedAt: null,
    id: CRAWL_ID,
    sourceId: SOURCE_ID,
    startedAt: '2026-09-04T05:00:00.000Z',
    status: 'queued',
    ...overrides,
  };
}

describe('source crawl progress', () => {
  it('normalizes partial durable counts and only reads the requested crawl', () => {
    const normalized = normalizeSourceCrawlStatus({
      counts: { created: 2, errors: -1, skipped: '3' },
      errors: ['first', '', 'second'],
      id: CRAWL_ID,
      sourceId: SOURCE_ID,
      status: 'running',
    });
    expect(normalized).toMatchObject({
      counts: { candidates: 0, created: 2, errors: 0, skipped: 3 },
      errors: ['first', 'second'],
      status: 'running',
    });
    expect(
      readCrawlStatusResponse(
        { items: [status({ id: 'other-crawl' }), normalized] },
        CRAWL_ID,
      ),
    ).toEqual(normalized);
  });

  it('polls queued and running work once each, then stops on completion', async () => {
    const states = [
      status(),
      status({ status: 'running' }),
      status({
        finishedAt: '2026-09-04T05:00:08.000Z',
        status: 'completed',
      }),
    ];
    const seen: string[] = [];
    const timers: Array<() => void> = [];
    const load = vi.fn(async () => states.shift() ?? null);
    const poller = createCrawlStatusPoller({
      load,
      onMissing: vi.fn(),
      onStatus: (next) => seen.push(next.status),
      onUnavailable: vi.fn(),
      schedule: (callback) => {
        timers.push(callback);
        return timers.length as never;
      },
      unschedule: vi.fn(),
    });

    poller.start();
    poller.start();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    timers.shift()?.();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    timers.shift()?.();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));

    expect(seen).toEqual(['queued', 'running', 'completed']);
    expect(timers).toHaveLength(0);
  });

  it('stops polling on a terminal failure and retains only canonical bounded errors', async () => {
    const onStatus = vi.fn();
    const schedule = vi.fn();
    const poller = createCrawlStatusPoller({
      load: async () =>
        status({
          errors: ['A source could not be reached.'],
          finishedAt: '2026-09-04T05:00:08.000Z',
          status: 'failed',
        }),
      onMissing: vi.fn(),
      onStatus,
      onUnavailable: vi.fn(),
      schedule,
    });

    poller.start();
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1));
    expect(onStatus.mock.calls[0][0].errors).toEqual([
      'A source could not be reached.',
    ]);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('cancels queued work and ignores a response that arrives after unmount', async () => {
    let resolve!: (value: SourceCrawlStatus) => void;
    const onStatus = vi.fn();
    const poller = createCrawlStatusPoller({
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
      onMissing: vi.fn(),
      onStatus,
      onUnavailable: vi.fn(),
    });

    poller.start();
    poller.stop();
    resolve(status({ status: 'running' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('uses a plain elapsed label without exposing timestamp internals', () => {
    expect(
      crawlElapsedLabel('2026-09-04T05:00:00.000Z', '2026-09-04T05:01:07.000Z'),
    ).toBe('1m 7s elapsed');
    expect(crawlElapsedLabel(null, null)).toBe('Started time unavailable');
  });
});
