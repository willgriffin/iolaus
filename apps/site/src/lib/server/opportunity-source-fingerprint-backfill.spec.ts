import { describe, expect, it, vi } from 'vitest';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content';
import {
  backfillOpportunitySourceFingerprints,
  formatOpportunitySourceFingerprintBackfillSummary,
} from './opportunity-source-fingerprint-backfill';

interface Row {
  id: string;
  source_content_fingerprint: string | null;
  source_content_json: string | null;
  source_content_version: number | null;
}

function row(id: string, json: string | null): Row {
  return {
    id,
    source_content_fingerprint: null,
    source_content_json: json,
    source_content_version: null,
  };
}

/**
 * Minimal stand-in for the columns and null semantics the backfill relies on.
 *
 * `opportunities.id` is a `uuid` column on a freshly created schema, so this
 * fake rejects a cursor value postgres could not cast — an empty-string
 * sentinel bound to `id > $1` aborts the whole migrate step in production.
 */
function fakeDatabase(rows: Row[]) {
  const uuidLike = /^[0-9a-z-]+$/;
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    if (sql.trimStart().startsWith('SELECT')) {
      const keyset = sql.includes('id > ?');
      const [cursor, limit] = keyset
        ? (parameters as [string, number])
        : [null, parameters[0] as number];
      if (keyset && !uuidLike.test(String(cursor))) {
        throw new Error(
          `invalid input syntax for type uuid: "${String(cursor)}"`,
        );
      }
      const matched = rows
        .filter(
          (candidate) =>
            candidate.source_content_fingerprint === null &&
            candidate.source_content_json !== null &&
            !['', '{}'].includes(candidate.source_content_json.trim()) &&
            (cursor === null || candidate.id > cursor),
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit);
      return {
        rowCount: matched.length,
        rows: matched.map((matchedRow) => ({
          id: matchedRow.id,
          source_content_json: matchedRow.source_content_json,
        })),
      };
    }
    const [fingerprint, id] = parameters as [string, string];
    const target = rows.find(
      (candidate) =>
        candidate.id === id && candidate.source_content_fingerprint === null,
    );
    if (!target) return { rowCount: 0, rows: [] };
    target.source_content_fingerprint = fingerprint;
    target.source_content_version = target.source_content_version ?? 1;
    return { rowCount: 1, rows: [] };
  });
  return { query };
}

const content = {
  descriptionRaw: 'Build platform and agent systems.',
  title: 'Staff Engineer',
};

describe('backfillOpportunitySourceFingerprints', () => {
  it('fingerprints exactly the rows that store source content', async () => {
    const rows = [
      row('a', JSON.stringify(content)),
      row('b', null),
      row('c', '{}'),
      row('d', '   '),
    ];
    const database = fakeDatabase(rows);

    const result = await backfillOpportunitySourceFingerprints(
      database as never,
    );

    expect(result).toEqual({
      fingerprinted: 1,
      scanned: 1,
      skipped: 0,
      truncated: false,
    });
    expect(rows[0]).toMatchObject({
      source_content_fingerprint: fingerprintOpportunitySourceContent(content),
      source_content_version: 1,
    });
    for (const untouched of rows.slice(1)) {
      expect(untouched.source_content_fingerprint).toBeNull();
      expect(untouched.source_content_version).toBeNull();
    }
  });

  it('is a no-op on a second run', async () => {
    const rows = [row('a', JSON.stringify(content))];
    const database = fakeDatabase(rows);
    await backfillOpportunitySourceFingerprints(database as never);
    const fingerprint = rows[0].source_content_fingerprint;
    database.query.mockClear();

    const result = await backfillOpportunitySourceFingerprints(
      database as never,
    );

    expect(result).toEqual({
      fingerprinted: 0,
      scanned: 0,
      skipped: 0,
      truncated: false,
    });
    expect(database.query).toHaveBeenCalledOnce();
    expect(rows[0].source_content_fingerprint).toBe(fingerprint);
  });

  it('walks the frontier in batches instead of loading every row', async () => {
    const rows = Array.from({ length: 5 }, (_unused, index) =>
      row(`row-${index}`, JSON.stringify({ ...content, title: `T${index}` })),
    );
    const database = fakeDatabase(rows);

    const result = await backfillOpportunitySourceFingerprints(
      database as never,
      { batchSize: 2 },
    );

    expect(result.fingerprinted).toBe(5);
    const selects = database.query.mock.calls.filter(([sql]) =>
      sql.trimStart().startsWith('SELECT'),
    );
    expect(selects.length).toBe(3);
    // The first page is unfenced; every later page keysets off a real id.
    expect(selects[0][0]).not.toContain('id > ?');
    expect(selects[0][1]).toEqual([2]);
    for (const [sql, parameters] of selects.slice(1)) {
      expect(sql).toContain('id > ?');
      expect((parameters as unknown[])[1]).toBe(2);
    }
    expect(
      rows.every((filled) => filled.source_content_fingerprint !== null),
    ).toBe(true);
  });

  it('never binds a sentinel cursor a uuid id column would reject', async () => {
    const rows = [row('a', JSON.stringify(content))];
    const database = fakeDatabase(rows);

    await expect(
      backfillOpportunitySourceFingerprints(database as never),
    ).resolves.toMatchObject({ fingerprinted: 1 });
    const [firstSelect] = database.query.mock.calls;
    expect(firstSelect[0]).not.toContain('id > ?');
    expect(firstSelect[1]).not.toContain('');
  });

  it('skips content that does not parse and keeps walking', async () => {
    const rows = [row('a', 'not json'), row('b', JSON.stringify(content))];
    const database = fakeDatabase(rows);

    const result = await backfillOpportunitySourceFingerprints(
      database as never,
      { batchSize: 1 },
    );

    expect(result).toMatchObject({ fingerprinted: 1, scanned: 2, skipped: 1 });
    expect(rows[0].source_content_fingerprint).toBeNull();
    expect(rows[1].source_content_fingerprint).toBe(
      fingerprintOpportunitySourceContent(content),
    );
  });

  it('reports truncation when the row cap stops the pass', async () => {
    const rows = Array.from({ length: 3 }, (_unused, index) =>
      row(`row-${index}`, JSON.stringify({ ...content, title: `T${index}` })),
    );
    const database = fakeDatabase(rows);

    const result = await backfillOpportunitySourceFingerprints(
      database as never,
      { maxRows: 2 },
    );

    expect(result).toMatchObject({ fingerprinted: 2, truncated: true });
    expect(formatOpportunitySourceFingerprintBackfillSummary(result)).toContain(
      'bounded backfill truncated',
    );
  });
});
