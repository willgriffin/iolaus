import type { resolveDatabase } from '@happyvertical/smrt-core';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import {
  fingerprintOpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_ROWS = 100000;

export interface OpportunitySourceFingerprintBackfillResult {
  /** Rows whose stored content produced a fingerprint. */
  fingerprinted: number;
  /** Rows read from the null-fingerprint frontier. */
  scanned: number;
  /** Rows whose stored content did not parse into source content. */
  skipped: number;
  /** True when the row cap stopped the pass before the frontier was empty. */
  truncated: boolean;
}

/**
 * Give legacy opportunities the fingerprint their stored source content
 * implies.
 *
 * Rows created before the source-content schema carry
 * `source_content_fingerprint IS NULL`, which the crawler's fence reads as
 * "no prior version". Where such a row already stores `source_content_json`,
 * the fingerprint is knowable now, so this backfill records it (and version 1)
 * rather than deferring the baseline to the next crawl. Rows with no stored
 * source content are deliberately left null and take the crawler's baseline
 * write instead.
 *
 * The pass is keyset-batched, so it never loads the table into memory, and it
 * is idempotent: a fingerprinted row leaves the frontier permanently, and each
 * write is itself fenced on the fingerprint still being null.
 */
export async function backfillOpportunitySourceFingerprints(
  db: SmrtDatabase,
  options: { batchSize?: number; maxRows?: number } = {},
): Promise<OpportunitySourceFingerprintBackfillResult> {
  const batchSize = Math.max(
    1,
    Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE),
  );
  const maxRows = Math.max(0, Math.trunc(options.maxRows ?? DEFAULT_MAX_ROWS));
  let cursor: string | null = null;
  let fingerprinted = 0;
  let scanned = 0;
  let skipped = 0;

  while (scanned < maxRows) {
    const limit = Math.min(batchSize, maxRows - scanned);
    // The first page carries no cursor predicate at all. `opportunities.id` is
    // a `uuid` column on a freshly created schema, so a sentinel empty-string
    // cursor would make postgres reject `id > $1` with
    // `invalid input syntax for type uuid: ""` and abort the whole migrate
    // step. Every later cursor is an id read back out of this table, so it is
    // always a valid value for the column's own type.
    const batch = await db.query(
      `SELECT id, source_content_json
         FROM opportunities
        WHERE source_content_fingerprint IS NULL
          AND source_content_json IS NOT NULL
          AND BTRIM(source_content_json) NOT IN ('', '{}')
          ${cursor === null ? '' : 'AND id > ?'}
        ORDER BY id ASC
        LIMIT ?`,
      cursor === null ? [limit] : [cursor, limit],
    );
    const rows = (batch.rows ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0)
      return { fingerprinted, scanned, skipped, truncated: false };

    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : String(row.id ?? '');
      scanned += 1;
      cursor = id;
      const content = parseOpportunitySourceContent(row.source_content_json);
      if (!content) {
        skipped += 1;
        continue;
      }
      const result = await db.query(
        `UPDATE opportunities
            SET source_content_fingerprint = ?,
                source_content_version = COALESCE(source_content_version, 1),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND source_content_fingerprint IS NULL`,
        [fingerprintOpportunitySourceContent(content), id],
      );
      if ((result.rowCount ?? 0) > 0) {
        fingerprinted += 1;
        // Issue #436: a raw statement feeds nothing to SMRT's change feed, so
        // a mounted list would keep serving the pre-backfill row.
        await bumpOpportunityChangeFeed(db, [id]);
      }
    }
    if (rows.length < limit) {
      return { fingerprinted, scanned, skipped, truncated: false };
    }
  }
  return { fingerprinted, scanned, skipped, truncated: true };
}

export function formatOpportunitySourceFingerprintBackfillSummary(
  result: OpportunitySourceFingerprintBackfillResult,
): string {
  return `Opportunity source fingerprints: ${result.fingerprinted} legacy rows fingerprinted from stored source content, ${result.skipped} unparseable, ${result.scanned} scanned${result.truncated ? ', bounded backfill truncated' : ''}.`;
}
