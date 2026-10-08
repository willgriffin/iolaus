import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';
import { ensureOpportunityAnalysis } from './opportunity-analysis.js';

type Database = Awaited<ReturnType<typeof resolveDatabase>>;
export async function ensureOpportunityAnalysisMaintenanceSchema(
  db: Database,
): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS opportunity_analysis_windows (
    window_id TEXT PRIMARY KEY, processed_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (processed_count >= 0 AND processed_count <= 300))`);
}
export type OpportunityAnalysisBackfillResult = {
  analyzed: number;
  failed: number;
  scanned: number;
  truncated: boolean;
  enriched: number;
  nextCursor: string | null;
  windowExhausted: boolean;
};
function cursorId(cursor?: string): string {
  if (!cursor) return '';
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
    throw new Error('Invalid analysis cursor.');
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id))
    throw new Error('Invalid analysis cursor.');
  return id;
}
/** Durable cross-process admission, independent of crawl enqueue windows. */
export async function claimAnalysisWindowSlot(
  db: Database,
  hour = new Date().toISOString().slice(0, 13),
): Promise<boolean> {
  if (!db.transaction)
    throw new Error('Analysis admission requires a transaction.');
  const exhausted = new Error('Analysis window exhausted.');
  try {
    return await db.transaction(async (transaction) => {
      // Both limits are global across CLI, cron and native workers. The daily
      // cap preserves the existing release budget expectation of 300 postings.
      for (const window of [`day:${hour.slice(0, 10)}`, `hour:${hour}`]) {
        await transaction.query(
          'INSERT INTO opportunity_analysis_windows (window_id) VALUES (?) ON CONFLICT (window_id) DO NOTHING',
          [window],
        );
        const result = await transaction.query(
          `UPDATE opportunity_analysis_windows SET processed_count = processed_count + 1
          WHERE window_id = ? AND processed_count < 300 RETURNING processed_count`,
          [window],
        );
        if (result.rows.length !== 1) throw exhausted;
      }
      return true;
    });
  } catch (error) {
    if (error === exhausted) return false;
    throw error;
  }
}
/** Keyset cursor makes repeated invocations resumable without a growing offset.
 * All attempts, including failures, consume the <=300/hour admission allowance. */
export async function backfillOpportunityAnalyses(options: {
  budgetMicros?: number;
  enrich?: boolean;
  max: number;
  cursor?: string;
}): Promise<OpportunityAnalysisBackfillResult> {
  if (
    !Number.isSafeInteger(options.max) ||
    options.max < 1 ||
    options.max > 300
  )
    throw new Error('Analysis max must be 1..300.');
  if (
    options.enrich &&
    (!Number.isSafeInteger(options.budgetMicros) ||
      (options.budgetMicros ?? 0) <= 0)
  )
    throw new Error('Enrichment requires an explicit positive budget.');
  const db = await resolveDatabase(getDbConfig());
  const rows = (
    await db.query(
      `SELECT id FROM opportunities WHERE CAST(id AS TEXT) > ? AND source_content_fingerprint <> ''
    AND status NOT IN ('archived','deleted','rejected') ORDER BY CAST(id AS TEXT) ASC LIMIT ?`,
      [cursorId(options.cursor), options.max + 1],
    )
  ).rows;
  const result: OpportunityAnalysisBackfillResult = {
    analyzed: 0,
    failed: 0,
    scanned: 0,
    enriched: 0,
    truncated: rows.length > options.max,
    nextCursor: options.cursor ?? null,
    windowExhausted: false,
  };
  const windowId = new Date().toISOString().slice(0, 13);
  for (const row of rows.slice(0, options.max)) {
    if (!(await claimAnalysisWindowSlot(db, windowId))) {
      result.windowExhausted = true;
      result.truncated = true;
      break;
    }
    const id = String(row.id);
    result.scanned++;
    try {
      const analysis = await ensureOpportunityAnalysis(id, {
        enrich: options.enrich,
        budgetMicros: options.budgetMicros,
        windowId,
      });
      result.analyzed++;
      if (analysis.status === 'enriched') result.enriched++;
    } catch {
      result.failed++;
    }
    result.nextCursor = Buffer.from(id).toString('base64url');
  }
  if (!result.truncated) result.nextCursor = null;
  return result;
}

/** Keep every analysis containing a requirement referenced by a private decision.
 * No private payload is loaded, logged or fed into any shared artifact. */
export async function pruneExpiredOpportunityAnalyses(
  db: Database,
  retentionDays = 30,
): Promise<number> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 30)
    throw new Error('Analysis retention must be at least 30 days.');
  if (!db.transaction)
    throw new Error('Analysis pruning requires a transaction.');
  const cutoff = new Date(
    Date.now() - retentionDays * 86_400_000,
  ).toISOString();
  const sqlite = Boolean(db.url && detectEngine(db.url) === 'sqlite');
  return db.transaction(async (transaction) => {
    const rows = (
      await transaction.query(
        `SELECT id, opportunity_id, source_content_fingerprint, requirements_json FROM opportunity_analyses a WHERE updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.current_analysis_id = a.id)
      ORDER BY id LIMIT 300`,
        [cutoff],
      )
    ).rows;
    let removed = 0;
    for (const row of rows) {
      // Publication locks the opportunity first; use the same lock ordering.
      if (!sqlite)
        await transaction.query(
          'SELECT id FROM opportunities WHERE id = ? FOR UPDATE',
          [row.opportunity_id],
        );
      const rankRefs = await transaction.query(
        'SELECT 1 FROM opportunity_recommendation_ranks WHERE opportunity_id = ? AND source_content_fingerprint = ? LIMIT 1',
        [row.opportunity_id, row.source_content_fingerprint],
      );
      if (rankRefs.rows.length) continue;
      let requirements: unknown;
      try {
        requirements = JSON.parse(String(row.requirements_json));
      } catch {
        continue;
      }
      if (!Array.isArray(requirements)) continue;
      const hashes = requirements.map((r) => r?.hash);
      if (
        hashes.some((h) => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))
      )
        continue;
      if (hashes.length) {
        const refs = await transaction.query(
          `SELECT 1 FROM requirement_evidence_decisions WHERE requirement_hash IN (${hashes.map(() => '?').join(',')}) LIMIT 1`,
          hashes,
        );
        if (refs.rows.length) continue;
      }
      // Recheck current pointer while removing its junction rows in the same tx.
      const current = await transaction.query(
        'SELECT 1 FROM opportunities WHERE current_analysis_id = ? LIMIT 1',
        [row.id],
      );
      if (current.rows.length) continue;
      await transaction.query(
        'DELETE FROM opportunity_skills WHERE analysis_id = ?',
        [row.id],
      );
      const deleted = await transaction.query(
        `DELETE FROM opportunity_analyses WHERE id = ? AND NOT EXISTS
        (SELECT 1 FROM opportunities WHERE current_analysis_id = ?) RETURNING id`,
        [row.id, row.id],
      );
      removed += deleted.rows.length;
    }
    return removed;
  });
}
