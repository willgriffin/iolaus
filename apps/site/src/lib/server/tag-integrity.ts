import { createHash, randomUUID } from 'node:crypto';
import type { resolveDatabase } from '@happyvertical/smrt-core';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

export const TAG_INTEGRITY_REPAIR_ID = '20260811_tag_integrity_v1';
export const TAG_META_TYPE = '@happyvertical/smrt-tags:Tag';

interface TagReferenceSpec {
  table: string;
  parentColumn: string;
  parentTable: string;
  defaultContext: string;
  uniqueColumns: string[];
}

export const tagReferenceSpecs: readonly TagReferenceSpec[] = [
  {
    table: 'skill_category_members',
    parentColumn: 'category_id',
    parentTable: 'skill_categories',
    defaultContext: 'skill',
    uniqueColumns: ['category_id', 'tag_id'],
  },
  {
    table: 'skill_group_members',
    parentColumn: 'group_id',
    parentTable: 'skill_groups',
    defaultContext: 'skill',
    uniqueColumns: ['group_id', 'tag_id'],
  },
  {
    table: 'company_tags',
    parentColumn: 'company_id',
    parentTable: 'companies',
    defaultContext: 'domain',
    uniqueColumns: ['company_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'employment_role_tags',
    parentColumn: 'role_id',
    parentTable: 'employment_roles',
    defaultContext: 'role',
    uniqueColumns: ['role_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'experience_tags',
    parentColumn: 'experience_id',
    parentTable: 'experiences',
    defaultContext: 'skill',
    uniqueColumns: ['experience_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'project_tags',
    parentColumn: 'project_id',
    parentTable: 'projects',
    defaultContext: 'skill',
    uniqueColumns: ['project_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'duty_tags',
    parentColumn: 'duty_id',
    parentTable: 'duties',
    defaultContext: 'skill',
    uniqueColumns: ['duty_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'achievement_tags',
    parentColumn: 'achievement_id',
    parentTable: 'achievements',
    defaultContext: 'skill',
    uniqueColumns: ['achievement_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'education_tags',
    parentColumn: 'education_id',
    parentTable: 'education',
    defaultContext: 'credential',
    uniqueColumns: ['education_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'opportunity_tags',
    parentColumn: 'opportunity_id',
    parentTable: 'opportunities',
    defaultContext: 'global',
    uniqueColumns: ['opportunity_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'decision_tags',
    parentColumn: 'decision_id',
    parentTable: 'decisions',
    defaultContext: 'decision_reason',
    uniqueColumns: ['decision_id', 'tag_id', 'tag_role'],
  },
  {
    table: 'source_tags',
    parentColumn: 'source_id',
    parentTable: 'sources',
    defaultContext: 'source',
    uniqueColumns: ['source_id', 'tag_id', 'tag_role'],
  },
] as const;

interface TagRecord {
  context: string;
  id: string;
  slug: string;
}

interface RepairRow {
  beforeData: Record<string, unknown>;
  context: string;
  fromTagId: string;
  parentId: string;
  rowId: string;
  table: string;
}

interface OrphanRow {
  beforeData: Record<string, unknown>;
  parentId: string;
  rowId: string;
  table: string;
}

export interface PlannedTag {
  context: string;
  name: string;
  slug: string;
}

export interface TagIntegrityPlan {
  canonicalizations: RepairRow[];
  collisions: Array<{ key: string; rowIds: string[]; table: string }>;
  fingerprint: string;
  orphanDeletes: OrphanRow[];
  repairId: typeof TAG_INTEGRITY_REPAIR_ID;
  tagCreations: PlannedTag[];
  unrepairable: Array<{
    reason: string;
    rowId: string;
    table: string;
    value: string;
  }>;
}

export interface TagIntegrityGuardStatus {
  foreignKeysPresent: number;
  foreignKeysTotal: number;
  foreignKeysValidated: number;
  requiredColumnsNotNull: number;
  requiredColumnsTotal: number;
  uniqueIndexesPresent: number;
  uniqueIndexesTotal: number;
}

export interface TagIntegrityRepairResult {
  canonicalizedRows: number;
  createdTags: number;
  deletedOrphans: number;
  fingerprint: string;
  repairId: typeof TAG_INTEGRITY_REPAIR_ID;
}

const contextByRole = new Map<string, string>([
  ['credential', 'credential'],
  ['domain', 'domain'],
  ['industry', 'industry'],
  ['preferred_skill', 'skill'],
  ['preference', 'preference'],
  ['reason', 'decision_reason'],
  ['required_skill', 'skill'],
  ['risk', 'decision_reason'],
  ['role', 'role'],
  ['skill', 'skill'],
  ['source', 'source'],
  ['source_type', 'source'],
  ['technology', 'skill'],
  ['upside', 'decision_reason'],
]);

export function tagContextForRole(
  role: unknown,
  defaultContext: string,
): string {
  const normalized = String(role ?? '').trim();
  return contextByRole.get(normalized) ?? defaultContext;
}

export function tagNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export async function inspectTagIntegrity(
  db: SmrtDatabase,
): Promise<TagIntegrityPlan> {
  const tables = await listTables(db);
  const tags = tables.has('tags') ? await loadTags(db) : [];
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  const tagsByIdentity = new Map(
    tags.map((tag) => [tagIdentity(tag.slug, tag.context), tag]),
  );
  const canonicalizations: RepairRow[] = [];
  const orphanDeletes: OrphanRow[] = [];
  const unrepairable: TagIntegrityPlan['unrepairable'] = [];
  const tagCreations = new Map<string, PlannedTag>();
  const uniqueness = new Map<string, Map<string, string[]>>();

  for (const spec of tagReferenceSpecs) {
    if (
      !tables.has(spec.table) ||
      !tables.has(spec.parentTable) ||
      !tables.has('tags')
    ) {
      continue;
    }

    const result = await db.query(`
      SELECT child.*, to_jsonb(child) AS _repair_row,
             parent.id::text AS _repair_parent_id
      FROM ${quoteIdentifier(spec.table)} child
      LEFT JOIN ${quoteIdentifier(spec.parentTable)} parent
        ON parent.id::text = child.${quoteIdentifier(spec.parentColumn)}::text
      ORDER BY child.id
    `);

    for (const rawRow of result.rows) {
      const row = rawRow as Record<string, unknown>;
      const rowId = stringValue(row.id);
      const parentId = stringValue(row[spec.parentColumn]);
      const beforeData = jsonRecord(row._repair_row);
      if (!rowId) {
        unrepairable.push({
          reason: 'join row has no id',
          rowId,
          table: spec.table,
          value: '',
        });
        continue;
      }
      if (!parentId || !stringValue(row._repair_parent_id)) {
        orphanDeletes.push({ beforeData, parentId, rowId, table: spec.table });
        continue;
      }

      const blankBusinessColumn = spec.uniqueColumns.find(
        (column) =>
          column !== spec.parentColumn &&
          column !== 'tag_id' &&
          !stringValue(row[column]),
      );
      if (blankBusinessColumn) {
        unrepairable.push({
          reason: `required business-key column ${blankBusinessColumn} is blank`,
          rowId,
          table: spec.table,
          value: '',
        });
        continue;
      }

      const fromTagId = stringValue(row.tag_id);
      const context = tagContextForRole(row.tag_role, spec.defaultContext);
      const canonical = tagsById.get(fromTagId);
      let targetKey = canonical?.id ?? '';

      if (!canonical) {
        if (!isSafeTagSlug(fromTagId)) {
          unrepairable.push({
            reason: fromTagId
              ? 'tag reference is not a recoverable slug'
              : 'tag reference is blank',
            rowId,
            table: spec.table,
            value: fromTagId,
          });
          continue;
        }
        const identity = tagIdentity(fromTagId, context);
        const existing = tagsByIdentity.get(identity);
        targetKey = existing?.id ?? `planned:${identity}`;
        if (!existing) {
          tagCreations.set(identity, {
            context,
            name: tagNameFromSlug(fromTagId),
            slug: fromTagId,
          });
        }
        canonicalizations.push({
          beforeData,
          context,
          fromTagId,
          parentId,
          rowId,
          table: spec.table,
        });
      }

      const uniqueParts = spec.uniqueColumns.map((column) => {
        if (column === 'tag_id') return targetKey;
        return stringValue(row[column]);
      });
      const key = uniqueParts.join('\u0000');
      const tableKeys =
        uniqueness.get(spec.table) ?? new Map<string, string[]>();
      const rowIds = tableKeys.get(key) ?? [];
      rowIds.push(rowId);
      tableKeys.set(key, rowIds);
      uniqueness.set(spec.table, tableKeys);
    }
  }

  const collisions = [...uniqueness.entries()]
    .flatMap(([table, keys]) =>
      [...keys.entries()]
        .filter(([, rowIds]) => rowIds.length > 1)
        .map(([key, rowIds]) => ({ key, rowIds: rowIds.sort(), table })),
    )
    .sort(compareTableRow);
  const sortedCanonicalizations = canonicalizations.sort(compareTableRow);
  const sortedOrphans = orphanDeletes.sort(compareTableRow);
  const sortedTags = [...tagCreations.values()].sort((left, right) =>
    tagIdentity(left.slug, left.context).localeCompare(
      tagIdentity(right.slug, right.context),
    ),
  );
  const sortedUnrepairable = unrepairable.sort(compareTableRow);
  const fingerprint = fingerprintPlan({
    canonicalizations: sortedCanonicalizations.map(compactRepairRow),
    collisions,
    orphanDeletes: sortedOrphans.map(compactOrphanRow),
    repairId: TAG_INTEGRITY_REPAIR_ID,
    tagCreations: sortedTags,
    unrepairable: sortedUnrepairable,
  });

  return {
    canonicalizations: sortedCanonicalizations,
    collisions,
    fingerprint,
    orphanDeletes: sortedOrphans,
    repairId: TAG_INTEGRITY_REPAIR_ID,
    tagCreations: sortedTags,
    unrepairable: sortedUnrepairable,
  };
}

export async function ensureTagIntegrityGuards(
  db: SmrtDatabase,
): Promise<TagIntegrityGuardStatus> {
  const tables = await listTables(db);
  for (const spec of tagReferenceSpecs) {
    if (
      !tables.has(spec.table) ||
      !tables.has(spec.parentTable) ||
      !tables.has('tags')
    ) {
      continue;
    }
    await ensureTextReferenceKey(db, 'tags');
    await ensureTextReferenceKey(db, spec.parentTable);
    await addForeignKeyIfMissing(db, {
      column: 'tag_id',
      constraint: tagForeignKeyName(spec),
      onDelete: 'RESTRICT',
      parentTable: 'tags',
      parentColumn: '_integrity_id_text',
      table: spec.table,
    });
    await addForeignKeyIfMissing(db, {
      column: spec.parentColumn,
      constraint: parentForeignKeyName(spec),
      onDelete: 'CASCADE',
      parentTable: spec.parentTable,
      parentColumn: '_integrity_id_text',
      table: spec.table,
    });
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(uniqueIndexName(spec))}
       ON ${quoteIdentifier(spec.table)} (${spec.uniqueColumns.map(quoteIdentifier).join(', ')})`,
    );
  }
  return await getTagIntegrityGuardStatus(db);
}

export async function validateTagIntegrityGuards(
  db: SmrtDatabase,
): Promise<TagIntegrityGuardStatus> {
  const tables = await listTables(db);
  for (const spec of tagReferenceSpecs) {
    if (!tables.has(spec.table)) continue;
    for (const column of new Set(spec.uniqueColumns)) {
      await db.query(
        `ALTER TABLE ${quoteIdentifier(spec.table)}
         ALTER COLUMN ${quoteIdentifier(column)} SET NOT NULL`,
      );
    }
    for (const constraint of [
      tagForeignKeyName(spec),
      parentForeignKeyName(spec),
    ]) {
      if (await constraintExists(db, spec.table, constraint)) {
        await db.query(
          `ALTER TABLE ${quoteIdentifier(spec.table)} VALIDATE CONSTRAINT ${quoteIdentifier(constraint)}`,
        );
      }
    }
  }
  return await getTagIntegrityGuardStatus(db);
}

export async function getTagIntegrityGuardStatus(
  db: SmrtDatabase,
): Promise<TagIntegrityGuardStatus> {
  const tables = await listTables(db);
  let foreignKeysPresent = 0;
  let foreignKeysTotal = 0;
  let foreignKeysValidated = 0;
  let requiredColumnsNotNull = 0;
  let requiredColumnsTotal = 0;
  let uniqueIndexesPresent = 0;
  let uniqueIndexesTotal = 0;

  for (const spec of tagReferenceSpecs) {
    if (!tables.has(spec.table)) continue;
    for (const column of new Set(spec.uniqueColumns)) {
      requiredColumnsTotal += 1;
      const nullable = await db.query(
        `SELECT is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
        [spec.table, column],
      );
      if (nullable.rows[0]?.is_nullable === 'NO') requiredColumnsNotNull += 1;
    }
    uniqueIndexesTotal += 1;
    if (await indexExists(db, uniqueIndexName(spec))) uniqueIndexesPresent += 1;
    for (const constraint of [
      tagForeignKeyName(spec),
      parentForeignKeyName(spec),
    ]) {
      foreignKeysTotal += 1;
      const result = await db.query(
        `SELECT convalidated
         FROM pg_constraint
         WHERE conrelid = ?::regclass AND conname = ?`,
        [spec.table, constraint],
      );
      if (result.rows.length > 0) foreignKeysPresent += 1;
      if (result.rows[0]?.convalidated === true) foreignKeysValidated += 1;
    }
  }

  return {
    foreignKeysPresent,
    foreignKeysTotal,
    foreignKeysValidated,
    requiredColumnsNotNull,
    requiredColumnsTotal,
    uniqueIndexesPresent,
    uniqueIndexesTotal,
  };
}

export async function applyTagIntegrityRepair(
  db: SmrtDatabase,
  options: {
    backupSha256: string;
    expectedFingerprint: string;
  },
): Promise<TagIntegrityRepairResult> {
  if (!/^[a-f0-9]{64}$/u.test(options.backupSha256)) {
    throw new Error('A verified lowercase SHA-256 backup digest is required.');
  }
  if (!db.transaction) {
    throw new Error(
      'Tag integrity repair requires transactional database support.',
    );
  }

  return await db.transaction(async (transaction) => {
    await transaction.query("SET LOCAL lock_timeout = '15s'");
    await transaction.query(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
      TAG_INTEGRITY_REPAIR_ID,
    ]);
    await lockTagIntegrityTables(transaction);
    await ensureAuditTables(transaction);
    const priorRun = await transaction.query(
      'SELECT 1 FROM data_repair_runs WHERE repair_id = ? LIMIT 1',
      [TAG_INTEGRITY_REPAIR_ID],
    );
    if (priorRun.rows.length > 0) {
      throw new Error(
        `Repair ${TAG_INTEGRITY_REPAIR_ID} is already recorded; refusing to reuse its audit identity.`,
      );
    }
    const plan = await inspectTagIntegrity(transaction);
    if (plan.fingerprint !== options.expectedFingerprint) {
      throw new Error(
        `Tag integrity plan changed: expected ${options.expectedFingerprint}, found ${plan.fingerprint}. Inspect again before applying.`,
      );
    }
    if (plan.unrepairable.length > 0 || plan.collisions.length > 0) {
      throw new Error(
        `Refusing repair with ${plan.unrepairable.length} unrepairable rows and ${plan.collisions.length} canonical collisions.`,
      );
    }

    const tagIds = await loadTagIdentityMap(transaction);
    let createdTags = 0;
    for (const tag of plan.tagCreations) {
      const result = await transaction.query(
        `INSERT INTO tags (
           id, slug, context, _meta_type, name, description, metadata,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, '', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (slug, context, _meta_type)
         DO UPDATE SET slug = EXCLUDED.slug
         RETURNING id`,
        [randomUUID(), tag.slug, tag.context, TAG_META_TYPE, tag.name],
      );
      const id = stringValue(result.rows[0]?.id);
      if (!id)
        throw new Error(
          `Could not resolve canonical tag ${tag.context}:${tag.slug}.`,
        );
      tagIds.set(tagIdentity(tag.slug, tag.context), id);
      createdTags += 1;
    }

    for (const row of plan.canonicalizations) {
      const targetTagId = tagIds.get(tagIdentity(row.fromTagId, row.context));
      if (!targetTagId) {
        throw new Error(
          `Missing planned canonical tag ${row.context}:${row.fromTagId}.`,
        );
      }
      await archiveRow(transaction, {
        action: 'canonicalize_tag_id',
        backupSha256: options.backupSha256,
        beforeData: row.beforeData,
        metadata: {
          context: row.context,
          fromTagId: row.fromTagId,
          targetTagId,
        },
        rowId: row.rowId,
        table: row.table,
      });
      const updated = await transaction.query(
        `UPDATE ${quoteIdentifier(row.table)}
         SET tag_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND tag_id = ?`,
        [targetTagId, row.rowId, row.fromTagId],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `Expected to canonicalize exactly one ${row.table} row ${row.rowId}; updated ${updated.rowCount ?? 0}.`,
        );
      }
    }

    for (const row of plan.orphanDeletes) {
      await archiveRow(transaction, {
        action: 'delete_orphan_join',
        backupSha256: options.backupSha256,
        beforeData: row.beforeData,
        metadata: { missingParentId: row.parentId },
        rowId: row.rowId,
        table: row.table,
      });
      const deleted = await transaction.query(
        `DELETE FROM ${quoteIdentifier(row.table)} WHERE id = ?`,
        [row.rowId],
      );
      if (deleted.rowCount !== 1) {
        throw new Error(
          `Expected to delete exactly one orphan ${row.table} row ${row.rowId}; deleted ${deleted.rowCount ?? 0}.`,
        );
      }
    }

    await ensureTagIntegrityGuards(transaction);
    const guards = await validateTagIntegrityGuards(transaction);
    const remaining = await inspectTagIntegrity(transaction);
    if (
      remaining.canonicalizations.length > 0 ||
      remaining.orphanDeletes.length > 0 ||
      remaining.unrepairable.length > 0 ||
      remaining.collisions.length > 0
    ) {
      throw new Error(
        'Tag integrity repair verification found remaining invalid rows.',
      );
    }
    if (
      guards.foreignKeysValidated !== guards.foreignKeysTotal ||
      guards.requiredColumnsNotNull !== guards.requiredColumnsTotal ||
      guards.uniqueIndexesPresent !== guards.uniqueIndexesTotal
    ) {
      throw new Error(
        'Tag integrity database guards are incomplete after repair.',
      );
    }

    const result: TagIntegrityRepairResult = {
      canonicalizedRows: plan.canonicalizations.length,
      createdTags,
      deletedOrphans: plan.orphanDeletes.length,
      fingerprint: plan.fingerprint,
      repairId: TAG_INTEGRITY_REPAIR_ID,
    };
    await transaction.query(
      `INSERT INTO data_repair_runs (
         repair_id, plan_sha256, backup_sha256, summary, completed_at
       ) VALUES (?, ?, ?, CAST(? AS jsonb), CURRENT_TIMESTAMP)
       ON CONFLICT (repair_id) DO NOTHING`,
      [
        TAG_INTEGRITY_REPAIR_ID,
        plan.fingerprint,
        options.backupSha256,
        JSON.stringify(result),
      ],
    );
    return result;
  });
}

function compactRepairRow(row: RepairRow) {
  return {
    context: row.context,
    fromTagId: row.fromTagId,
    parentId: row.parentId,
    rowId: row.rowId,
    table: row.table,
  };
}

function compactOrphanRow(row: OrphanRow) {
  return {
    parentId: row.parentId,
    rowId: row.rowId,
    table: row.table,
  };
}

function fingerprintPlan(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function loadTags(db: SmrtDatabase): Promise<TagRecord[]> {
  const result = await db.query(
    `SELECT id::text AS id, slug, context
     FROM tags
     WHERE _meta_type = ?
     ORDER BY context, slug, id`,
    [TAG_META_TYPE],
  );
  return result.rows.map((row) => ({
    context: stringValue(row.context),
    id: stringValue(row.id),
    slug: stringValue(row.slug),
  }));
}

async function loadTagIdentityMap(
  db: SmrtDatabase,
): Promise<Map<string, string>> {
  return new Map(
    (await loadTags(db)).map((tag) => [
      tagIdentity(tag.slug, tag.context),
      tag.id,
    ]),
  );
}

async function listTables(db: SmrtDatabase): Promise<Set<string>> {
  const result = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  return new Set(result.rows.map((row) => stringValue(row.tablename)));
}

async function lockTagIntegrityTables(db: SmrtDatabase): Promise<void> {
  const existing = await listTables(db);
  const tables = new Set<string>(['tags']);
  for (const spec of tagReferenceSpecs) {
    tables.add(spec.table);
    tables.add(spec.parentTable);
  }
  const lockable = [...tables].filter((table) => existing.has(table)).sort();
  if (lockable.length === 0) return;
  await db.query(
    `LOCK TABLE ${lockable.map(quoteIdentifier).join(', ')} IN SHARE ROW EXCLUSIVE MODE`,
  );
}

async function ensureTextReferenceKey(
  db: SmrtDatabase,
  table: string,
): Promise<void> {
  await db.query(
    `ALTER TABLE ${quoteIdentifier(table)}
     ADD COLUMN IF NOT EXISTS _integrity_id_text TEXT
     GENERATED ALWAYS AS (id::text) STORED`,
  );
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${table}_integrity_id_text_uidx`)}
     ON ${quoteIdentifier(table)} (_integrity_id_text)`,
  );
}

async function addForeignKeyIfMissing(
  db: SmrtDatabase,
  options: {
    column: string;
    constraint: string;
    onDelete: 'CASCADE' | 'RESTRICT';
    parentColumn: string;
    parentTable: string;
    table: string;
  },
): Promise<void> {
  if (await constraintExists(db, options.table, options.constraint)) return;
  await db.query(
    `ALTER TABLE ${quoteIdentifier(options.table)}
     ADD CONSTRAINT ${quoteIdentifier(options.constraint)}
     FOREIGN KEY (${quoteIdentifier(options.column)})
     REFERENCES ${quoteIdentifier(options.parentTable)} (${quoteIdentifier(options.parentColumn)})
     ON UPDATE CASCADE ON DELETE ${options.onDelete}
     NOT VALID`,
  );
}

async function constraintExists(
  db: SmrtDatabase,
  table: string,
  constraint: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM pg_constraint
     WHERE conrelid = ?::regclass AND conname = ?
     LIMIT 1`,
    [table, constraint],
  );
  return result.rows.length > 0;
}

async function indexExists(db: SmrtDatabase, index: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = ?
     LIMIT 1`,
    [index],
  );
  return result.rows.length > 0;
}

async function ensureAuditTables(db: SmrtDatabase): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS data_repair_runs (
      repair_id TEXT PRIMARY KEY,
      plan_sha256 TEXT NOT NULL,
      backup_sha256 TEXT NOT NULL,
      summary JSONB NOT NULL,
      completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS data_repair_audit (
      id TEXT PRIMARY KEY,
      repair_id TEXT NOT NULL REFERENCES data_repair_runs(repair_id) DEFERRABLE INITIALLY DEFERRED,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_data JSONB NOT NULL,
      metadata JSONB NOT NULL,
      backup_sha256 TEXT NOT NULL,
      archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (repair_id, table_name, row_id, action)
    )
  `);
}

async function archiveRow(
  db: SmrtDatabase,
  options: {
    action: string;
    backupSha256: string;
    beforeData: Record<string, unknown>;
    metadata: Record<string, unknown>;
    rowId: string;
    table: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO data_repair_audit (
       id, repair_id, table_name, row_id, action, before_data, metadata,
       backup_sha256
     ) VALUES (?, ?, ?, ?, ?, CAST(? AS jsonb), CAST(? AS jsonb), ?)
     ON CONFLICT (repair_id, table_name, row_id, action) DO NOTHING`,
    [
      randomUUID(),
      TAG_INTEGRITY_REPAIR_ID,
      options.table,
      options.rowId,
      options.action,
      JSON.stringify(options.beforeData),
      JSON.stringify(options.metadata),
      options.backupSha256,
    ],
  );
}

function tagIdentity(slug: string, context: string): string {
  return `${context}\u0000${slug}`;
}

function tagForeignKeyName(spec: TagReferenceSpec): string {
  return `${spec.table}_tag_integrity_fkey`;
}

function parentForeignKeyName(spec: TagReferenceSpec): string {
  return `${spec.table}_parent_integrity_fkey`;
}

function uniqueIndexName(spec: TagReferenceSpec): string {
  return `${spec.table}_canonical_identity_uidx`;
}

function isSafeTagSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  throw new Error('Database did not return a repairable row snapshot.');
}

function compareTableRow(
  left: { rowId?: string; table: string },
  right: { rowId?: string; table: string },
): number {
  return (
    left.table.localeCompare(right.table) ||
    String(left.rowId ?? '').localeCompare(String(right.rowId ?? ''))
  );
}
