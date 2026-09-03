import { describe, expect, it, vi } from 'vitest';
import type { CrawlOpportunitySourcesSummary } from '../src/lib/server/opportunity-source-crawler.js';
import {
  formatSummaryJson,
  mergeSummaries,
  printSummary,
} from './crawl-opportunity-sources.js';

function summary(multiplier: number): CrawlOpportunitySourcesSummary {
  return {
    candidates: 6 * multiplier,
    created: multiplier,
    duplicates: multiplier,
    errors: [],
    failedPersistence: multiplier,
    intelligenceDuplicateSuppressed: 0,
    intelligenceEnqueued: 0,
    intelligenceSkipped: 0,
    relisted: multiplier,
    reused: multiplier,
    skipped: multiplier,
    sources: [
      {
        candidates: 6 * multiplier,
        created: multiplier,
        duplicates: multiplier,
        errors: [],
        failedPersistence: multiplier,
        intelligenceDuplicateSuppressed: 0,
        intelligenceEnqueued: 0,
        intelligenceSkipped: 0,
        relisted: multiplier,
        reused: multiplier,
        skipped: multiplier,
        sourceId: `source-${multiplier}`,
        sourceName: `Source ${multiplier}`,
      },
    ],
  };
}

describe('crawl opportunity sources CLI summary', () => {
  it('merges and prints every durable terminal outcome counter', () => {
    const merged = mergeSummaries([summary(1), summary(2)]);
    expect(merged).toMatchObject({
      failedPersistence: 3,
      relisted: 3,
      reused: 3,
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printSummary(merged);
    const output = log.mock.calls.flat().join('\n');
    log.mockRestore();
    expect(output).toContain('reused=3');
    expect(output).toContain('relisted=3');
    expect(output).toContain('failedPersistence=3');
    expect(JSON.parse(formatSummaryJson(merged))).toMatchObject({
      failedPersistence: 3,
      relisted: 3,
      reused: 3,
    });
  });
});
