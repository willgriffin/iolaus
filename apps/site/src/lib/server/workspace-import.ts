import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilesystemInterface } from '@happyvertical/files';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { type AppConfigEnvironment, isSharedHosted } from './app-config.js';
import {
  type BundleManifest,
  type BundleTableEntry,
  type ColumnInfo,
  canonicalJson,
  catalogReferenceColumns,
  catalogTables,
  driverCode,
  foreignKeyOrder,
  loadBundle,
  orderParentsFirst,
  ownedTables,
  PLAN_VERSION,
  quoted,
  RECEIPT_FORMAT,
  readBundleRows,
  rowsOf,
  sanitizeCatalogRow,
  selfReferenceColumns,
  sha256Hex,
  skippedOwnerTables,
  type TransferDatabase,
  type TransferDialect,
  tableColumns,
  tablesWithColumns,
  text,
  tupleColumns,
  WorkspaceTransferError,
} from './workspace-transfer.js';

/**
 * Import an exported private workspace into a hosted (shared-mode) account,
 * PRESERVING the source tenant, user and profile ids.
 *
 * Why ids are preserved: the question-screening fingerprints stored on
 * assessments, ranks and AI proof receipts hash the subject
 * `{tenantId, userId, profileId}` and the evidence row ids. Re-keying them would
 * make every rank stale and cannot be recomputed without the AI model.
 *
 * Plan and apply share one code path. `--dry-run` runs the whole import inside a
 * transaction and rolls it back; `--apply` runs it again and refuses to commit
 * unless the digest of what it did equals the reviewed digest, so the plan that
 * was reviewed is exactly the plan that is applied.
 */

export interface WorkspaceImportOptions {
  bundleDir: string;
  database: TransferDatabase;
  /** Keep every imported source in its current active state unless set. */
  deactivateSources?: boolean;
  dialect: TransferDialect;
  email: string;
  environment?: AppConfigEnvironment;
  expectedPlanSha256?: string;
  filesystem?: Pick<
    FilesystemInterface,
    'delete' | 'exists' | 'read' | 'write'
  >;
  mode: 'apply' | 'dry-run';
  /** Required for `--apply`: the rollback receipt (ids only, mode 0600). */
  receiptPath?: string;
  /** Test seam: SMRT options bound to the active transaction handle. */
  smrtOptions?: (database: TransferDatabase) => SmrtClassOptions;
}

export interface TableImportStats {
  blankedActorReferences: number;
  deduped: number;
  droppedColumns: string[];
  existing: number;
  inserted: number;
  rows: number;
}

export interface WorkspaceImportPlan {
  assets: { conflicts: number; identical: number; toUpload: number };
  dedupeSha256: string;
  eligible: boolean;
  identity: { create: boolean };
  /** Problems by table or area; counts only. A non-empty map blocks apply. */
  issues: Record<string, number>;
  /** Consequences that do not block apply but the operator must see. */
  warnings: Record<string, number>;
  tables: Record<string, TableImportStats>;
}

export interface WorkspaceImportResult {
  mode: 'applied' | 'dry-run';
  plan: WorkspaceImportPlan;
  planSha256: string;
  receiptPath?: string;
}

export interface WorkspaceImportReceipt {
  assets: string[];
  bundleSha256: string;
  createdAt: string;
  format: typeof RECEIPT_FORMAT;
  identity: {
    created: boolean;
    membershipIds: string[];
    profileId: string;
    tenantId: string;
    userId: string;
  };
  inserted: Record<string, string[]>;
  planSha256: string;
  version: 1;
}

const BATCH = 500;
const ACTOR_COLUMN =
  /(_user_id$|_profile_id$|^created_by$|^decider_|reviewed_by|submitted_by|approved_by|assigned_to)/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SNAPSHOT_COLUMNS = [
  'required_skills_snapshot',
  'preferred_skills_snapshot',
] as const;

class DryRunComplete extends Error {
  constructor(readonly result: WorkspaceImportResult) {
    super('dry-run');
  }
}

function normalizedEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new WorkspaceTransferError(
      'identity',
      'A valid --email is required.',
    );
  }
  return value;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function bindable(value: unknown, dialect: TransferDialect): unknown {
  if (value === undefined) return null;
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean' && dialect === 'sqlite') return value ? 1 : 0;
  return value;
}

function joinKey(row: Record<string, unknown>, parent: string): string | null {
  const parentId = text(row[parent]);
  const tagId = text(row.tag_id);
  return parentId && tagId
    ? `${parentId}|${tagId}|${text(row.tag_role)}`
    : null;
}

function naturalKey(
  table: string,
  row: Record<string, unknown>,
): string | null {
  switch (table) {
    case 'tags':
      return `${text(row.slug)}|${text(row.context)}|${text(row._meta_type)}`;
    case 'companies':
      return text(row.company_key) || text(row.slug) || null;
    case 'sources':
      return `${text(row.slug)}|${text(row.context)}`;
    case 'opportunities':
      return text(row.canonical_url) || null;
    // Join rows are unique per (parent, tag, role); the unique index would
    // otherwise abort the import when a deduped parent already has the tag.
    case 'source_tags':
      return joinKey(row, 'source_id');
    case 'company_tags':
      return joinKey(row, 'company_id');
    case 'opportunity_tags':
      return joinKey(row, 'opportunity_id');
    default:
      return null;
  }
}

interface ImportContext {
  bundle: BundleManifest;
  email: string;
  environment: AppConfigEnvironment;
  identityCreated: boolean;
  issues: Record<string, number>;
  warnings: Record<string, number>;
  maps: Record<
    'company' | 'opportunity' | 'source' | 'tag',
    Map<string, string>
  >;
  options: WorkspaceImportOptions;
  inserted: Record<string, string[]>;
  tables: Record<string, TableImportStats>;
}

function addIssue(context: ImportContext, key: string, count = 1): void {
  context.issues[key] = (context.issues[key] ?? 0) + count;
}

async function existingKeys(
  tx: TransferDatabase,
  table: string,
  columns: Set<string>,
): Promise<Map<string, string>> {
  const wanted = [
    'slug',
    'context',
    '_meta_type',
    'company_key',
    'canonical_url',
    'source_id',
    'company_id',
    'opportunity_id',
    'tag_id',
    'tag_role',
  ]
    .filter((column) => columns.has(column))
    .map(quoted);
  const rows = rowsOf(
    await tx.query(
      `SELECT CAST(id AS TEXT) AS id${wanted.length ? `, ${wanted.join(', ')}` : ''}
         FROM ${quoted(table)}`,
    ),
  );
  const keys = new Map<string, string>();
  for (const row of rows) {
    const key = naturalKey(table, row);
    if (key && !keys.has(key)) keys.set(key, text(row.id));
  }
  return keys;
}

function remapReferences(
  context: ImportContext,
  table: string,
  row: Record<string, unknown>,
): void {
  for (const [column, kind] of Object.entries(catalogReferenceColumns)) {
    const value = text(row[column]);
    if (!value) continue;
    const mapped = context.maps[kind].get(value);
    if (mapped) {
      row[column] = mapped;
      if (
        mapped !== value &&
        kind === 'opportunity' &&
        ownedTables.includes(table)
      ) {
        // The screening fingerprints hash the opportunity id, so proofs that
        // point at a deduped opportunity cannot stay current.
        const key = `${table}: points at an opportunity deduped to an existing row (screening proofs go stale)`;
        context.warnings[key] = (context.warnings[key] ?? 0) + 1;
      }
    }
  }
}

async function importTable(
  tx: TransferDatabase,
  context: ImportContext,
  table: string,
  entry: BundleTableEntry,
  targetColumns: ColumnInfo[],
): Promise<void> {
  const { options, bundle } = context;
  const { dialect } = options;
  const identity = bundle.identity;
  const targetNames = new Set(targetColumns.map((column) => column.name));
  const copied = entry.columns.filter((column) => targetNames.has(column));
  const stats: TableImportStats = {
    blankedActorReferences: 0,
    deduped: 0,
    droppedColumns: entry.columns.filter((column) => !targetNames.has(column)),
    existing: 0,
    inserted: 0,
    rows: 0,
  };
  context.tables[table] = stats;
  const missingRequired = targetColumns.filter(
    (column) =>
      column.notNull &&
      !column.hasDefault &&
      column.name !== 'id' &&
      !copied.includes(column.name),
  );
  if (missingRequired.length) {
    addIssue(context, `${table}: required target column missing from bundle`);
  }
  const isCatalog = entry.kind === 'catalog';
  const keyMap = isCatalog
    ? await existingKeys(tx, table, targetNames)
    : new Map<string, string>();
  const mapKind =
    table === 'tags'
      ? 'tag'
      : table === 'companies'
        ? 'company'
        : table === 'sources'
          ? 'source'
          : table === 'opportunities'
            ? 'opportunity'
            : null;
  const hasSlugContext = targetNames.has('slug') && targetNames.has('context');
  const knownActors = new Set([
    identity.userId,
    identity.smrtProfileId,
    identity.candidateProfileId,
  ]);
  context.inserted[table] = [];

  const flush = async (batch: Array<Record<string, unknown>>) => {
    if (!batch.length) return;
    const ids = batch.map((row) => text(row.id));
    const tupleSelect = tupleColumns
      .filter((column) => targetNames.has(column))
      .map((column) => `CAST(${quoted(column)} AS TEXT) AS ${quoted(column)}`);
    const found = new Map<string, Record<string, unknown>>(
      rowsOf(
        await tx.query(
          `SELECT CAST(id AS TEXT) AS id${tupleSelect.length ? `, ${tupleSelect.join(', ')}` : ''}
             FROM ${quoted(table)}
            WHERE CAST(id AS TEXT) IN (${placeholders(ids.length)})`,
          ids,
        ),
      ).map((row) => [text(row.id), row]),
    );
    const fresh: Array<Record<string, unknown>> = [];
    for (const row of batch) {
      // Catalog references are remapped here, after any parent row of this
      // table has recorded its own dedupe mapping.
      if (isCatalog) remapReferences(context, table, row);
      const id = text(row.id);
      const present = found.get(id);
      if (present) {
        stats.existing += 1;
        if (mapKind) context.maps[mapKind].set(id, id);
        if (!isCatalog) {
          for (const column of tupleColumns) {
            if (
              column in present &&
              text(present[column]) !==
                text(
                  column === 'tenant_id'
                    ? identity.tenantId
                    : column === 'owner_user_id'
                      ? identity.userId
                      : identity.candidateProfileId,
                )
            ) {
              addIssue(context, `${table}: id held by another owner`);
            }
          }
        }
        continue;
      }
      if (isCatalog) {
        const key = naturalKey(table, row);
        const hit = key ? keyMap.get(key) : undefined;
        if (hit) {
          stats.deduped += 1;
          if (mapKind) context.maps[mapKind].set(id, hit);
          continue;
        }
        if (mapKind) context.maps[mapKind].set(id, id);
      }
      fresh.push(row);
    }
    if (hasSlugContext && fresh.length) {
      const taken = rowsOf(
        await tx.query(
          `SELECT CAST(id AS TEXT) AS id, slug, context FROM ${quoted(table)}
            WHERE slug IN (${placeholders(fresh.length)})`,
          fresh.map((row) => text(row.slug)),
        ),
      );
      const takenKeys = new Set(
        taken.map((row) => `${text(row.slug)}|${text(row.context)}`),
      );
      for (const row of fresh) {
        if (takenKeys.has(`${text(row.slug)}|${text(row.context)}`)) {
          addIssue(context, `${table}: slug/context already taken`);
        }
      }
    }
    if (!fresh.length) return;
    const perRow = copied.length;
    const chunk = Math.max(1, Math.floor(4000 / Math.max(1, perRow)));
    for (let start = 0; start < fresh.length; start += chunk) {
      const rows = fresh.slice(start, start + chunk);
      const sql = `INSERT INTO ${quoted(table)} (${copied.map(quoted).join(', ')}) VALUES ${rows
        .map(() => `(${placeholders(perRow)})`)
        .join(', ')}`;
      try {
        await tx.query(
          sql,
          rows.flatMap((row) =>
            copied.map((column) => bindable(row[column], dialect)),
          ),
        );
      } catch (error) {
        // Driver messages can quote row values; report only the SQLSTATE.
        throw new WorkspaceTransferError(
          'insert-failed',
          `Insert into ${table} failed (${driverCode(error)}).`,
        );
      }
      stats.inserted += rows.length;
      for (const row of rows) context.inserted[table].push(text(row.id));
    }
  };

  let batch: Array<Record<string, unknown>> = [];
  // Self-referencing tables (source trees) are inserted parents first.
  const selfReferences = await selfReferenceColumns(tx, dialect, table);
  const buffered: Array<Record<string, unknown>> = [];
  const enqueue = async (row: Record<string, unknown>) => {
    batch.push(row);
    if (batch.length >= BATCH) {
      await flush(batch);
      batch = [];
    }
  };
  for await (const raw of readBundleRows(options.bundleDir, table)) {
    stats.rows += 1;
    let row: Record<string, unknown> = raw;
    if (isCatalog) {
      row = sanitizeCatalogRow(table, row);
      if (table === 'sources' && options.deactivateSources) {
        row = {
          ...row,
          is_active: dialect === 'sqlite' ? 0 : false,
          next_check_at: null,
        };
      }
    } else {
      row = { ...row };
      const expected: Record<string, string> = {
        candidate_profile_id: identity.candidateProfileId,
        owner_user_id: identity.userId,
        tenant_id: identity.tenantId,
      };
      for (const [column, value] of Object.entries(expected)) {
        if (column in row && text(row[column]) !== value) {
          // candidate_profiles has no profile column; others must match.
          addIssue(context, `${table}: row outside the owner tuple`);
        }
      }
      for (const [column, value] of Object.entries(row)) {
        if (
          typeof value === 'string' &&
          UUID.test(value) &&
          !(column in expected) &&
          ACTOR_COLUMN.test(column) &&
          !knownActors.has(value)
        ) {
          row[column] = '';
          stats.blankedActorReferences += 1;
        }
      }
      remapReferences(context, table, row);
    }
    if (selfReferences.length) buffered.push(row);
    else await enqueue(row);
  }
  for (const row of orderParentsFirst(buffered, selfReferences)) {
    await enqueue(row);
  }
  await flush(batch);
}

async function provisionIdentity(
  tx: TransferDatabase,
  context: ImportContext,
  receipt: WorkspaceImportReceipt['identity'],
): Promise<void> {
  const { bundle, email } = context;
  const { identity } = bundle;
  const byEmail = rowsOf(
    await tx.query(
      `SELECT CAST(id AS TEXT) AS id, CAST(profile_id AS TEXT) AS profile_id
         FROM users WHERE lower(email) = ?`,
      [email],
    ),
  );
  const byId = rowsOf(
    await tx.query(
      `SELECT lower(email) AS email FROM users WHERE CAST(id AS TEXT) = ?`,
      [identity.userId],
    ),
  );
  const tenantRows = rowsOf(
    await tx.query('SELECT slug FROM tenants WHERE CAST(id AS TEXT) = ?', [
      identity.tenantId,
    ]),
  );
  const profileRows = rowsOf(
    await tx.query(
      'SELECT 1 AS present FROM profiles WHERE CAST(id AS TEXT) = ?',
      [identity.smrtProfileId],
    ),
  );

  if (byEmail.length || byId.length) {
    const same =
      byEmail.length === 1 &&
      text(byEmail[0].id) === identity.userId &&
      text(byEmail[0].profile_id) === identity.smrtProfileId &&
      tenantRows.length === 1;
    if (!same) {
      throw new WorkspaceTransferError(
        'identity',
        'An account already exists for this address or user id with different ids. The import must preserve ids; remove the existing empty account first (account:delete) and retry.',
      );
    }
    const membership = rowsOf(
      await tx.query(
        `SELECT 1 AS present FROM memberships
          WHERE CAST(user_id AS TEXT) = ? AND CAST(tenant_id AS TEXT) = ?`,
        [identity.userId, identity.tenantId],
      ),
    );
    if (!membership.length) {
      throw new WorkspaceTransferError(
        'identity',
        'The existing account has no membership in the workspace tenant.',
      );
    }
    return;
  }
  if (tenantRows.length || profileRows.length) {
    throw new WorkspaceTransferError(
      'identity',
      'The workspace tenant or profile id is already used by a different account.',
    );
  }
  // A fresh identity must not meet leftover rows carrying the same tuple.
  for (const table of ownedTables) {
    const columns = await tableColumns(tx, context.options.dialect, table);
    if (!columns?.some((column) => column.name === 'owner_user_id')) continue;
    const leftover = rowsOf(
      await tx.query(
        `SELECT COUNT(*) AS n FROM ${quoted(table)}
          WHERE CAST(tenant_id AS TEXT) = ? OR CAST(owner_user_id AS TEXT) = ?`,
        [identity.tenantId, identity.userId],
      ),
    );
    if (Number(leftover[0]?.n ?? 0) > 0) {
      addIssue(context, `${table}: rows already carry the owner tuple`);
    }
  }

  const smrtOptions =
    context.options.smrtOptions?.(tx) ?? ({ db: tx } as SmrtClassOptions);
  const db = (smrtOptions as { db: never }).db;
  const { Person, ProfileCollection, ProfileTypeCollection } = await import(
    '@happyvertical/smrt-profiles'
  );
  const { UserCollection, UserStatus } = await import(
    '@happyvertical/smrt-users'
  );
  const { ensureHostedWorkspaceAccess } = await import('./auth.js');

  const { withSystemContext } = await import('@happyvertical/smrt-tenancy');
  await withSystemContext(async () => {
    const types = await ProfileTypeCollection.create({ db });
    const personType = await types.getOrCreateGlobalBySlug('person', {
      description: 'Individual person profile',
      name: 'Person',
    });
    const person = new Person({
      db,
      email,
      id: identity.smrtProfileId,
      name: email,
      slug: `oidc-${crypto.randomUUID()}`,
      tenantId: null,
      typeId: personType.id,
    } as never);
    await person.initialize();
    await person.save();
    await (
      await ProfileCollection.create({ db })
    ).reserveCanonicalIdentityEmail(identity.smrtProfileId, email);
    const users = await UserCollection.create(smrtOptions);
    const user = await users.create({
      email,
      id: identity.userId,
      profileId: identity.smrtProfileId,
      status: UserStatus.ACTIVE,
    } as never);
    await user.save();
    const { membership, tenant } = await ensureHostedWorkspaceAccess(user, {
      options: smrtOptions,
      tenantId: identity.tenantId,
    });
    if (tenant.id !== identity.tenantId) {
      throw new WorkspaceTransferError(
        'identity',
        'The workspace tenant did not keep the preserved id.',
      );
    }
    receipt.membershipIds.push(String(membership.id));
  });
  context.identityCreated = true;
  receipt.created = true;
}

async function planAssets(
  options: WorkspaceImportOptions,
  bundle: BundleManifest,
): Promise<{
  plan: WorkspaceImportPlan['assets'];
  upload: string[];
}> {
  const plan = { conflicts: 0, identical: 0, toUpload: 0 };
  const upload: string[] = [];
  if (!bundle.assets.length) return { plan, upload };
  if (!options.filesystem) {
    throw new WorkspaceTransferError(
      'bundle',
      'The bundle carries assets but no asset store is configured.',
    );
  }
  for (const asset of bundle.assets) {
    if (await options.filesystem.exists(asset.path)) {
      const current = await options.filesystem.read(asset.path, { raw: true });
      const buffer =
        typeof current === 'string' ? Buffer.from(current) : current;
      if (sha256Hex(buffer) === asset.sha256) plan.identical += 1;
      else plan.conflicts += 1;
    } else {
      plan.toUpload += 1;
      upload.push(asset.path);
    }
  }
  return { plan, upload };
}

function dedupeDigest(context: ImportContext): string {
  const pairs: string[] = [];
  for (const [kind, map] of Object.entries(context.maps)) {
    for (const [from, to] of map)
      if (from !== to) pairs.push(`${kind}:${from}>${to}`);
  }
  return sha256Hex(pairs.sort().join('\n'));
}

export async function importWorkspace(
  options: WorkspaceImportOptions,
): Promise<WorkspaceImportResult> {
  const environment = options.environment ?? process.env;
  if (!isSharedHosted(environment)) {
    throw new WorkspaceTransferError(
      'mode',
      'Workspace import targets a shared hosted deployment (shared workspace mode, non-local profile).',
    );
  }
  if (typeof options.database.transaction !== 'function') {
    throw new WorkspaceTransferError(
      'tenancy',
      'Workspace import requires transactional storage.',
    );
  }
  const email = normalizedEmail(options.email);
  const apply = options.mode === 'apply';
  if (apply && !options.expectedPlanSha256) {
    throw new WorkspaceTransferError(
      'plan-mismatch',
      '--apply requires --expected-plan-sha256 from the reviewed dry run.',
    );
  }
  const bundle = loadBundle(options.bundleDir);
  if (bundle.dialect !== options.dialect) {
    throw new WorkspaceTransferError(
      'dialect',
      `The bundle was exported from ${bundle.dialect} and cannot be imported into ${options.dialect}.`,
    );
  }
  const assetPlan = await planAssets(options, bundle);
  const receiptPath = options.receiptPath ?? '';
  if (apply && !receiptPath) {
    throw new WorkspaceTransferError(
      'receipt',
      '--apply requires --receipt FILE, outside the bundle directory (the bundle is deleted after the import; the receipt is what --rollback needs).',
    );
  }

  const tableNames = [
    ...catalogTables.filter((table) => table in bundle.tables),
    ...ownedTables.filter((table) => table in bundle.tables),
  ];
  const unknown = Object.keys(bundle.tables).filter(
    (table) => !tableNames.includes(table),
  );
  if (unknown.length) {
    throw new WorkspaceTransferError(
      'bundle',
      `The bundle holds table(s) this version does not import: ${unknown.join(', ')}.`,
    );
  }

  try {
    return await options.database.transaction(async (tx) => {
      const context: ImportContext = {
        bundle,
        email,
        environment,
        identityCreated: false,
        inserted: {},
        issues: {},
        warnings: {},
        maps: {
          company: new Map(),
          opportunity: new Map(),
          source: new Map(),
          tag: new Map(),
        },
        options,
        tables: {},
      };
      if (assetPlan.plan.conflicts) {
        addIssue(
          context,
          'assets: key exists with different content',
          assetPlan.plan.conflicts,
        );
      }
      const receiptIdentity: WorkspaceImportReceipt['identity'] = {
        created: false,
        membershipIds: [],
        profileId: bundle.identity.smrtProfileId,
        tenantId: bundle.identity.tenantId,
        userId: bundle.identity.userId,
      };
      await provisionIdentity(tx, context, receiptIdentity);

      const columnsByTable = new Map<string, ColumnInfo[]>();
      for (const table of tableNames) {
        const columns = await tableColumns(tx, options.dialect, table);
        if (!columns) {
          throw new WorkspaceTransferError(
            'schema',
            `Target table ${table} does not exist; run db:migrate first.`,
          );
        }
        columnsByTable.set(table, columns);
      }
      const order = await foreignKeyOrder(tx, options.dialect, tableNames);
      for (const table of order) {
        await importTable(
          tx,
          context,
          table,
          bundle.tables[table],
          columnsByTable.get(table) as ColumnInfo[],
        );
      }
      await backfillRankSnapshots(tx, context);

      const plan: WorkspaceImportPlan = {
        assets: assetPlan.plan,
        dedupeSha256: dedupeDigest(context),
        eligible: Object.keys(context.issues).length === 0,
        identity: { create: context.identityCreated },
        issues: context.issues,
        warnings: context.warnings,
        tables: context.tables,
      };
      const planSha256 = sha256Hex(
        canonicalJson({
          bundleSha256: bundle.bundleSha256,
          deactivateSources: Boolean(options.deactivateSources),
          emailSha256: sha256Hex(email),
          plan,
          version: PLAN_VERSION,
        }),
      );

      if (!apply) {
        throw new DryRunComplete({ mode: 'dry-run', plan, planSha256 });
      }
      if (!plan.eligible) {
        throw new WorkspaceTransferError(
          'collision',
          `The import is blocked: ${JSON.stringify(plan.issues)}.`,
        );
      }
      if (planSha256 !== options.expectedPlanSha256) {
        throw new WorkspaceTransferError(
          'plan-mismatch',
          'The plan digest differs from the reviewed dry run; nothing was written.',
        );
      }
      // The receipt is created exclusively BEFORE anything is uploaded, and it
      // names every bundle asset key (those uploaded now and those already
      // present from an earlier attempt, all derived from the owner's own record
      // ids), so a failure at any later point leaves a record that --rollback or
      // an operator can act on.
      const receipt: WorkspaceImportReceipt = {
        assets: bundle.assets.map((asset) => asset.path),
        bundleSha256: bundle.bundleSha256,
        createdAt: new Date().toISOString(),
        format: RECEIPT_FORMAT,
        identity: receiptIdentity,
        inserted: Object.fromEntries(
          Object.entries(context.inserted).filter(([, ids]) => ids.length),
        ),
        planSha256,
        version: 1,
      };
      try {
        writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        chmodSync(receiptPath, 0o600);
      } catch {
        throw new WorkspaceTransferError(
          'receipt',
          'The rollback receipt could not be created (the path must not already exist); nothing was written.',
        );
      }
      // Assets (idempotent, sha256-verified) before the commit. If anything
      // below fails, the database rolls back and the receipt stays: use it with
      // --rollback to remove the uploaded objects, or delete it once none exist.
      const store = options.filesystem as NonNullable<
        typeof options.filesystem
      >;
      for (const key of assetPlan.upload) {
        const bytes = readFileSync(join(options.bundleDir, 'assets', key));
        await store.write(key, bytes);
        const back = await store.read(key, { raw: true });
        const buffer = typeof back === 'string' ? Buffer.from(back) : back;
        if (sha256Hex(buffer) !== sha256Hex(bytes)) {
          throw new WorkspaceTransferError(
            'asset-conflict',
            'An uploaded asset did not read back identically (receipt kept for --rollback).',
          );
        }
      }
      return { mode: 'applied', plan, planSha256, receiptPath };
    });
  } catch (error) {
    if (error instanceof DryRunComplete) return error.result;
    throw error;
  }
}

async function backfillRankSnapshots(
  tx: TransferDatabase,
  context: ImportContext,
): Promise<void> {
  const table = 'opportunity_recommendation_ranks';
  const entry = context.bundle.tables[table];
  const ids = context.inserted[table] ?? [];
  if (!entry || !ids.length) return;
  if (SNAPSHOT_COLUMNS.every((column) => entry.columns.includes(column)))
    return;
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH);
    await tx.query(
      `UPDATE ${table} SET
         required_skills_snapshot = COALESCE((SELECT o.required_skills FROM opportunities o
            WHERE CAST(o.id AS TEXT) = CAST(${table}.opportunity_id AS TEXT)), ''),
         preferred_skills_snapshot = COALESCE((SELECT o.preferred_skills FROM opportunities o
            WHERE CAST(o.id AS TEXT) = CAST(${table}.opportunity_id AS TEXT)), '')
       WHERE CAST(id AS TEXT) IN (${placeholders(batch.length)})`,
      batch,
    );
  }
}

export interface WorkspaceRollbackOptions {
  database: TransferDatabase;
  dialect: TransferDialect;
  filesystem?: Pick<FilesystemInterface, 'delete' | 'exists'>;
  receiptPath: string;
}

/**
 * Undo one committed import from its receipt: delete exactly the rows it
 * inserted (never rows that already existed), then the identity it created and
 * the asset keys it uploaded. Refuses when the account gained other data or
 * another tenant references an imported catalog row.
 */
export async function rollbackWorkspaceImport(
  options: WorkspaceRollbackOptions,
): Promise<{ deleted: Record<string, number>; assetsRemoved: number }> {
  if (!existsSync(options.receiptPath)) {
    throw new WorkspaceTransferError('receipt', 'The receipt file is missing.');
  }
  const receipt = JSON.parse(
    readFileSync(options.receiptPath, 'utf8'),
  ) as WorkspaceImportReceipt;
  if (receipt.format !== RECEIPT_FORMAT || receipt.version !== 1) {
    throw new WorkspaceTransferError('receipt', 'Unsupported receipt format.');
  }
  if (typeof options.database.transaction !== 'function') {
    throw new WorkspaceTransferError(
      'tenancy',
      'Rollback requires transactional storage.',
    );
  }
  const { dialect } = options;
  const { tenantId, userId, profileId } = receipt.identity;
  const known = new Set<string>([...catalogTables, ...ownedTables]);
  for (const table of Object.keys(receipt.inserted)) {
    if (!known.has(table)) {
      throw new WorkspaceTransferError(
        'receipt',
        'The receipt names a table this version does not manage.',
      );
    }
  }
  const catalogKinds: Record<string, string> = {
    companies: 'company',
    opportunities: 'opportunity',
    sources: 'source',
    tags: 'tag',
  };
  const deleted: Record<string, number> = {};
  await options.database.transaction(async (tx) => {
    const tables = Object.keys(receipt.inserted);
    const order = (await foreignKeyOrder(tx, dialect, tables)).reverse();
    for (const table of order) {
      const ids = receipt.inserted[table];
      const owned = ownedTables.includes(table);
      let count = 0;
      // Receipt ids are in insertion order (parents first). A table that
      // references itself is deleted children first, one row per statement, so
      // parent/child guards never see a parent removed before its children.
      const tree = (await selfReferenceColumns(tx, dialect, table)).length > 0;
      const ordered = tree ? [...ids].reverse() : ids;
      const step = tree ? 1 : BATCH;
      for (let start = 0; start < ordered.length; start += step) {
        const batch = ordered.slice(start, start + step);
        // Owned rows are only ever removed under the receipt's own tuple, so a
        // damaged or edited receipt cannot reach another tenant's data.
        const where = `CAST(id AS TEXT) IN (${placeholders(batch.length)})${
          owned
            ? ' AND CAST(tenant_id AS TEXT) = ? AND CAST(owner_user_id AS TEXT) = ?'
            : ''
        }`;
        const values = owned ? [...batch, tenantId, userId] : batch;
        const present = rowsOf(
          await tx.query(
            `SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE ${where}`,
            values,
          ),
        );
        count += Number(present[0]?.n ?? 0);
        await tx.query(`DELETE FROM ${quoted(table)} WHERE ${where}`, values);
      }
      deleted[table] = count;
    }
    // Nothing left anywhere may still point at a removed shared catalog row:
    // the crawler and other tenants keep adding rows that reference them.
    const referencing = await tablesWithColumns(
      tx,
      dialect,
      Object.keys(catalogReferenceColumns),
    );
    for (const [column, kind] of Object.entries(catalogReferenceColumns)) {
      const ids = Object.entries(catalogKinds)
        .filter(([, k]) => k === kind)
        .flatMap(([table]) => receipt.inserted[table] ?? []);
      if (!ids.length) continue;
      for (const [table, columns] of referencing) {
        if (!columns.includes(column)) continue;
        for (let start = 0; start < ids.length; start += BATCH) {
          const batch = ids.slice(start, start + BATCH);
          const remaining = rowsOf(
            await tx.query(
              `SELECT COUNT(*) AS n FROM ${quoted(table)}
                WHERE CAST(${quoted(column)} AS TEXT) IN (${placeholders(batch.length)})`,
              batch,
            ),
          );
          if (Number(remaining[0]?.n ?? 0) > 0) {
            throw new WorkspaceTransferError(
              'rollback',
              `Rows added after the import still reference imported ${kind} rows (in ${table}); rollback refused and nothing was removed.`,
            );
          }
        }
      }
    }
    if (receipt.identity.created) {
      for (const table of [...ownedTables, ...skippedOwnerTables]) {
        const columns = await tableColumns(tx, dialect, table);
        if (!columns?.some((c) => c.name === 'tenant_id')) continue;
        const left = rowsOf(
          await tx.query(
            `SELECT COUNT(*) AS n FROM ${quoted(table)}
              WHERE CAST(tenant_id AS TEXT) = ?`,
            [tenantId],
          ),
        );
        if (Number(left[0]?.n ?? 0) > 0) {
          throw new WorkspaceTransferError(
            'rollback',
            'The account holds data that is not in the receipt; rollback refused.',
          );
        }
      }
      const identityDeletes: Array<[string, string, string]> = [
        ['sessions', 'user_id', userId],
        ['oidc_identities', 'profile_id', profileId],
        ['oidc_profile_email_reservations', 'profile_id', profileId],
      ];
      for (const [table, column, value] of identityDeletes) {
        if (!(await tableColumns(tx, dialect, table))) continue;
        await tx.query(
          `DELETE FROM ${quoted(table)} WHERE CAST(${quoted(column)} AS TEXT) = ?`,
          [value],
        );
      }
      // Only the membership this import created, never one added since.
      for (const membershipId of receipt.identity.membershipIds) {
        await tx.query(
          `DELETE FROM memberships WHERE CAST(id AS TEXT) = ?
             AND CAST(user_id AS TEXT) = ? AND CAST(tenant_id AS TEXT) = ?`,
          [membershipId, userId, tenantId],
        );
      }
      const finalDeletes: Array<[string, string, string]> = [
        ['users', 'id', userId],
        ['tenants', 'id', tenantId],
        ['profiles', 'id', profileId],
      ];
      for (const [table, column, value] of finalDeletes) {
        if (!(await tableColumns(tx, dialect, table))) continue;
        await tx.query(
          `DELETE FROM ${quoted(table)} WHERE CAST(${quoted(column)} AS TEXT) = ?`,
          [value],
        );
      }
    }
  });
  let assetsRemoved = 0;
  if (options.filesystem) {
    for (const key of receipt.assets) {
      if (await options.filesystem.exists(key)) {
        await options.filesystem.delete(key);
        assetsRemoved += 1;
      }
    }
  }
  return { assetsRemoved, deleted };
}
