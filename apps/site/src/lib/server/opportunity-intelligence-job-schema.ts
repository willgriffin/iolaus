import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';

export const OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE =
  '@willgriffin/iolaus-site:Opportunity';
export const OPPORTUNITY_INTELLIGENCE_QUEUE = 'opportunity-intelligence';
export const OPPORTUNITY_INTELLIGENCE_METHOD = 'processIntelligence';
export const OPPORTUNITY_INTELLIGENCE_TIMEOUT_MS = 3 * 60 * 1000;

const LEGACY_OPPORTUNITY_INTELLIGENCE_ACTIVE_JOB_INDEX =
  'idx_smrt_jobs_opportunity_intelligence_active';
const OPPORTUNITY_INTELLIGENCE_ACTIVE_JOB_INDEX =
  'idx_smrt_jobs_opportunity_intelligence_active_fingerprint';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

let dedupeIndexPromise: Promise<void> | null = null;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function applyOpportunityIntelligenceJobDedupe(
  db: SmrtDatabase,
): Promise<void> {
  await db.query(
    `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY
              queue,
              object_type,
              object_id,
              method,
              COALESCE(args ->> 'contentFingerprint', '')
            ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
          ) AS duplicate_rank
        FROM _smrt_jobs
        WHERE status IN ('pending', 'running')
          AND queue = ?
          AND object_type = ?
          AND method = ?
          AND object_id IS NOT NULL
      )
      UPDATE _smrt_jobs AS jobs
      SET status = 'cancelled',
          last_error = ?,
          worker_id = NULL,
          worker_heartbeat = NULL
      WHERE jobs.id IN (
        SELECT id FROM ranked WHERE duplicate_rank > 1
      )
    `,
    [
      OPPORTUNITY_INTELLIGENCE_QUEUE,
      OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
      OPPORTUNITY_INTELLIGENCE_METHOD,
      'Cancelled duplicate active opportunity intelligence job before enforcing active-job uniqueness.',
    ],
  );

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${OPPORTUNITY_INTELLIGENCE_ACTIVE_JOB_INDEX}
      ON _smrt_jobs (
        queue,
        object_type,
        object_id,
        method,
        (COALESCE(args ->> 'contentFingerprint', ''))
      )
      WHERE status IN ('pending', 'running')
        AND queue = ${sqlString(OPPORTUNITY_INTELLIGENCE_QUEUE)}
        AND object_type = ${sqlString(OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE)}
        AND method = ${sqlString(OPPORTUNITY_INTELLIGENCE_METHOD)}
        AND object_id IS NOT NULL
  `);

  // #205 used opportunity-only uniqueness. Keep it until the fingerprint-aware
  // index exists, then remove it so materially changed content can queue its
  // own version while the older version remains auditable.
  await db.query(
    `DROP INDEX IF EXISTS ${LEGACY_OPPORTUNITY_INTELLIGENCE_ACTIVE_JOB_INDEX}`,
  );
}

export async function ensureOpportunityIntelligenceJobDedupe(
  db?: SmrtDatabase,
): Promise<void> {
  if (db) {
    await applyOpportunityIntelligenceJobDedupe(db);
    return;
  }

  dedupeIndexPromise ??= resolveDatabase(getDbConfig())
    .then(applyOpportunityIntelligenceJobDedupe)
    .catch((error: unknown) => {
      dedupeIndexPromise = null;
      throw error;
    });
  await dedupeIndexPromise;
}

export function isOpportunityIntelligenceActiveJobConflict(
  error: unknown,
): boolean {
  const values: string[] = [];
  let cursor: unknown = error;

  while (cursor && typeof cursor === 'object') {
    const record = cursor as Record<string, unknown>;
    for (const key of ['code', 'constraint', 'message']) {
      const value = record[key];
      if (typeof value === 'string') values.push(value);
    }
    cursor = record.cause;
  }

  return (
    values.some((value) =>
      /(?:^|\b)(?:code\s*[=:]\s*)?23505(?:\b|$)/i.test(value),
    ) &&
    values.some((value) =>
      value.includes(OPPORTUNITY_INTELLIGENCE_ACTIVE_JOB_INDEX),
    )
  );
}
