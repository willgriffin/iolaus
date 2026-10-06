import { describe, expect, it } from 'vitest';
import {
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
