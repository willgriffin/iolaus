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
type QueryableDatabase = Pick<SmrtDatabase, 'query'>;

function normalizeIndexDefinition(value: unknown): string {
  return String(value ?? '')
    .split(/('(?:''|[^'])*')/g)
    .map((part, index) =>
      index % 2 === 0
        ? part
            .toLowerCase()
            .replaceAll('"', '')
            .replace(/::(?:text|character varying)/g, '')
            .replace(/\b[a-z_][a-z0-9_]*\._smrt_jobs\b/g, '_smrt_jobs')
            .replace(/[\s()]+/g, '')
        : part,
    )
    .join('');
}

let dedupeIndexPromise: Promise<void> | null = null;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function expectedOpportunityIntelligenceActiveIndexDefinition(): string {
  return normalizeIndexDefinition(`
    CREATE UNIQUE INDEX ${OPPORTUNITY_INTELLIGENCE_ACTIVE_JOB_INDEX}
      ON _smrt_jobs USING btree (
        queue,
        object_type,
        object_id,
        method,
        (COALESCE(args ->> 'contentFingerprint', ''))
      )
      WHERE status = ANY (ARRAY['pending', 'running'])
        AND queue = ${sqlString(OPPORTUNITY_INTELLIGENCE_QUEUE)}
        AND object_type = ${sqlString(OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE)}
        AND method = ${sqlString(OPPORTUNITY_INTELLIGENCE_METHOD)}
        AND object_id IS NOT NULL
  `);
}

async function applyOpportunityIntelligenceJobDedupe(
  db: SmrtDatabase,
): Promise<void> {
  const installed = await getOpportunityIntelligenceJobDedupeStatus(db);
  if (installed.activeIndexNamed && !installed.activeIndexPresent) {
    await db.query(`DROP INDEX ${OPPORTUNITY_INTELLIGENCE_ACTIVE_JOB_INDEX}`);
  }

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

  const attested = await getOpportunityIntelligenceJobDedupeStatus(db);
  if (!attested.activeIndexPresent) {
    throw new Error(
      'Opportunity-intelligence active-job uniqueness index is not ready.',
    );
  }
}

export async function getOpportunityIntelligenceJobDedupeStatus(
  db: QueryableDatabase,
): Promise<{ activeIndexNamed: boolean; activeIndexPresent: boolean }> {
  const result = await db.query(
    `SELECT
       indexes.indisunique AS is_unique,
       indexes.indisvalid AS is_valid,
       indexes.indisready AS is_ready,
       pg_get_indexdef(indexes.indexrelid) AS index_definition
     FROM pg_class AS index_relation
     INNER JOIN pg_namespace AS index_namespace
       ON index_namespace.oid = index_relation.relnamespace
     INNER JOIN pg_index AS indexes
       ON indexes.indexrelid = index_relation.oid
     INNER JOIN pg_class AS table_relation
       ON table_relation.oid = indexes.indrelid
     INNER JOIN pg_namespace AS table_namespace
       ON table_namespace.oid = table_relation.relnamespace
     WHERE index_namespace.nspname = current_schema()
       AND table_namespace.nspname = current_schema()
       AND table_relation.relname = '_smrt_jobs'
       AND index_relation.relname = ?`,
    [OPPORTUNITY_INTELLIGENCE_ACTIVE_JOB_INDEX],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const activeIndexNamed = result.rows.length === 1;
  const activeIndexPresent = Boolean(
    activeIndexNamed &&
      row?.is_unique === true &&
      row?.is_valid === true &&
      row?.is_ready === true &&
      normalizeIndexDefinition(row?.index_definition) ===
        expectedOpportunityIntelligenceActiveIndexDefinition(),
  );
  return { activeIndexNamed, activeIndexPresent };
}

async function verifyOpportunityIntelligenceJobDedupe(
  db: SmrtDatabase,
): Promise<void> {
  if (
    !(await getOpportunityIntelligenceJobDedupeStatus(db)).activeIndexPresent
  ) {
    throw new Error(
      'Opportunity-intelligence job dedupe index is missing; run db:migrate as the migration owner before activating runtime roles.',
    );
  }
}

export async function ensureOpportunityIntelligenceJobDedupe(
  db?: SmrtDatabase,
): Promise<void> {
  if (db) {
    await applyOpportunityIntelligenceJobDedupe(db);
    return;
  }

  dedupeIndexPromise ??= resolveDatabase(getDbConfig())
    .then(verifyOpportunityIntelligenceJobDedupe)
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
