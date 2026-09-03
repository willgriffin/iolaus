import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import './smrt.js';
import {
  inspectSourceCrawlOpportunityOrphans,
  SOURCE_CRAWL_OPPORTUNITY_REPAIR_MAX_BATCH,
} from './source-crawl-opportunity-integrity.js';

describe('source crawl opportunity integrity', () => {
  it('keeps the deployed text reference nullable for guarded legacy migration', () => {
    const field =
      ObjectRegistry.getClass('SourceCrawlItem')?.fields.get('opportunityId');
    const column =
      ObjectRegistry.getSchema('SourceCrawlItem')?.columns.opportunity_id;

    expect(field).toMatchObject({ type: 'text' });
    expect(field?._meta).toMatchObject({ nullable: true });
    expect(column).toMatchObject({ notNull: false, type: 'TEXT' });
    expect(column?.foreignKey).toBeUndefined();
  });

  it('rejects unbounded repair inspection', async () => {
    const db = {
      query: async () => ({ rows: [] }),
    };
    await expect(
      inspectSourceCrawlOpportunityOrphans(db as never, {
        limit: SOURCE_CRAWL_OPPORTUNITY_REPAIR_MAX_BATCH + 1,
      }),
    ).rejects.toThrow('Repair batch size must be from 1 to 500');
  });
});
