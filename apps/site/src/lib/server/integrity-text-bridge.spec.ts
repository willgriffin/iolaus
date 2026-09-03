import { describe, expect, it, vi } from 'vitest';
import {
  formatIntegrityTextBridgeReleases,
  INTEGRITY_TEXT_BRIDGE_COLUMN,
  planIntegrityTextBridgeReleases,
  releaseIntegrityTextBridge,
  releaseIntegrityTextBridges,
} from './integrity-text-bridge.js';

const idConversion = (table: string) =>
  `ALTER TABLE "${table}" ALTER COLUMN "id" TYPE uuid USING "id"::uuid`;

/**
 * A query stub returning the rows each probe expects: the bridge-column
 * existence check, then the dependent foreign-key listing. Every other
 * statement resolves empty so the DDL calls can be asserted from `calls`.
 */
function stubDatabase(options: {
  bridgeTables: Set<string>;
  dependents: Record<string, { child: string; constraint_name: string }[]>;
}) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push(sql.replace(/\s+/gu, ' ').trim());
    if (sql.includes('information_schema.columns')) {
      const table = String(values?.[0] ?? '');
      return {
        rows: options.bridgeTables.has(table) ? [{ '?column?': 1 }] : [],
      };
    }
    if (sql.includes('pg_constraint')) {
      const table = String(values?.[0] ?? '');
      return { rows: options.dependents[table] ?? [] };
    }
    return { rows: [] };
  });
  return { calls, db: { query } as never, query };
}

describe('planIntegrityTextBridgeReleases', () => {
  it('selects only tables whose id column is being converted', () => {
    expect(
      planIntegrityTextBridgeReleases([
        idConversion('tags'),
        'ALTER TABLE "assets" ALTER COLUMN "folder_id" TYPE uuid USING "folder_id"::uuid',
        'ALTER TABLE "places" ADD CONSTRAINT "places_parent_id_places_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "places" ("id") NOT VALID',
        idConversion('facts'),
      ]),
    ).toEqual(['facts', 'tags']);
  });

  it('deduplicates and ignores unrelated statements', () => {
    expect(
      planIntegrityTextBridgeReleases([
        idConversion('tags'),
        idConversion('tags'),
        'CREATE INDEX tags_slug_idx ON "tags" ("slug")',
      ]),
    ).toEqual(['tags']);
  });

  it('returns nothing once no conversion remains planned', () => {
    expect(planIntegrityTextBridgeReleases([])).toEqual([]);
  });
});

describe('releaseIntegrityTextBridge', () => {
  it('drops dependent foreign keys before the bridge column', async () => {
    const { calls, db } = stubDatabase({
      bridgeTables: new Set(['tags']),
      dependents: {
        tags: [
          {
            child: 'company_tags',
            constraint_name: 'company_tags_tag_integrity_fkey',
          },
          {
            child: 'source_tags',
            constraint_name: 'source_tags_tag_integrity_fkey',
          },
        ],
      },
    });

    const release = await releaseIntegrityTextBridge(db, 'tags');

    expect(release).toEqual({
      table: 'tags',
      droppedConstraints: [
        'company_tags_tag_integrity_fkey',
        'source_tags_tag_integrity_fkey',
      ],
    });
    const ddl = calls.filter((sql) => sql.startsWith('ALTER TABLE'));
    expect(ddl).toEqual([
      'ALTER TABLE "company_tags" DROP CONSTRAINT IF EXISTS "company_tags_tag_integrity_fkey"',
      'ALTER TABLE "source_tags" DROP CONSTRAINT IF EXISTS "source_tags_tag_integrity_fkey"',
      `ALTER TABLE "tags" DROP COLUMN IF EXISTS "${INTEGRITY_TEXT_BRIDGE_COLUMN}"`,
    ]);
  });

  it('leaves a table without a bridge column untouched', async () => {
    const { calls, db } = stubDatabase({
      bridgeTables: new Set(),
      dependents: {},
    });

    await expect(releaseIntegrityTextBridge(db, 'tags')).resolves.toBeNull();
    expect(calls.filter((sql) => sql.startsWith('ALTER TABLE'))).toEqual([]);
  });
});

describe('releaseIntegrityTextBridges', () => {
  it('releases every planned table and reports what it dropped', async () => {
    const { db } = stubDatabase({
      bridgeTables: new Set(['tags']),
      dependents: {
        tags: [
          {
            child: 'company_tags',
            constraint_name: 'company_tags_tag_integrity_fkey',
          },
        ],
      },
    });

    const releases = await releaseIntegrityTextBridges(db, [
      idConversion('tags'),
      idConversion('folders'),
    ]);

    expect(releases).toEqual([
      {
        table: 'tags',
        droppedConstraints: ['company_tags_tag_integrity_fkey'],
      },
    ]);
    expect(formatIntegrityTextBridgeReleases(releases)).toBe(
      `Released ${INTEGRITY_TEXT_BRIDGE_COLUMN} on tags (dropped 1 dependent foreign key).`,
    );
  });

  it('reports an empty release set', () => {
    expect(formatIntegrityTextBridgeReleases([])).toBe(
      'No integrity text bridge columns needed release.',
    );
  });
});
