import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';

export const CANDIDATE_ANSWER_NATURAL_KEY_INDEX =
  'candidate_answers_profile_key_label_key_idx';
const CANDIDATE_ANSWER_INDEX_LOCK_TIMEOUT = '15s';
const CANDIDATE_ANSWER_INDEX_STATEMENT_TIMEOUT = '60s';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type QueryResult =
  | { rows?: Record<string, unknown>[] }
  | Record<string, unknown>[];

let candidateAnswerNaturalKeyPromise: Promise<void> | null = null;

function rowsFromResult(result: QueryResult): Record<string, unknown>[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function candidateAnswerTableExists(db: SmrtDatabase): Promise<boolean> {
  const result = await db.query(
    'SELECT to_regclass(\'candidate_answers\') IS NOT NULL AS "exists"',
  );
  return rowsFromResult(result as QueryResult)[0]?.exists === true;
}

/**
 * SMRT's generated schema owns new CandidateAnswer tables, but early deployed
 * versions used its default slug/context key. Add the explicit natural-key
 * index during every migration run so existing databases accept the model's
 * `(profile_key, label_key)` upsert target too.
 *
 * The first feature deployment could not save any reusable answer once the
 * model switched keys, so duplicate cleanup is defensive compatibility for
 * pre-release or manually populated databases. Retain the newest row for each
 * complete natural key before enforcing the invariant.
 */
async function applyCandidateAnswerNaturalKeyIndex(
  db: SmrtDatabase,
): Promise<void> {
  if (typeof db.acquireSession !== 'function') {
    throw new Error(
      'CandidateAnswer schema compatibility requires a PostgreSQL session.',
    );
  }

  const session = await db.acquireSession();
  let committed = false;
  try {
    await session.query('BEGIN');
    // This work uses its own pinned session rather than the outer advisory
    // lock session, so apply local bounds here too. A deployment must fail
    // cleanly instead of waiting indefinitely behind application traffic.
    await session.query("SELECT set_config('lock_timeout', $1, true)", [
      CANDIDATE_ANSWER_INDEX_LOCK_TIMEOUT,
    ]);
    await session.query("SELECT set_config('statement_timeout', $1, true)", [
      CANDIDATE_ANSWER_INDEX_STATEMENT_TIMEOUT,
    ]);
    // The migration lock serializes deployers, while this brief table lock also
    // prevents application writes from racing the cleanup/index boundary.
    await session.query(
      'LOCK TABLE candidate_answers IN ACCESS EXCLUSIVE MODE',
    );
    // An index with this name but a different definition would make `IF NOT
    // EXISTS` silently preserve a broken UPSERT target. Refuse to touch rows
    // until that operator-managed inconsistency is corrected.
    await session.query(`
      DO $$
      BEGIN
        -- A cancelled concurrent index build leaves an invalid catalog entry
        -- with this name. It cannot protect data or satisfy ON CONFLICT, so
        -- remove it while the table is locked and rebuild it below.
        IF EXISTS (
          SELECT 1
          FROM pg_index AS index_definition
          JOIN pg_class AS index_relation
            ON index_relation.oid = index_definition.indexrelid
          JOIN pg_class AS table_relation
            ON table_relation.oid = index_definition.indrelid
          WHERE table_relation.oid = 'candidate_answers'::regclass
            AND index_relation.relname = '${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}'
            AND index_relation.relnamespace = current_schema()::regnamespace
            AND NOT index_definition.indisvalid
        ) THEN
          EXECUTE 'DROP INDEX IF EXISTS ${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_class AS index_relation
          WHERE index_relation.relname = '${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}'
            AND index_relation.relnamespace = current_schema()::regnamespace
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_index AS index_definition
          JOIN pg_class AS index_relation
            ON index_relation.oid = index_definition.indexrelid
          JOIN pg_class AS table_relation
            ON table_relation.oid = index_definition.indrelid
          WHERE table_relation.oid = 'candidate_answers'::regclass
            AND index_relation.relname = '${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}'
            AND index_definition.indisvalid
            AND index_definition.indisunique
            AND index_definition.indpred IS NULL
            AND index_definition.indnkeyatts = 2
            AND NOT EXISTS (
              SELECT 1
              FROM pg_constraint AS constraint_definition
              WHERE constraint_definition.conindid = index_definition.indexrelid
                AND constraint_definition.condeferrable
            )
            AND (
              SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
              FROM unnest(index_definition.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = index_definition.indrelid
               AND attribute.attnum = key_column.attnum
              WHERE key_column.ordinality <= index_definition.indnkeyatts
            ) = ARRAY['profile_key', 'label_key']::name[]
        ) THEN
          RAISE EXCEPTION
            'Index % exists but is not the required valid unique CandidateAnswer natural key',
            '${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}';
        END IF;
      END
      $$
    `);
    await session.query(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY profile_key, label_key
            ORDER BY updated_at DESC, created_at DESC, id DESC
          ) AS duplicate_rank
        FROM candidate_answers
        WHERE profile_key IS NOT NULL
          AND label_key IS NOT NULL
      )
      DELETE FROM candidate_answers AS answer
      USING ranked
      WHERE answer.id = ranked.id
        AND ranked.duplicate_rank > 1
    `);
    await session.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}
        ON candidate_answers (profile_key, label_key)
    `);
    await session.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_index AS index_definition
          JOIN pg_class AS index_relation
            ON index_relation.oid = index_definition.indexrelid
          JOIN pg_class AS table_relation
            ON table_relation.oid = index_definition.indrelid
          WHERE table_relation.oid = 'candidate_answers'::regclass
            AND index_relation.relname = '${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}'
            AND index_definition.indisvalid
            AND index_definition.indisunique
            AND index_definition.indpred IS NULL
            AND index_definition.indnkeyatts = 2
            AND NOT EXISTS (
              SELECT 1
              FROM pg_constraint AS constraint_definition
              WHERE constraint_definition.conindid = index_definition.indexrelid
                AND constraint_definition.condeferrable
            )
            AND (
              SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
              FROM unnest(index_definition.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = index_definition.indrelid
               AND attribute.attnum = key_column.attnum
              WHERE key_column.ordinality <= index_definition.indnkeyatts
            ) = ARRAY['profile_key', 'label_key']::name[]
        ) THEN
          RAISE EXCEPTION
            'Missing valid unique CandidateAnswer natural-key index %',
            '${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}';
        END IF;
      END
      $$
    `);
    await session.query('COMMIT');
    committed = true;
  } catch (error) {
    if (!committed) {
      try {
        await session.query('ROLLBACK');
      } catch {
        // The original migration error is more useful to the deployer.
      }
    }
    throw error;
  } finally {
    await session.release();
  }
}

export async function ensureCandidateAnswerNaturalKeyIndex(
  db?: SmrtDatabase,
): Promise<void> {
  if (db) {
    await applyCandidateAnswerNaturalKeyIndex(db);
    return;
  }

  candidateAnswerNaturalKeyPromise ??= resolveDatabase(getDbConfig())
    .then(applyCandidateAnswerNaturalKeyIndex)
    .catch((error: unknown) => {
      candidateAnswerNaturalKeyPromise = null;
      throw error;
    });
  await candidateAnswerNaturalKeyPromise;
}

/**
 * Prepare a legacy CandidateAnswer table before SMRT's generated migration
 * examines its new conflict index. A fresh database has no table yet, so the
 * pre-pass intentionally does nothing and the post-migration ensure creates
 * the index after the generated schema creates the table.
 */
export async function repairExistingCandidateAnswerNaturalKeyIndex(
  db?: SmrtDatabase,
): Promise<void> {
  const database = db ?? (await resolveDatabase(getDbConfig()));
  if (!(await candidateAnswerTableExists(database))) return;
  await applyCandidateAnswerNaturalKeyIndex(database);
}
