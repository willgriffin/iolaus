import { randomUUID } from 'node:crypto';
import type { resolveDatabase } from '@happyvertical/smrt-core';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type QueryableDatabase = Pick<SmrtDatabase, 'query'>;

export const SOURCE_ROLES = ['root', 'posting_derived', 'unknown'] as const;
export const SOURCE_PARENT_FOREIGN_KEY = 'sources_parent_source_fk';
export const SOURCE_PARENT_FORWARD_TRIGGER = 'sources_parent_provenance_guard';
export const SOURCE_PARENT_REVERSE_TRIGGER = 'sources_parent_reverse_guard';
export const SOURCE_ROLE_CHECK_CONSTRAINT = 'sources_source_role_check';
const SOURCE_PARENT_FORWARD_FUNCTION = 'enforce_source_parent_provenance';
const SOURCE_PARENT_REVERSE_FUNCTION =
  'enforce_source_parent_reverse_provenance';
export const SOURCE_PROVENANCE_BACKFILL_VERSION =
  '20260831_source_provenance_authoritative_backfill';
export type SourceRole = (typeof SOURCE_ROLES)[number];

export interface SourceProvenanceRecord {
  id?: unknown;
  isActive?: unknown;
  parentSourceId?: unknown;
  sourceRole?: unknown;
}

export interface SourceProvenanceBackfillSummary {
  postingDerived: number;
  promotedRoots: number;
  unknown: number;
}

export interface SourceProvenanceSchemaStatus {
  parentForeignKeyPresent: boolean;
  parentForeignKeyValidated: boolean;
  parentForwardTriggerPresent: boolean;
  parentReverseTriggerPresent: boolean;
  sourceRoleCheckPresent: boolean;
  sourceRoleCheckValidated: boolean;
  sourceRoleRequired: boolean;
}

export function sourceProvenanceSchemaIsReady(
  status: SourceProvenanceSchemaStatus,
): boolean {
  return (
    status.sourceRoleRequired &&
    status.sourceRoleCheckPresent &&
    status.sourceRoleCheckValidated &&
    status.parentForeignKeyPresent &&
    status.parentForeignKeyValidated &&
    status.parentForwardTriggerPresent &&
    status.parentReverseTriggerPresent
  );
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCatalogSql(value: unknown): string {
  return stringValue(value)
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/\bpublic\./g, '')
    .replace(/::(?:text|character varying)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

const SOURCE_ROLE_CHECK_DEFINITION = normalizeCatalogSql(`
  CHECK (source_role IS NOT NULL
    AND (source_role = ANY (ARRAY['root', 'posting_derived', 'unknown']))
    AND (
      source_role = 'root' AND NULLIF(btrim(parent_source_id), '') IS NULL
      OR source_role = 'posting_derived' AND NULLIF(btrim(parent_source_id), '') IS NOT NULL AND is_active IS FALSE
      OR source_role = 'unknown' AND NULLIF(btrim(parent_source_id), '') IS NULL AND is_active IS FALSE
    ))
`);

const SOURCE_PARENT_FOREIGN_KEY_DEFINITION = normalizeCatalogSql(`
  FOREIGN KEY (parent_source_id) REFERENCES sources(id)
  ON DELETE RESTRICT DEFERRABLE
`);

const SOURCE_PARENT_FORWARD_TRIGGER_DEFINITION = normalizeCatalogSql(`
  CREATE CONSTRAINT TRIGGER ${SOURCE_PARENT_FORWARD_TRIGGER}
  AFTER INSERT OR UPDATE OF source_role, parent_source_id ON sources
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION ${SOURCE_PARENT_FORWARD_FUNCTION}()
`);

const SOURCE_PARENT_REVERSE_TRIGGER_DEFINITION = normalizeCatalogSql(`
  CREATE TRIGGER ${SOURCE_PARENT_REVERSE_TRIGGER}
  BEFORE DELETE OR UPDATE OF source_role, parent_source_id ON sources
  FOR EACH ROW EXECUTE FUNCTION ${SOURCE_PARENT_REVERSE_FUNCTION}()
`);

const SOURCE_PARENT_FORWARD_FUNCTION_BODY = `
  BEGIN
    IF NEW.source_role = 'posting_derived' THEN
      PERFORM 1
      FROM sources AS parent
      WHERE parent.id = NEW.parent_source_id
        AND parent.id <> NEW.id
        AND parent.source_role = 'root'
        AND NULLIF(BTRIM(parent.parent_source_id::text), '') IS NULL
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'posting-derived source requires an existing distinct root parent';
      END IF;
    END IF;
    RETURN NEW;
  END;
`;

const SOURCE_PARENT_REVERSE_FUNCTION_BODY = `
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF EXISTS (
        SELECT 1 FROM sources AS child
        WHERE child.parent_source_id = OLD.id
      ) THEN
        RAISE EXCEPTION 'root source with posting-derived children cannot be deleted';
      END IF;
      RETURN OLD;
    END IF;
    IF (
      NEW.source_role IS DISTINCT FROM 'root'
      OR NULLIF(BTRIM(NEW.parent_source_id::text), '') IS NOT NULL
    ) AND EXISTS (
      SELECT 1 FROM sources AS child
      WHERE child.parent_source_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'root source with posting-derived children cannot change provenance';
    END IF;
    RETURN NEW;
  END;
`;

export function sourceRole(value: unknown): SourceRole {
  const role = stringValue(value);
  return SOURCE_ROLES.includes(role as SourceRole)
    ? (role as SourceRole)
    : 'unknown';
}

export function isOperableRootSource(source: SourceProvenanceRecord): boolean {
  return (
    sourceRole(source.sourceRole) === 'root' &&
    !stringValue(source.parentSourceId)
  );
}

export function assertOperableRootSource(source: SourceProvenanceRecord): void {
  if (!isOperableRootSource(source)) {
    throw new Error(
      'Source is not an explicitly classified root source. Reconcile its durable provenance before activation or crawl.',
    );
  }
}

export function assertActiveOperableRootSource(
  source: SourceProvenanceRecord,
): void {
  assertOperableRootSource(source);
  if (source.isActive !== true) {
    throw new Error(
      'Source is not explicitly active. Enable the root source before crawling it.',
    );
  }
}

/**
 * Reconcile only durable provenance. An explicit parent is authoritative child
 * evidence; a prior direct crawl is authoritative legacy root evidence. Rows
 * with neither remain unknown and therefore cannot be operated through the
 * curated surface. Names, URLs, and descriptive notes are never consulted.
 */
export async function backfillSourceProvenance(
  db: QueryableDatabase,
  options: { promoteLegacyRoots?: boolean } = {},
): Promise<SourceProvenanceBackfillSummary> {
  await db.query(`
    UPDATE sources
    SET source_role = 'posting_derived',
        is_active = FALSE,
        updated_at = CURRENT_TIMESTAMP
    WHERE NULLIF(BTRIM(parent_source_id::text), '') IS NOT NULL
      AND (
        source_role IS DISTINCT FROM 'posting_derived'
        OR is_active IS DISTINCT FROM FALSE
      )
  `);
  const promotedRoots =
    options.promoteLegacyRoots === false
      ? { rows: [] }
      : await db.query(`
          UPDATE sources AS source
          SET source_role = 'root',
              is_active = FALSE,
              parent_source_id = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE COALESCE(NULLIF(BTRIM(source.source_role), ''), 'unknown') = 'unknown'
            AND NULLIF(BTRIM(source.parent_source_id::text), '') IS NULL
            AND EXISTS (
              SELECT 1 FROM source_crawls AS crawl
              WHERE crawl.source_id = source.id::text
            )
          RETURNING source.id
        `);
  await db.query(`
    UPDATE sources AS child
    SET source_role = 'unknown',
        is_active = FALSE,
        parent_source_id = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE child.source_role = 'posting_derived'
      AND NOT EXISTS (
        SELECT 1
        FROM sources AS parent
        WHERE parent.id = child.parent_source_id
          AND parent.id <> child.id
          AND parent.source_role = 'root'
          AND NULLIF(BTRIM(parent.parent_source_id::text), '') IS NULL
      )
  `);
  await db.query(`
    UPDATE sources
    SET source_role = 'unknown',
        is_active = FALSE,
        parent_source_id = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE COALESCE(NULLIF(BTRIM(source_role), ''), 'unknown') NOT IN (
        'root', 'posting_derived'
      )
      OR (
        source_role = 'unknown'
        AND is_active IS DISTINCT FROM FALSE
      )
  `);
  const counts = await db.query(`
    SELECT source_role AS role, COUNT(*)::integer AS count
    FROM sources
    GROUP BY source_role
  `);
  const countByRole = new Map(
    counts.rows.map((row) => [stringValue(row.role), Number(row.count) || 0]),
  );
  return {
    postingDerived: countByRole.get('posting_derived') ?? 0,
    promotedRoots: promotedRoots.rows.length,
    unknown: countByRole.get('unknown') ?? 0,
  };
}

async function applySourceProvenanceSchema(
  db: SmrtDatabase,
  promoteLegacyRoots: boolean,
): Promise<SourceProvenanceBackfillSummary> {
  await db.query('LOCK TABLE sources IN SHARE ROW EXCLUSIVE MODE');
  const summary = await backfillSourceProvenance(db, { promoteLegacyRoots });
  await db.query(`
    ALTER TABLE sources
    DROP CONSTRAINT IF EXISTS sources_source_role_check
  `);
  await db.query(`
    ALTER TABLE sources
    ALTER COLUMN source_role SET NOT NULL
  `);
  await db.query(`
    ALTER TABLE sources
    ADD CONSTRAINT sources_source_role_check
    CHECK (
      source_role IS NOT NULL
      AND source_role IN ('root', 'posting_derived', 'unknown')
      AND (
        (source_role = 'root' AND NULLIF(BTRIM(parent_source_id::text), '') IS NULL)
        OR
        (source_role = 'posting_derived' AND NULLIF(BTRIM(parent_source_id::text), '') IS NOT NULL AND is_active IS FALSE)
        OR
        (source_role = 'unknown' AND NULLIF(BTRIM(parent_source_id::text), '') IS NULL AND is_active IS FALSE)
      )
    )
    NOT VALID
  `);
  await db.query(`
    ALTER TABLE sources VALIDATE CONSTRAINT sources_source_role_check
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS sources_parent_source_idx
    ON sources (parent_source_id)
    WHERE NULLIF(BTRIM(parent_source_id::text), '') IS NOT NULL
  `);
  await db.query(`
    ALTER TABLE sources
    DROP CONSTRAINT IF EXISTS ${SOURCE_PARENT_FOREIGN_KEY}
  `);
  await db.query(`
    ALTER TABLE sources
    ADD CONSTRAINT ${SOURCE_PARENT_FOREIGN_KEY}
    FOREIGN KEY (parent_source_id) REFERENCES sources(id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE
    NOT VALID
  `);
  await db.query(`
    ALTER TABLE sources VALIDATE CONSTRAINT ${SOURCE_PARENT_FOREIGN_KEY}
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION ${SOURCE_PARENT_FORWARD_FUNCTION}()
    RETURNS trigger AS $$${SOURCE_PARENT_FORWARD_FUNCTION_BODY}$$ LANGUAGE plpgsql
  `);
  await db.query(`
    DROP TRIGGER IF EXISTS ${SOURCE_PARENT_FORWARD_TRIGGER} ON sources
  `);
  await db.query(`
    CREATE CONSTRAINT TRIGGER ${SOURCE_PARENT_FORWARD_TRIGGER}
    AFTER INSERT OR UPDATE OF source_role, parent_source_id ON sources
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION ${SOURCE_PARENT_FORWARD_FUNCTION}()
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION ${SOURCE_PARENT_REVERSE_FUNCTION}()
    RETURNS trigger AS $$${SOURCE_PARENT_REVERSE_FUNCTION_BODY}$$ LANGUAGE plpgsql
  `);
  await db.query(`
    DROP TRIGGER IF EXISTS ${SOURCE_PARENT_REVERSE_TRIGGER} ON sources
  `);
  await db.query(`
    CREATE TRIGGER ${SOURCE_PARENT_REVERSE_TRIGGER}
    BEFORE DELETE OR UPDATE OF source_role, parent_source_id ON sources
    FOR EACH ROW EXECUTE FUNCTION ${SOURCE_PARENT_REVERSE_FUNCTION}()
  `);
  return summary;
}

export async function ensureSourceProvenanceSchema(
  db: SmrtDatabase,
): Promise<SourceProvenanceBackfillSummary> {
  if (!db.transaction) {
    throw new Error(
      'Source provenance schema installation requires a database transaction.',
    );
  }
  return await db.transaction(async (transaction) => {
    const marker = await transaction.query(
      'SELECT 1 FROM _smrt_migrations WHERE version = ? LIMIT 1',
      [SOURCE_PROVENANCE_BACKFILL_VERSION],
    );
    const promoteLegacyRoots = marker.rows.length === 0;
    const summary = await applySourceProvenanceSchema(
      transaction,
      promoteLegacyRoots,
    );
    if (promoteLegacyRoots) {
      await transaction.query(
        `INSERT INTO _smrt_migrations (id, version, description)
         VALUES (?, ?, ?)
         ON CONFLICT(version) DO NOTHING`,
        [
          randomUUID(),
          SOURCE_PROVENANCE_BACKFILL_VERSION,
          'Authoritative legacy source provenance backfill',
        ],
      );
    }
    return summary;
  });
}

export async function getSourceProvenanceSchemaStatus(
  db: QueryableDatabase,
): Promise<SourceProvenanceSchemaStatus> {
  const foreignKey = await db.query(
    `SELECT contype AS "type",
            convalidated AS "validated",
            pg_get_constraintdef(oid, true) AS "definition"
     FROM pg_constraint
     WHERE conrelid = 'sources'::regclass
       AND conname = ?`,
    [SOURCE_PARENT_FOREIGN_KEY],
  );
  const forwardTrigger = await db.query(
    `SELECT trigger.tgenabled AS "enabled",
            trigger.tgisinternal AS "internal",
            procedure.proname AS "functionName",
            namespace.nspname = current_schema() AS "functionInCurrentSchema",
            language.lanname AS "language",
            procedure.prorettype = 'trigger'::regtype AS "returnsTrigger",
            procedure.pronargs AS "argumentCount",
            procedure.prosecdef AS "securityDefiner",
            procedure.provolatile AS "volatility",
            procedure.prosrc AS "functionBody",
            pg_get_triggerdef(trigger.oid, true) AS "definition"
     FROM pg_trigger AS trigger
     JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
     JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     JOIN pg_language AS language ON language.oid = procedure.prolang
     WHERE trigger.tgrelid = 'sources'::regclass
       AND trigger.tgname = ?`,
    [SOURCE_PARENT_FORWARD_TRIGGER],
  );
  const reverseTrigger = await db.query(
    `SELECT trigger.tgenabled AS "enabled",
            trigger.tgisinternal AS "internal",
            procedure.proname AS "functionName",
            namespace.nspname = current_schema() AS "functionInCurrentSchema",
            language.lanname AS "language",
            procedure.prorettype = 'trigger'::regtype AS "returnsTrigger",
            procedure.pronargs AS "argumentCount",
            procedure.prosecdef AS "securityDefiner",
            procedure.provolatile AS "volatility",
            procedure.prosrc AS "functionBody",
            pg_get_triggerdef(trigger.oid, true) AS "definition"
     FROM pg_trigger AS trigger
     JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
     JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     JOIN pg_language AS language ON language.oid = procedure.prolang
     WHERE trigger.tgrelid = 'sources'::regclass
       AND trigger.tgname = ?`,
    [SOURCE_PARENT_REVERSE_TRIGGER],
  );
  const sourceRoleColumn = await db.query(
    `SELECT is_nullable AS "isNullable"
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'sources'
       AND column_name = 'source_role'`,
  );
  const sourceRoleCheck = await db.query(
    `SELECT contype AS "type",
            convalidated AS "validated",
            pg_get_constraintdef(oid, true) AS "definition"
     FROM pg_constraint
     WHERE conrelid = 'sources'::regclass
       AND conname = ?`,
    [SOURCE_ROLE_CHECK_CONSTRAINT],
  );
  const canonicalTrigger = (
    row: Record<string, unknown> | undefined,
    expected: {
      body: string;
      definition: string;
      functionName: string;
    },
  ): boolean =>
    row?.enabled === 'O' &&
    row.internal === false &&
    row.functionName === expected.functionName &&
    row.functionInCurrentSchema === true &&
    row.language === 'plpgsql' &&
    row.returnsTrigger === true &&
    Number(row.argumentCount) === 0 &&
    row.securityDefiner === false &&
    row.volatility === 'v' &&
    normalizeCatalogSql(row.definition) === expected.definition &&
    normalizeCatalogSql(row.functionBody) ===
      normalizeCatalogSql(expected.body);
  const canonicalForeignKey =
    foreignKey.rows.length === 1 &&
    foreignKey.rows[0]?.type === 'f' &&
    normalizeCatalogSql(foreignKey.rows[0]?.definition) ===
      SOURCE_PARENT_FOREIGN_KEY_DEFINITION;
  const canonicalRoleCheck =
    sourceRoleCheck.rows.length === 1 &&
    sourceRoleCheck.rows[0]?.type === 'c' &&
    normalizeCatalogSql(sourceRoleCheck.rows[0]?.definition) ===
      SOURCE_ROLE_CHECK_DEFINITION;
  return {
    parentForeignKeyPresent: canonicalForeignKey,
    parentForeignKeyValidated: foreignKey.rows[0]?.validated === true,
    parentForwardTriggerPresent:
      forwardTrigger.rows.length === 1 &&
      canonicalTrigger(forwardTrigger.rows[0], {
        body: SOURCE_PARENT_FORWARD_FUNCTION_BODY,
        definition: SOURCE_PARENT_FORWARD_TRIGGER_DEFINITION,
        functionName: SOURCE_PARENT_FORWARD_FUNCTION,
      }),
    parentReverseTriggerPresent:
      reverseTrigger.rows.length === 1 &&
      canonicalTrigger(reverseTrigger.rows[0], {
        body: SOURCE_PARENT_REVERSE_FUNCTION_BODY,
        definition: SOURCE_PARENT_REVERSE_TRIGGER_DEFINITION,
        functionName: SOURCE_PARENT_REVERSE_FUNCTION,
      }),
    sourceRoleCheckPresent: canonicalRoleCheck,
    sourceRoleCheckValidated: sourceRoleCheck.rows[0]?.validated === true,
    sourceRoleRequired: sourceRoleColumn.rows[0]?.isNullable === 'NO',
  };
}
