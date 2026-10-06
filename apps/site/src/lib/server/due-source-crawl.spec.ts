import { describe, expect, it } from 'vitest';
import {
  type CrawlableDueSource,
  crawlDueSource,
  FAILED_CRAWL_COOLDOWN_MS,
  nextCheckAfter,
  selectDueSources,
} from './due-source-crawl';

const now = new Date('2026-10-06T12:00:00.000Z');
const root = {
  isActive: true,
  refreshCadence: 'weekly',
  sourceRole: 'root',
};

describe('selectDueSources', () => {
  it('picks active root sources that are due or never checked, most overdue first', () => {
    const sources = [
      { ...root, id: 'c', nextCheckAt: '2026-10-06T11:00:00.000Z' },
      { ...root, id: 'a', nextCheckAt: '2026-10-01T00:00:00.000Z' },
      { ...root, id: 'never', nextCheckAt: null },
      { ...root, id: 'future', nextCheckAt: '2026-10-07T00:00:00.000Z' },
      { ...root, id: 'exact', nextCheckAt: now },
    ];
    expect(selectDueSources(sources, now, 10).map((s) => s.id)).toEqual([
      'never',
      'a',
      'c',
      'exact',
    ]);
  });

  it('skips inactive, non-root, child and ad hoc sources', () => {
    const sources = [
      { ...root, id: 'inactive', isActive: false },
      { ...root, id: 'child', parentSourceId: 'p' },
      { ...root, id: 'leaf', sourceRole: 'leaf' },
      { ...root, id: 'adhoc', refreshCadence: 'ad_hoc' },
      { ...root, id: 'ok' },
    ];
    expect(selectDueSources(sources, now, 10).map((s) => s.id)).toEqual(['ok']);
  });

  it('bounds the batch and tolerates a non-positive bound', () => {
    const sources = ['a', 'b', 'c'].map((id) => ({ ...root, id }));
    expect(selectDueSources(sources, now, 2)).toHaveLength(2);
    expect(selectDueSources(sources, now, 0)).toEqual([]);
  });
});

describe('nextCheckAfter', () => {
  it('follows the source cadence after success and cools down after failure', () => {
    const source = { ...root, id: 's1', refreshCadence: 'daily' };
    const ok = nextCheckAfter(source, now, false);
    expect(ok.getTime()).toBeGreaterThan(now.getTime());
    expect(ok.getTime() - now.getTime()).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(nextCheckAfter(source, now, true).getTime()).toBe(
      now.getTime() + FAILED_CRAWL_COOLDOWN_MS,
    );
  });
});

describe('crawlDueSource', () => {
  const make = (extra: Partial<CrawlableDueSource> = {}) => {
    const saves: Array<Record<string, unknown>> = [];
    const record: CrawlableDueSource = {
      ...root,
      id: 's1',
      refreshCadence: 'daily',
      save: async () => {
        saves.push({ last: record.lastCheckedAt, next: record.nextCheckAt });
      },
      ...extra,
    };
    return { record, saves };
  };

  it('crawls, then writes only the check times from a fresh read', async () => {
    const { record, saves } = make();
    const reads: string[] = [];
    const result = await crawlDueSource('s1', {
      crawl: async () => ({
        candidates: 5,
        created: 2,
        errors: ['board reconciliation'],
      }),
      get: async (id) => {
        reads.push(id);
        return record;
      },
      now: () => now,
      timeoutMs: 1000,
    });
    expect(result).toEqual({ candidates: 5, created: 2, outcome: 'crawled' });
    expect(reads).toHaveLength(2);
    expect(saves).toHaveLength(1);
    expect(new Date(String(saves[0].last)).getTime()).toBe(now.getTime());
    expect(new Date(String(saves[0].next)).getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });

  it('skips a source an operator deactivated since the snapshot and never saves it', async () => {
    const { record, saves } = make({ isActive: false });
    const result = await crawlDueSource('s1', {
      crawl: async () => {
        throw new Error('must not crawl');
      },
      get: async () => record,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe('skipped');
    expect(saves).toHaveLength(0);
  });

  it('does not reactivate a source deactivated during the crawl', async () => {
    const { record, saves } = make();
    let reads = 0;
    const result = await crawlDueSource('s1', {
      crawl: async () => ({ candidates: 3, created: 0, errors: [] }),
      get: async () => {
        reads += 1;
        if (reads === 2) record.isActive = false;
        return record;
      },
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe('crawled');
    expect(saves).toHaveLength(0);
  });

  it('classifies failures and cools them down', async () => {
    const { record, saves } = make();
    const result = await crawlDueSource('s1', {
      crawl: async () => {
        throw new Error('boom');
      },
      get: async () => record,
      now: () => now,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe('failed');
    expect(new Date(String(saves[0].next)).getTime()).toBe(
      now.getTime() + FAILED_CRAWL_COOLDOWN_MS,
    );
    const empty = await crawlDueSource('s1', {
      crawl: async () => ({ candidates: 0, created: 0, errors: ['x'] }),
      get: async () => record,
      timeoutMs: 1000,
    });
    expect(empty.outcome).toBe('failed');
  });

  it('times out a hung crawl, aborts it and cools the source down', async () => {
    const { record, saves } = make();
    let aborted = false;
    const result = await crawlDueSource('s1', {
      crawl: (_source, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      get: async () => record,
      now: () => now,
      timeoutMs: 20,
    });
    expect(result.outcome).toBe('timed-out');
    expect(aborted).toBe(true);
    expect(saves).toHaveLength(1);
  });
});
