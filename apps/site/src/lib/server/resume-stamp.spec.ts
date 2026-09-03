import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTableName: vi.fn(),
  query: vi.fn(),
  resolveDatabase: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: { getTableName: mocks.getTableName },
  resolveDatabase: mocks.resolveDatabase,
}));

import {
  LEGACY_RESUME_READ_PLAN,
  NORMALIZED_RESUME_READ_PLAN,
  resumeStampClassNames,
} from './resume-read-plans';
import {
  loadPublishedResumeStamp,
  resumeStampTableNames,
} from './resume-stamp';

const DATABASE = { type: 'postgres', url: 'postgres://example/db' } as const;

type StampOverride = { row_count: number; row_digest: string };

/**
 * Build a complete result set — one row per stamped table, as the real query
 * always returns — with the given overrides applied by table name.
 */
function stampRows(
  overrides: Record<string, StampOverride> = {},
): Record<string, unknown>[] {
  return resumeStampTableNames().map((table) => {
    const { row_count = 0, row_digest = '' } = overrides[table] ?? {};
    return { row_count, row_digest, source_table: table };
  });
}

/** A real stamped table name, whatever the registry mock derives it to be. */
function someTable(): string {
  return resumeStampTableNames()[0];
}

async function stampFor(
  overrides: Record<string, StampOverride> = {},
): Promise<string> {
  mocks.query.mockResolvedValueOnce({ rows: stampRows(overrides) });
  return loadPublishedResumeStamp(DATABASE);
}

function snakeCase(className: string): string {
  return className.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

beforeEach(() => {
  mocks.getTableName.mockReset();
  mocks.getTableName.mockImplementation((className: string) =>
    snakeCase(className),
  );
  mocks.query.mockReset();
  mocks.query.mockImplementation(async () => ({ rows: stampRows() }));
  mocks.resolveDatabase.mockReset();
  mocks.resolveDatabase.mockResolvedValue({ query: mocks.query });
});

describe('resumeStampClassNames', () => {
  it('covers every class both resume read plans can read', () => {
    const planned = new Set(
      [
        ...Object.values(NORMALIZED_RESUME_READ_PLAN),
        ...Object.values(LEGACY_RESUME_READ_PLAN),
      ].map(([className]) => className),
    );

    // The stamp and the read plan must not drift: a collection the loader reads
    // but the stamp ignores would serve stale content after an edit.
    expect(new Set(resumeStampClassNames())).toEqual(planned);
  });

  it('deduplicates classes shared between the normalized and legacy plans', () => {
    const names = resumeStampClassNames();
    expect(names).toEqual([...new Set(names)]);
    expect(names).toContain('ResumeOtherRole');
  });
});

describe('resumeStampTableNames', () => {
  it('resolves table names from SMRT metadata rather than deriving them', () => {
    // `Education` is stored in `education`, not the `educations` a naive
    // pluralization would produce.
    mocks.getTableName.mockImplementation((className: string) =>
      className === 'Education' ? 'education' : snakeCase(className),
    );

    const tables = resumeStampTableNames();

    expect(tables).toContain('education');
    expect(tables).not.toContain('educations');
    expect(mocks.getTableName).toHaveBeenCalledWith('Education');
  });

  it('fails when a planned collection has no registered table', () => {
    mocks.getTableName.mockImplementation((className: string) =>
      className === 'Tag' ? undefined : snakeCase(className),
    );

    expect(() => resumeStampTableNames()).toThrow(/no registered table name/i);
  });

  it('refuses a table name that is not a plain identifier', () => {
    mocks.getTableName.mockImplementation((className: string) =>
      className === 'Tag' ? 'tags; DROP TABLE tags' : snakeCase(className),
    );

    expect(() => resumeStampTableNames()).toThrow(/unsafe table name/i);
  });

  it('returns a stable sorted list', () => {
    expect(resumeStampTableNames()).toEqual(
      [...resumeStampTableNames()].sort(),
    );
  });
});

describe('loadPublishedResumeStamp', () => {
  it('reads every planned table in a single round-trip', async () => {
    await loadPublishedResumeStamp(DATABASE);

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql] = mocks.query.mock.calls[0] as [string];
    for (const table of resumeStampTableNames()) {
      // Quoted, so a future table named for a reserved word still parses.
      expect(sql).toContain(`FROM "${table}"`);
    }
  });

  it('digests every row by transaction id, never by timestamp', async () => {
    // This SQL shape *is* the change-detection guarantee. xmin moves on every
    // write by construction, so it survives clock skew, same-millisecond saves,
    // and raw SQL that never touches updated_at — all of which a timestamp-based
    // digest misses. Assert the aggregate itself, not just its alias: a refactor
    // back to a timestamp would keep the alias and silently reintroduce those
    // staleness bugs.
    await loadPublishedResumeStamp(DATABASE);
    const [sql] = mocks.query.mock.calls[0] as [string];

    expect(sql).toContain('count(*) AS row_count');
    expect(sql).toContain(
      "md5(coalesce(string_agg(id::text || ':' || xmin::text, ',' ORDER BY id::text), '')) AS row_digest",
    );
    expect(sql).not.toContain('updated_at');
  });

  it('changes when a row is updated', async () => {
    const before = await stampFor({
      [someTable()]: { row_count: 3, row_digest: 'aaa' },
    });
    const after = await stampFor({
      [someTable()]: { row_count: 3, row_digest: 'bbb' },
    });

    expect(after).not.toBe(before);
  });

  it('changes when an old row is deleted', async () => {
    const before = await stampFor({
      [someTable()]: { row_count: 3, row_digest: 'aaa' },
    });
    const after = await stampFor({
      [someTable()]: { row_count: 2, row_digest: 'bbb' },
    });

    expect(after).not.toBe(before);
  });

  it('is stable for unchanged data regardless of row order', async () => {
    const overrides = {
      [resumeStampTableNames()[0]]: { row_count: 3, row_digest: 'aaa' },
      [resumeStampTableNames()[1]]: { row_count: 9, row_digest: 'bbb' },
    };
    const rows = stampRows(overrides);

    mocks.query.mockResolvedValueOnce({ rows: [...rows].reverse() });
    const reversed = await loadPublishedResumeStamp(DATABASE);

    expect(reversed).toBe(await stampFor(overrides));
  });

  it('accepts a bare array result from the driver', async () => {
    const override = { [someTable()]: { row_count: 3, row_digest: 'aaa' } };
    mocks.query.mockResolvedValueOnce(stampRows(override));
    const asArray = await loadPublishedResumeStamp(DATABASE);

    expect(asArray).toBe(await stampFor(override));
  });

  it('distinguishes an empty table from a populated one', async () => {
    const empty = await stampFor({
      [someTable()]: { row_count: 0, row_digest: '' },
    });
    const populated = await stampFor({
      [someTable()]: { row_count: 1, row_digest: 'aaa' },
    });

    expect(empty).not.toBe(populated);
  });

  it('rejects a result that does not cover every stamped table', async () => {
    // An unrecognized driver shape degrades to an empty row list, whose digest
    // is a constant — it would validate forever and pin every replica as fresh.
    // Fail the probe instead; the caller already degrades safely.
    mocks.query.mockResolvedValueOnce({
      rows: [{ row_count: 1, row_digest: 'aaa', source_table: someTable() }],
    });

    await expect(loadPublishedResumeStamp(DATABASE)).rejects.toThrow(
      /returned 1 rows for \d+ tables/,
    );
  });

  it('rejects a result whose rows name the wrong tables', async () => {
    // Right count, wrong keys: every field would coalesce to empty and digest to
    // a constant, which validates forever.
    mocks.query.mockResolvedValueOnce({
      rows: resumeStampTableNames().map(() => ({
        row_count: 0,
        row_digest: '',
        source_table: 'not_a_resume_table',
      })),
    });

    await expect(loadPublishedResumeStamp(DATABASE)).rejects.toThrow(
      /omitted table/,
    );
  });

  it('rejects an unrecognized driver result shape outright', async () => {
    mocks.query.mockResolvedValueOnce({ unexpected: true });

    await expect(loadPublishedResumeStamp(DATABASE)).rejects.toThrow(
      /returned 0 rows/,
    );
  });

  it('resolves the database it was handed rather than an ambient one', async () => {
    await loadPublishedResumeStamp(DATABASE);
    expect(mocks.resolveDatabase).toHaveBeenCalledWith(DATABASE);
  });
});
