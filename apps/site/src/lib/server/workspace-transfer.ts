import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { workspaceOwnershipTables } from './workspace-ownership-backfill.js';

/**
 * Shared contract of `workspace:export` and `workspace:import`: the tables that
 * travel, the tables that never do, the bundle layout and the database seam.
 *
 * Privacy rule for everything built on this module: operator output carries
 * table names and counts only. Row values, identifiers, e-mail addresses and
 * driver error messages (which can quote values) never reach logs.
 */

export type TransferDialect = 'postgres' | 'sqlite';
type QueryResult =
  | { rows?: Array<Record<string, unknown>> }
  | Array<Record<string, unknown>>;

export interface TransferDatabase {
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>;
  transaction?: <T>(
    work: (transaction: TransferDatabase) => Promise<T>,
  ) => Promise<T>;
  url?: string;
}

export type TransferErrorCode =
  | 'asset-conflict'
  | 'bundle'
  | 'collision'
  | 'dialect'
  | 'identity'
  | 'insert-failed'
  | 'mode'
  | 'plan-mismatch'
  | 'receipt'
  | 'rollback'
  | 'schema'
  | 'scope'
  | 'tenancy';

export class WorkspaceTransferError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceTransferError';
  }
}

export const BUNDLE_FORMAT = 'iolaus-workspace-bundle';
export const BUNDLE_VERSION = 1;
export const RECEIPT_FORMAT = 'iolaus-workspace-import-receipt';
export const PLAN_VERSION = 1;

/** Shared, ownerless catalog tables: inserted if absent, deduped by natural key. */
export const catalogTables: readonly string[] = [
  'tags',
  'companies',
  'sources',
  'opportunities',
  'source_tags',
  'company_tags',
  'opportunity_tags',
];

/** Candidate-owned tables keyed by (tenant, owner[, candidate profile]). */
export const ownedTables: readonly string[] = [
  ...new Set([...workspaceOwnershipTables, 'opportunity_recommendation_ranks']),
];

/**
 * Owner-scoped tables that are deliberately NOT carried: the hosted ledger and
 * budgets start empty, assistant turns are transient.
 */
export const skippedOwnerTables: readonly string[] = [
  'admin_assistant_turns',
  'ai_user_budgets',
  'ai_user_spend_entries',
];

/**
 * Never exported even though they hold or sit beside workspace data. Documented
 * in docs/data-export-import.md; kept here so the manifest records the policy.
 */
export const excludedByPolicy: readonly string[] = [
  'company_research (private opinions)',
  'identity, sessions, credentials, provider keys',
  'job queue, change feed, crawl internals',
  'ledger rows outside the owner tuple',
];

export const agentRunTable = 'agent_runs';

/** Columns remapped through the catalog dedupe maps when an id was deduped. */
export const catalogReferenceColumns: Readonly<
  Record<string, 'company' | 'opportunity' | 'source' | 'tag'>
> = {
  company_id: 'company',
  opportunity_id: 'opportunity',
  parent_source_id: 'source',
  source_id: 'source',
  tag_id: 'tag',
  target_opportunity_id: 'opportunity',
};

/** Private fields blanked on shared catalog rows, in the bundle and again on import. */
export const catalogBlankedColumns: Readonly<
  Record<string, readonly string[]>
> = {
  companies: ['organization_profile_id'],
  opportunities: [
    'organization_profile_id',
    'reviewed_by_user_id',
    'reviewed_by_profile_id',
    'source_intelligence_job_id',
  ],
  sources: [
    'login_identity',
    'account_notes',
    'warden_reference',
    'owner',
    'owner_profile_id',
  ],
};

export const tupleColumns = [
  'tenant_id',
  'owner_user_id',
  'candidate_profile_id',
] as const;

export interface BundleIdentity {
  candidateProfileId: string;
  smrtProfileId: string;
  tenantId: string;
  userId: string;
}

export interface BundleTableEntry {
  columns: string[];
  kind: 'catalog' | 'owned';
  rows: number;
  sha256: string;
}

export interface BundleAssetEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface BundleManifest {
  assets: BundleAssetEntry[];
  assetsMissing: number;
  bundleSha256: string;
  createdAt: string;
  dialect: TransferDialect;
  excludedByPolicy: readonly string[];
  format: typeof BUNDLE_FORMAT;
  identity: BundleIdentity;
  skippedOwnerTables: readonly string[];
  tables: Record<string, BundleTableEntry>;
  version: typeof BUNDLE_VERSION;
}

export function rowsOf(result: QueryResult): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export function quoted(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
    throw new WorkspaceTransferError('schema', 'Identifier is invalid.');
  }
  return `"${name}"`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic JSON (sorted keys) so digests do not depend on insertion order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function dialectOf(database: TransferDatabase): TransferDialect {
  const url = database.url ?? '';
  return /^postgres(?:ql)?:/iu.test(url) ? 'postgres' : 'sqlite';
}

export interface ColumnInfo {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
}

/** Columns of `table`, or null when it does not exist. */
export async function tableColumns(
  database: TransferDatabase,
  dialect: TransferDialect,
  table: string,
): Promise<ColumnInfo[] | null> {
  const found =
    dialect === 'sqlite'
      ? rowsOf(await database.query(`PRAGMA table_xinfo(${quoted(table)})`))
          // hidden 2/3 are generated columns: they cannot be written.
          .filter((row) => Number(row.hidden ?? 0) === 0)
          .map((row) => ({
            hasDefault: row.dflt_value != null,
            name: text(row.name),
            notNull: Number(row.notnull) === 1,
          }))
      : rowsOf(
          await database.query(
            `SELECT column_name AS name, is_nullable AS nullable,
                    column_default AS dflt
               FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = ?
                AND is_generated = 'NEVER'
                AND NOT (is_identity = 'YES' AND identity_generation = 'ALWAYS')
              ORDER BY ordinal_position`,
            [table],
          ),
        ).map((row) => ({
          hasDefault: row.dflt != null,
          name: text(row.name),
          notNull: text(row.nullable) === 'NO',
        }));
  return found.length ? found : null;
}

/** Parent-first order of `tables`, from the database's own foreign keys. */
export async function foreignKeyOrder(
  database: TransferDatabase,
  dialect: TransferDialect,
  tables: readonly string[],
): Promise<string[]> {
  const wanted = new Set(tables);
  const deps = new Map<string, Set<string>>(
    tables.map((table) => [table, new Set<string>()]),
  );
  const link = (child: string, parent: string) => {
    if (child !== parent && wanted.has(child) && wanted.has(parent)) {
      deps.get(child)?.add(parent);
    }
  };
  if (dialect === 'postgres') {
    const edges = rowsOf(
      await database.query(
        `SELECT cl.relname AS child, pl.relname AS parent
           FROM pg_constraint c
           JOIN pg_class cl ON cl.oid = c.conrelid
           JOIN pg_class pl ON pl.oid = c.confrelid
          WHERE c.contype = 'f'
            AND cl.relnamespace = current_schema()::regnamespace`,
      ),
    );
    for (const edge of edges) link(text(edge.child), text(edge.parent));
  } else {
    for (const table of tables) {
      const edges = rowsOf(
        await database.query(`PRAGMA foreign_key_list(${quoted(table)})`),
      );
      for (const edge of edges) link(table, text(edge.table));
    }
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tables.length) {
    const next = tables.find(
      (table) =>
        !done.has(table) &&
        [...(deps.get(table) ?? [])].every((parent) => done.has(parent)),
    );
    if (!next) {
      throw new WorkspaceTransferError(
        'schema',
        'Foreign keys between the transferred tables form a cycle.',
      );
    }
    done.add(next);
    order.push(next);
  }
  return order;
}

/** Columns of `table` that reference the table itself (parent/child trees). */
export async function selfReferenceColumns(
  database: TransferDatabase,
  dialect: TransferDialect,
  table: string,
): Promise<string[]> {
  if (dialect === 'postgres') {
    return rowsOf(
      await database.query(
        `SELECT DISTINCT a.attname AS name
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f' AND c.conrelid = c.confrelid
            AND c.conrelid = to_regclass(?)`,
        [quoted(table)],
      ),
    ).map((row) => text(row.name));
  }
  return rowsOf(
    await database.query(`PRAGMA foreign_key_list(${quoted(table)})`),
  )
    .filter((row) => text(row.table) === table)
    .map((row) => text(row.from));
}

/** Parents before children so a self-referencing foreign key never dangles. */
export function orderParentsFirst(
  rows: Array<Record<string, unknown>>,
  columns: readonly string[],
): Array<Record<string, unknown>> {
  if (!columns.length) return rows;
  const byId = new Map(rows.map((row) => [text(row.id), row]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  const visit = (row: Record<string, unknown>) => {
    const id = text(row.id);
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const column of columns) {
      const parent = byId.get(text(row[column]));
      if (parent) visit(parent);
    }
    visiting.delete(id);
    done.add(id);
    out.push(row);
  };
  for (const row of rows) visit(row);
  return out;
}

/**
 * SQLSTATE plus the schema object (constraint/column names, never values) from a
 * driver error or its cause chain. Driver messages and `detail` quote row values,
 * so they are never surfaced.
 */
export function driverCode(error: unknown): string {
  const parts = new Set<string>();
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth++
  ) {
    const record = current as Record<string, unknown>;
    for (const key of ['code', 'constraint', 'column']) {
      const value = record[key];
      if (
        (typeof value === 'string' || typeof value === 'number') &&
        /^[A-Za-z0-9_]{1,64}$/u.test(String(value))
      ) {
        parts.add(`${key}=${value}`);
      }
    }
    current = record.cause;
  }
  return parts.size ? [...parts].join(' ') : 'unknown';
}

export function secureDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
}

export function bundleTablePath(directory: string, table: string): string {
  return join(directory, 'data', `${table}.jsonl`);
}

/** Resolve an asset key inside `<bundle>/assets`, refusing any escape. */
export function bundleAssetPath(directory: string, key: string): string {
  const root = resolve(directory, 'assets');
  const target = resolve(root, key);
  if (!target.startsWith(root + sep)) {
    throw new WorkspaceTransferError(
      'bundle',
      'Asset path escapes the bundle.',
    );
  }
  return target;
}

/** A key that is safe to hand to a filesystem provider. */
export function safeAssetKey(path: string): string | null {
  const trimmed = path.trim().replace(/^\/+/u, '');
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) return null;
  if (trimmed.split('/').some((part) => part === '' || part === '..')) {
    return null;
  }
  return trimmed;
}

export function computeBundleSha256(
  manifest: Omit<BundleManifest, 'bundleSha256'>,
): string {
  return sha256Hex(
    canonicalJson({
      assets: manifest.assets,
      dialect: manifest.dialect,
      identity: manifest.identity,
      tables: Object.fromEntries(
        Object.entries(manifest.tables).map(([name, entry]) => [
          name,
          { rows: entry.rows, sha256: entry.sha256 },
        ]),
      ),
      version: manifest.version,
    }),
  );
}

/** Read the manifest and verify every file checksum before anything is used. */
export function loadBundle(directory: string): BundleManifest {
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new WorkspaceTransferError('bundle', 'The bundle has no manifest.');
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as BundleManifest;
  if (
    manifest.format !== BUNDLE_FORMAT ||
    manifest.version !== BUNDLE_VERSION
  ) {
    throw new WorkspaceTransferError(
      'bundle',
      'The bundle format is not supported by this version.',
    );
  }
  const { bundleSha256, ...rest } = manifest;
  if (computeBundleSha256(rest) !== bundleSha256) {
    throw new WorkspaceTransferError(
      'bundle',
      'The bundle manifest checksum does not match.',
    );
  }
  for (const [name, entry] of Object.entries(manifest.tables)) {
    quoted(name);
    const path = bundleTablePath(directory, name);
    if (!existsSync(path) || sha256Hex(readFileSync(path)) !== entry.sha256) {
      throw new WorkspaceTransferError(
        'bundle',
        `Table file ${name} is missing or does not match its checksum.`,
      );
    }
  }
  for (const asset of manifest.assets) {
    const key = safeAssetKey(asset.path);
    if (!key || key !== asset.path) {
      throw new WorkspaceTransferError('bundle', 'An asset key is invalid.');
    }
    const path = bundleAssetPath(directory, key);
    if (
      !existsSync(path) ||
      statSync(path).size !== asset.size ||
      sha256Hex(readFileSync(path)) !== asset.sha256
    ) {
      throw new WorkspaceTransferError(
        'bundle',
        'An asset file is missing or does not match its checksum.',
      );
    }
  }
  return manifest;
}

/**
 * Rows are one JSON document per `\n`-terminated line. Split on `\n` only:
 * readline also splits on U+2028/U+2029, which JSON allows inside strings.
 */
export async function* readBundleRows(
  directory: string,
  table: string,
): AsyncGenerator<Record<string, unknown>> {
  let pending = '';
  const stream = createReadStream(bundleTablePath(directory, table), {
    encoding: 'utf8',
  });
  for await (const chunk of stream) {
    pending += chunk as string;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
      newline = pending.indexOf('\n');
    }
  }
  if (pending.trim()) yield JSON.parse(pending) as Record<string, unknown>;
}

/** Blank the private fields of one shared catalog row (a copy is returned). */
export function sanitizeCatalogRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const blanked = catalogBlankedColumns[table];
  if (!blanked) return row;
  const out = { ...row };
  for (const column of blanked) if (column in out) out[column] = '';
  return out;
}
