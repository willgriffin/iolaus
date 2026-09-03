import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';

export const AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE =
  '@willgriffin/iolaus-site:Application';
export const AUTO_SUBMIT_APPLICATION_QUEUE = 'auto-submit-applications';
export const AUTO_SUBMIT_APPLICATION_METHOD = 'autoSubmit';
export const AUTO_SUBMIT_APPLICATION_TIMEOUT_MS = 5 * 60 * 1000;

const AUTO_SUBMIT_APPLICATION_ACTIVE_JOB_INDEX =
  'idx_smrt_jobs_auto_submit_application_active';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

let dedupeIndexPromise: Promise<void> | null = null;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Idempotency safety: at most one active auto-submit job per application. This
// guards the "never submit twice" requirement at the queue level even if an
// enqueue is triggered more than once.
async function applyAutoSubmitApplicationJobDedupe(
  db: SmrtDatabase,
): Promise<void> {
  await db.query(
    `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY queue, object_type, object_id, method
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
      AUTO_SUBMIT_APPLICATION_QUEUE,
      AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
      AUTO_SUBMIT_APPLICATION_METHOD,
      'Cancelled duplicate active auto-submit job before enforcing active-job uniqueness.',
    ],
  );

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${AUTO_SUBMIT_APPLICATION_ACTIVE_JOB_INDEX}
      ON _smrt_jobs (queue, object_type, object_id, method)
      WHERE status IN ('pending', 'running')
        AND queue = ${sqlString(AUTO_SUBMIT_APPLICATION_QUEUE)}
        AND object_type = ${sqlString(AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE)}
        AND method = ${sqlString(AUTO_SUBMIT_APPLICATION_METHOD)}
        AND object_id IS NOT NULL
  `);
}

export async function ensureAutoSubmitApplicationJobDedupe(
  db?: SmrtDatabase,
): Promise<void> {
  if (db) {
    await applyAutoSubmitApplicationJobDedupe(db);
    return;
  }

  dedupeIndexPromise ??= resolveDatabase(getDbConfig())
    .then(applyAutoSubmitApplicationJobDedupe)
    .catch((error: unknown) => {
      dedupeIndexPromise = null;
      throw error;
    });
  await dedupeIndexPromise;
}

export function isAutoSubmitApplicationActiveJobConflict(
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
      value.includes(AUTO_SUBMIT_APPLICATION_ACTIVE_JOB_INDEX),
    )
  );
}
