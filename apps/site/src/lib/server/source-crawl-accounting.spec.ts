import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import '../objects/index.js';
import {
  createSourceCrawlAttempt,
  finalizeSourceCrawlAttempt,
  SOURCE_CRAWL_TERMINAL_OUTCOMES,
} from './source-crawl-accounting.js';

describe('source crawl accounting contract', () => {
  it('registers durable attempt and aggregate fields', () => {
    const itemFields = ObjectRegistry.getClass('SourceCrawlItem')?.fields;
    const crawlFields = ObjectRegistry.getClass('SourceCrawl')?.fields;

    expect([...SOURCE_CRAWL_TERMINAL_OUTCOMES]).toEqual([
      'created',
      'reused',
      'relisted',
      'duplicate',
      'skipped',
      'failed_persistence',
    ]);
    expect(itemFields?.has('attemptKey')).toBe(true);
    expect(itemFields?.has('outcome')).toBe(true);
    expect(itemFields?.has('terminalAt')).toBe(true);
    for (const field of [
      'attemptCount',
      'terminalCount',
      'pendingCount',
      'reusedCount',
      'relistedCount',
      'failedPersistenceCount',
    ]) {
      expect(crawlFields?.has(field)).toBe(true);
    }
  });

  it('creates pending attempts through the indexed natural key', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rowCount: 1,
      rows: [
        {
          attemptKey: 'provider:42',
          duplicateOfSourceCrawlItemId: '',
          id: 'item-1',
          opportunityId: null,
          outcome: 'pending',
          reason: '',
          sourceCrawlId: 'crawl-1',
          status: 'pending',
          terminalAt: null,
        },
      ],
    }));

    await expect(
      createSourceCrawlAttempt(
        {
          query,
          transaction: async (work: (db: { query: typeof query }) => unknown) =>
            await work({ query }),
        } as never,
        {
          attemptKey: 'provider:42',
          sourceCrawlId: 'crawl-1',
          title: 'Durable role',
        },
      ),
    ).resolves.toMatchObject({
      attemptKey: 'provider:42',
      outcome: 'pending',
    });
    expect(query.mock.calls[1]?.[0]).toContain(
      'ON CONFLICT (source_crawl_id, attempt_key)',
    );
  });

  it('rejects optimistic created outcomes without a durable id', async () => {
    await expect(
      finalizeSourceCrawlAttempt({} as never, {
        attemptKey: 'provider:42',
        outcome: 'created',
        sourceCrawlId: 'crawl-1',
      }),
    ).rejects.toThrow('requires opportunityId');
  });
});
