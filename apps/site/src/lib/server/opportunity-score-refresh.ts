import { AgentScheduleCollection } from '@happyvertical/smrt-agents';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import { getDbConfig } from './db.js';
import { scoringMaterialForOpportunity } from './opportunity-intelligence.js';
import {
  ensureOpportunityIntelligenceControl,
  OPPORTUNITY_INTELLIGENCE_CONTROL_KEY,
} from './opportunity-intelligence-governance.js';
import {
  enqueueOpportunityIntelligenceWithStatus,
  type OpportunityIntelligenceEnqueueResult,
} from './opportunity-intelligence-job.js';
import { getCollection } from './smrt.js';

export const OPPORTUNITY_SCORE_REFRESH_SCHEDULE_ID =
  'opportunity-score-refresh';
export const OPPORTUNITY_SCORE_REFRESH_METHOD = 'refreshSavedEvaluationScores';
export const OPPORTUNITY_SCORE_REFRESH_PAGE_SIZE = 25;
export const OPPORTUNITY_SCORE_REFRESH_MAX_ATTEMPTS = 3;
export const OPPORTUNITY_SCORE_REFRESH_RETRY_MS = 15 * 60 * 1_000;

async function requirePrivateScoreRefresh(): Promise<void> {
  const { isSharedHosted } = await import('./app-config.js');
  if (isSharedHosted()) {
    throw new Error(
      'Shared workspace score refresh requires an explicit operator dispatch.',
    );
  }
}

type Database = Awaited<ReturnType<typeof resolveDatabase>>;
type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function listPage(db: Database, afterId: string): Promise<string[]> {
  const result = await db.query(
    `SELECT CAST(id AS TEXT) AS id
      FROM opportunities
      WHERE CAST(id AS TEXT) > ?
        AND status <> 'archived'
        AND EXISTS (
          SELECT 1 FROM evaluation_scores scores
          WHERE scores.opportunity_id = CAST(opportunities.id AS TEXT)
        )
      ORDER BY CAST(id AS TEXT) ASC
      LIMIT ?`,
    [afterId, OPPORTUNITY_SCORE_REFRESH_PAGE_SIZE],
  );
  return result.rows
    .map((row: Record<string, unknown>) => stringValue(row.id))
    .filter(Boolean);
}

async function hasCurrentScore(
  db: Database,
  opportunity: MutableRecord,
  materialFingerprint: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM evaluation_scores
      WHERE opportunity_id = ?
        AND COALESCE(source_content_fingerprint, '') = ?
        AND (
          COALESCE(created_by_profile_id, '') <> ''
          OR (
            ? <> ''
            AND COALESCE(scoring_material_fingerprint, '') = ?
          )
        )
      LIMIT 1`,
    [
      stringValue(opportunity.id),
      stringValue(opportunity.sourceContentFingerprint),
      materialFingerprint,
      materialFingerprint,
    ],
  );
  return result.rows.length > 0;
}

async function setTarget(
  db: Database,
  opportunity: MutableRecord,
  fingerprint: string,
): Promise<'changed' | 'unchanged' | 'stale'> {
  const previous = stringValue(opportunity.scoringMaterialFingerprint);
  if (previous === fingerprint) return 'unchanged';
  const result = await db.query(
    `UPDATE opportunities
        SET scoring_material_fingerprint = ?,
            scoring_refresh_fingerprint = CASE
              WHEN COALESCE(scoring_material_fingerprint, '') <> ? THEN ?
              ELSE scoring_refresh_fingerprint
            END,
            scoring_refresh_attempts = CASE
              WHEN COALESCE(scoring_material_fingerprint, '') <> ? THEN 0
              ELSE scoring_refresh_attempts
            END,
            scoring_refresh_next_attempt_at = CASE
              WHEN COALESCE(scoring_material_fingerprint, '') <> ? THEN NULL
              ELSE scoring_refresh_next_attempt_at
            END
      WHERE id = ?
        AND COALESCE(source_content_fingerprint, '') = ?
        AND COALESCE(scoring_material_fingerprint, '') = ?
        AND COALESCE(scoring_material_fingerprint, '') <> ?`,
    [
      fingerprint,
      fingerprint,
      fingerprint,
      fingerprint,
      fingerprint,
      stringValue(opportunity.id),
      stringValue(opportunity.sourceContentFingerprint),
      previous,
      fingerprint,
    ],
  );
  if ((result.rowCount ?? result.rows.length) > 0) {
    await bumpOpportunityChangeFeed(db, [stringValue(opportunity.id)]);
    return 'changed';
  }
  return 'stale';
}

async function reserveEnqueueAttempt(
  db: Database,
  opportunityId: string,
  fingerprint: string,
  sourceContentFingerprint: string,
  now: Date,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE opportunities
        SET scoring_refresh_attempts = scoring_refresh_attempts + 1,
            scoring_refresh_next_attempt_at = ?
      WHERE id = ?
        AND scoring_material_fingerprint = ?
        AND scoring_refresh_fingerprint = ?
        AND COALESCE(source_content_fingerprint, '') = ?
        AND scoring_refresh_attempts < ?
        AND (
          scoring_refresh_next_attempt_at IS NULL
          OR scoring_refresh_next_attempt_at <= ?
        )`,
    [
      new Date(now.getTime() + OPPORTUNITY_SCORE_REFRESH_RETRY_MS),
      opportunityId,
      fingerprint,
      fingerprint,
      sourceContentFingerprint,
      OPPORTUNITY_SCORE_REFRESH_MAX_ATTEMPTS,
      now,
    ],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

async function persistScoreRefreshCursor(
  db: Database,
  control: MutableRecord,
  cursor: string,
): Promise<void> {
  const controlId = stringValue(control.id);
  if (!controlId)
    throw new Error('Opportunity intelligence control is unavailable.');
  const result = await db.query(
    `UPDATE opportunity_intelligence_controls
        SET score_refresh_cursor = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [cursor, controlId],
  );
  if ((result.rowCount ?? result.rows.length) === 0)
    throw new Error('Opportunity intelligence control is unavailable.');
  control.scoreRefreshCursor = cursor;
}

export async function ensureOpportunityScoreRefreshSchedule(
  db?: Database,
): Promise<void> {
  await requirePrivateScoreRefresh();
  const database = db ?? (await resolveDatabase(getDbConfig()));
  await ensureOpportunityIntelligenceControl();
  const controls = (await getCollection(
    'OpportunityIntelligenceControl',
  )) as unknown as {
    list: (options: Record<string, unknown>) => Promise<MutableRecord[]>;
  };
  const [control] = await controls.list({
    limit: 1,
    where: { controlKey: OPPORTUNITY_INTELLIGENCE_CONTROL_KEY },
  });
  if (!control?.id)
    throw new Error('Opportunity intelligence control is unavailable.');
  const schedules = await AgentScheduleCollection.create({ db: database });
  await schedules.getOrUpsert({
    agentId: String(control.id),
    agentType: '@willgriffin/iolaus-site:OpportunityIntelligenceControl',
    context: '',
    cron: '* * * * *',
    enabled: true,
    maxConcurrent: 1,
    method: OPPORTUNITY_SCORE_REFRESH_METHOD,
    methodArgs: {},
    nextRun: new Date(),
    slug: OPPORTUNITY_SCORE_REFRESH_SCHEDULE_ID,
    status: 'active',
    timeout: 60_000,
    timezone: 'UTC',
  });
}

export async function reconcileSavedOpportunityScores(
  control: MutableRecord,
  options: {
    db?: Database;
    enqueue?: (
      opportunityId: string,
      args: {
        contentFingerprint: string;
        contentVersion: number;
        modes: 'score';
        reason: string;
        scoringMaterialFingerprint: string;
      },
    ) => Promise<OpportunityIntelligenceEnqueueResult>;
    now?: Date;
  } = {},
): Promise<{
  cursor: string;
  enqueued: number;
  scanned: number;
  skipped: number;
}> {
  await requirePrivateScoreRefresh();
  const db = options.db ?? (await resolveDatabase(getDbConfig()));
  const now = options.now ?? new Date();
  const ids = await listPage(db, stringValue(control.scoreRefreshCursor));
  const opportunities = (await getCollection('Opportunity', {
    db,
  })) as unknown as {
    get: (id: string) => Promise<MutableRecord | null>;
  };
  let enqueued = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      const opportunity = await opportunities.get(id);
      if (!opportunity) continue;
      const material = await scoringMaterialForOpportunity(opportunity);
      if (!material?.fingerprint || !material.sourceContentFingerprint) {
        skipped += 1;
        continue;
      }
      // This exact read is intentionally fail-closed. A collection outage must
      // not look like missing candidate evidence and fan out refresh work.
      if (await hasCurrentScore(db, opportunity, material.fingerprint)) {
        await setTarget(db, opportunity, material.fingerprint);
        skipped += 1;
        continue;
      }
      const target = await setTarget(db, opportunity, material.fingerprint);
      if (target === 'stale') continue;
      const changed = target === 'changed';
      const retryAt = dateValue(opportunity.scoringRefreshNextAttemptAt);
      const attempts = changed
        ? 0
        : numberValue(opportunity.scoringRefreshAttempts);
      if (
        attempts >= OPPORTUNITY_SCORE_REFRESH_MAX_ATTEMPTS ||
        (!changed && retryAt && retryAt.getTime() > now.getTime())
      ) {
        skipped += 1;
        continue;
      }
      // Reserve before enqueue so a crash cannot produce an unbounded stream
      // of duplicate work. A reservation with no job becomes retryable after
      // the same bounded backoff.
      if (
        !(await reserveEnqueueAttempt(
          db,
          id,
          material.fingerprint,
          material.sourceContentFingerprint,
          now,
        ))
      ) {
        skipped += 1;
        continue;
      }
      const enqueue =
        options.enqueue ??
        (async (opportunityId, args) =>
          await enqueueOpportunityIntelligenceWithStatus(opportunityId, args, {
            reason: args.reason,
          }));
      const result = await enqueue(id, {
        contentFingerprint: material.sourceContentFingerprint,
        contentVersion: material.sourceContentVersion,
        modes: 'score',
        reason: 'saved-score-refresh',
        scoringMaterialFingerprint: material.fingerprint,
      });
      if (result.enqueued) enqueued += 1;
      else skipped += 1;
    } catch {
      // Advance the durable cursor after a row-local failure; a later tick can
      // retry it without starving every following saved evaluation.
      skipped += 1;
    }
  }
  await persistScoreRefreshCursor(
    db,
    control,
    ids.length < OPPORTUNITY_SCORE_REFRESH_PAGE_SIZE ? '' : (ids.at(-1) ?? ''),
  );
  return {
    cursor: stringValue(control.scoreRefreshCursor),
    enqueued,
    scanned: ids.length,
    skipped,
  };
}
