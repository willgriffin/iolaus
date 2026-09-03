import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bumpOpportunityChangeFeed,
  bumpOpportunityTableChangeFeed,
  ensureChangeFeedTableOnce,
  MAX_PER_ROW_CHANGE_BUMPS,
} from './change-feed';

const appendChange = vi.hoisted(() => vi.fn(async () => 1));
const ensureChangeFeedTable = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@happyvertical/smrt-core', () => ({
  appendChange,
  ensureChangeFeedTable,
}));

const database = { query: vi.fn() };

beforeEach(() => {
  appendChange.mockReset();
  appendChange.mockResolvedValue(1);
  ensureChangeFeedTable.mockClear();
});

describe('bumpOpportunityChangeFeed', () => {
  it('records one update entry per changed opportunity', async () => {
    const appended = await bumpOpportunityChangeFeed(database, [
      'opp-1',
      'opp-2',
    ]);

    expect(appended).toBe(2);
    expect(appendChange).toHaveBeenNthCalledWith(1, database, {
      operation: 'update',
      rowId: 'opp-1',
      table: 'opportunities',
    });
    expect(appendChange).toHaveBeenNthCalledWith(2, database, {
      operation: 'update',
      rowId: 'opp-2',
      table: 'opportunities',
    });
  });

  it('de-duplicates ids and ignores blanks', async () => {
    const appended = await bumpOpportunityChangeFeed(database, [
      'opp-1',
      ' opp-1 ',
      '  ',
    ]);

    expect(appended).toBe(1);
    expect(appendChange).toHaveBeenCalledTimes(1);
  });

  it('collapses a bulk change into one table-level entry', async () => {
    const ids = Array.from(
      { length: MAX_PER_ROW_CHANGE_BUMPS + 1 },
      (_value, index) => `opp-${index}`,
    );

    const appended = await bumpOpportunityChangeFeed(database, ids);

    expect(appended).toBe(1);
    expect(appendChange).toHaveBeenCalledTimes(1);
    expect(appendChange).toHaveBeenCalledWith(database, {
      operation: 'update',
      rowId: null,
      table: 'opportunities',
    });
  });

  it('records nothing when no row changed', async () => {
    expect(await bumpOpportunityChangeFeed(database, [])).toBe(0);
    expect(appendChange).not.toHaveBeenCalled();
  });

  it('never lets a failed bump surface as a failed write', async () => {
    appendChange.mockRejectedValueOnce(new Error('feed unavailable'));

    await expect(bumpOpportunityChangeFeed(database, ['opp-1'])).resolves.toBe(
      0,
    );
  });
});

describe('bumpOpportunityTableChangeFeed', () => {
  it('records one table-level entry when rows changed', async () => {
    expect(await bumpOpportunityTableChangeFeed(database, 7)).toBe(1);
    expect(appendChange).toHaveBeenCalledWith(database, {
      operation: 'update',
      rowId: null,
      table: 'opportunities',
    });
  });

  it('records nothing when the statement changed no row', async () => {
    expect(await bumpOpportunityTableChangeFeed(database, 0)).toBe(0);
    expect(appendChange).not.toHaveBeenCalled();
  });
});

/**
 * Issue #458.
 *
 * `bumpChangeFeed` is `ensureChangeFeedTable` + `appendChange`, and the ensure
 * is memoized per database handle. A bump inside a transaction gets a fresh
 * transaction-scoped handle every time, so the memo was never warm there and
 * the first bump after a deploy or a feed-schema migration would have run DDL
 * inside the archive transaction. The bump path must therefore only append;
 * creating the table is `db-migrate`'s job.
 */
describe('an archive transaction issues no DDL', () => {
  it('never ensures the feed table from a per-row bump', async () => {
    await bumpOpportunityChangeFeed({ query: vi.fn() }, ['opp-1', 'opp-2']);

    expect(appendChange).toHaveBeenCalledTimes(2);
    expect(ensureChangeFeedTable).not.toHaveBeenCalled();
  });

  it('never ensures the feed table from a table-level bump', async () => {
    await bumpOpportunityTableChangeFeed({ query: vi.fn() }, 7);

    expect(appendChange).toHaveBeenCalledTimes(1);
    expect(ensureChangeFeedTable).not.toHaveBeenCalled();
  });

  it('stays cold across fresh transaction handles, the case the memo missed', async () => {
    for (let transaction = 0; transaction < 3; transaction += 1) {
      await bumpOpportunityChangeFeed({ query: vi.fn() }, ['opp-1']);
    }

    expect(ensureChangeFeedTable).not.toHaveBeenCalled();
  });

  it('exposes the ensure separately so db-migrate can create the table once', async () => {
    const migrationHandle = { query: vi.fn() };
    await ensureChangeFeedTableOnce(migrationHandle);

    expect(ensureChangeFeedTable).toHaveBeenCalledWith(migrationHandle);
  });
});
