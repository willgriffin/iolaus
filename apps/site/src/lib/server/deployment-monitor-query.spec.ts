import { describe, expect, it } from 'vitest';
import {
  jobMonitorQuery,
  sourceCrawlMonitorQuery,
} from './deployment-monitor-query.js';

describe('restricted monitor database contract', () => {
  it('uses only aggregate-safe monitor columns and never projects records', () => {
    const sql =
      `${sourceCrawlMonitorQuery}\n${jobMonitorQuery('?, ?, ?, ?')}`.toLowerCase();
    expect(sql).toContain('count(*)');
    expect(sql).toContain('from source_crawls');
    expect(sql).toContain('from _smrt_jobs');
    for (const forbidden of [
      ' id',
      ' url',
      ' error',
      ' payload',
      ' args',
      ' result',
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });
});
