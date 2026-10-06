import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { FilesystemInterface } from '@happyvertical/files';
import {
  type AccountDeletionDatabase,
  collectOwnedFilePaths,
  SchemaProbe,
} from './account-deletion.js';
import {
  agentRunTable,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  type BundleAssetEntry,
  type BundleIdentity,
  type BundleManifest,
  type BundleTableEntry,
  bundleAssetPath,
  bundleTablePath,
  canonicalJson,
  catalogTables,
  computeBundleSha256,
  excludedByPolicy,
  ownedTables,
  quoted,
  rowsOf,
  safeAssetKey,
  sanitizeCatalogRow,
  secureDirectory,
  sha256Hex,
  skippedOwnerTables,
  type TransferDatabase,
  type TransferDialect,
  tableColumns,
  text,
  WorkspaceTransferError,
} from './workspace-transfer.js';

export interface WorkspaceExportOptions {
  database: TransferDatabase;
  dialect: TransferDialect;
  /** Directory to create; it must not already hold a bundle. */
  outDir: string;
  /** Source asset store. Without it, asset bytes are not exported. */
  filesystem?: Pick<FilesystemInterface, 'list' | 'read'>;
  /** Narrow to one workspace when the source holds several. */
  tenantId?: string;
  userId?: string;
  now?: () => Date;
}

export interface WorkspaceExportResult {
  assets: number;
  assetsMissing: number;
  bundleSha256: string;
  /** Table name to row count. Counts only; never row content. */
  tables: Record<string, number>;
}

const PAGE = 1000;
const ASSET_COLUMN_PREFIXES = [
  'generated-resumes',
  'application-packages',
] as const;

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    throw new WorkspaceTransferError(
      'schema',
      'A binary column cannot be exported to a JSONL bundle.',
    );
  }
  return value;
}

/** Keyset-paginated rows of one table as plain JSON-safe objects. */
async function* selectRows(
  database: TransferDatabase,
  dialect: TransferDialect,
  table: string,
  where: string,
  values: unknown[],
): AsyncGenerator<Record<string, unknown>> {
  const select = dialect === 'postgres' ? 'to_jsonb(t) AS j' : 't.*';
  let after = '';
  for (;;) {
    const page = rowsOf(
      await database.query(
        `SELECT ${select}, CAST(t.id AS TEXT) AS "__id"
           FROM ${quoted(table)} t
          WHERE ${where ? `(${where}) AND ` : ''}CAST(t.id AS TEXT) > ?
          ORDER BY CAST(t.id AS TEXT)
          LIMIT ${PAGE}`,
        [...values, after],
      ),
    );
    if (!page.length) return;
    for (const raw of page) {
      after = text(raw.__id);
      if (dialect === 'postgres') {
        const parsed =
          typeof raw.j === 'string' ? JSON.parse(raw.j) : (raw.j as object);
        yield parsed as Record<string, unknown>;
      } else {
        const { __id, ...row } = raw;
        yield Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, jsonSafe(value)]),
        );
      }
    }
    if (page.length < PAGE) return;
  }
}

class TableWriter {
  private readonly hash = createHash('sha256');
  rows = 0;
  private buffer: string[] = [];

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeFileSync(path, '', { mode: 0o600 });
  }

  write(row: Record<string, unknown>): void {
    this.buffer.push(`${JSON.stringify(row)}\n`);
    this.rows += 1;
    if (this.buffer.length >= 500) this.flush();
  }

  flush(): void {
    if (!this.buffer.length) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    this.hash.update(chunk);
    appendFileSync(this.path, chunk);
  }

  finish(): string {
    this.flush();
    return this.hash.digest('hex');
  }
}

async function discoverIdentity(
  database: TransferDatabase,
  options: WorkspaceExportOptions,
): Promise<BundleIdentity> {
  const profiles = rowsOf(
    await database.query(
      `SELECT CAST(id AS TEXT) AS id, CAST(tenant_id AS TEXT) AS tenant_id,
              CAST(owner_user_id AS TEXT) AS owner_user_id
         FROM candidate_profiles`,
    ),
  ).filter(
    (row) =>
      (!options.tenantId || text(row.tenant_id) === options.tenantId) &&
      (!options.userId || text(row.owner_user_id) === options.userId),
  );
  if (profiles.length !== 1) {
    throw new WorkspaceTransferError(
      'scope',
      `Expected exactly one candidate profile to export, found ${profiles.length}; pass --tenant-id and --user-id.`,
    );
  }
  const profile = profiles[0];
  const tenantId = text(profile.tenant_id);
  const userId = text(profile.owner_user_id);
  if (!tenantId || !userId) {
    throw new WorkspaceTransferError(
      'scope',
      'The candidate profile has no ownership tuple.',
    );
  }
  const user = rowsOf(
    await database.query(
      'SELECT CAST(profile_id AS TEXT) AS profile_id FROM users WHERE CAST(id AS TEXT) = ?',
      [userId],
    ),
  )[0];
  if (!user || !text(user.profile_id)) {
    throw new WorkspaceTransferError(
      'identity',
      'The owning user or its profile is missing in the source.',
    );
  }
  return {
    candidateProfileId: text(profile.id),
    smrtProfileId: text(user.profile_id),
    tenantId,
    userId,
  };
}

/**
 * Export one private workspace into a checksummed bundle directory. Reads only:
 * on PostgreSQL the whole export runs in one REPEATABLE READ READ ONLY
 * transaction, so it is a consistent snapshot even while the source app runs.
 */
export async function exportWorkspace(
  options: WorkspaceExportOptions,
): Promise<WorkspaceExportResult> {
  const { database, dialect, outDir } = options;
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new WorkspaceTransferError(
      'bundle',
      'The output directory must be empty.',
    );
  }
  secureDirectory(outDir);
  chmodSync(outDir, 0o700);

  const run = async (db: TransferDatabase) => {
    if (dialect === 'postgres') {
      await db.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
    }
    return await exportWithin(db, options);
  };
  return typeof database.transaction === 'function'
    ? await database.transaction(run)
    : await run(database);
}

async function exportWithin(
  database: TransferDatabase,
  options: WorkspaceExportOptions,
): Promise<WorkspaceExportResult> {
  const { dialect, outDir } = options;
  const identity = await discoverIdentity(database, options);

  const unclassified: string[] = [];
  const known = new Set<string>([...ownedTables, ...skippedOwnerTables]);
  const ownerTables =
    dialect === 'postgres'
      ? rowsOf(
          await database.query(
            `SELECT DISTINCT table_name AS name FROM information_schema.columns
              WHERE table_schema = current_schema() AND column_name = 'owner_user_id'`,
          ),
        ).map((row) => text(row.name))
      : await (async () => {
          const names: string[] = [];
          const all = rowsOf(
            await database.query(
              `SELECT name FROM sqlite_master WHERE type = 'table'`,
            ),
          );
          for (const { name } of all) {
            const columns = await tableColumns(database, dialect, text(name));
            if (columns?.some((column) => column.name === 'owner_user_id')) {
              names.push(text(name));
            }
          }
          return names;
        })();
  for (const name of ownerTables) if (!known.has(name)) unclassified.push(name);
  if (unclassified.length) {
    throw new WorkspaceTransferError(
      'schema',
      `Owner-scoped table(s) not classified for transfer: ${unclassified.sort().join(', ')}. Update the transfer manifest before exporting.`,
    );
  }

  const tables: Record<string, BundleTableEntry> = {};
  const referencedAgentRuns = new Set<string>();
  const resumeAssetIds: string[] = [];
  const applicationIds: string[] = [];
  const tuple = {
    values: [identity.tenantId, identity.userId],
    where:
      'CAST(t.tenant_id AS TEXT) = ? AND CAST(t.owner_user_id AS TEXT) = ?',
  };

  const exportTable = async (
    table: string,
    kind: 'catalog' | 'owned',
  ): Promise<void> => {
    const columns = await tableColumns(database, dialect, table);
    if (!columns) {
      if (kind === 'owned') return; // older schema: nothing to carry
      throw new WorkspaceTransferError(
        'schema',
        `Catalog table ${table} is missing in the source.`,
      );
    }
    const writer = new TableWriter(bundleTablePath(outDir, table));
    const rows = selectRows(
      database,
      dialect,
      table,
      kind === 'owned' ? tuple.where : '',
      kind === 'owned' ? tuple.values : [],
    );
    for await (const raw of rows) {
      if (table === agentRunTable) {
        if (!referencedAgentRuns.has(text(raw.id))) continue;
      }
      const row = kind === 'catalog' ? sanitizeCatalogRow(table, raw) : raw;
      if (kind === 'owned') {
        const agentRun = text(row.agent_run_id);
        if (agentRun) referencedAgentRuns.add(agentRun);
        if (table === 'resume_assets') resumeAssetIds.push(text(row.id));
        if (table === 'applications') applicationIds.push(text(row.id));
      }
      writer.write(row);
    }
    tables[table] = {
      columns: columns.map((column) => column.name),
      kind,
      rows: writer.rows,
      sha256: writer.finish(),
    };
  };

  for (const table of catalogTables) await exportTable(table, 'catalog');
  // agent_runs last: only runs a carried row points at travel, so the proof
  // chain survives without dragging unrelated operator activity along.
  for (const table of ownedTables.filter((name) => name !== agentRunTable)) {
    await exportTable(table, 'owned');
  }
  await exportTable(agentRunTable, 'owned');

  const assets: BundleAssetEntry[] = [];
  let assetsMissing = 0;
  if (options.filesystem) {
    const keys = new Set<string>();
    const probe = new SchemaProbe(
      database as unknown as AccountDeletionDatabase,
      dialect,
    );
    for (const key of await collectOwnedFilePaths(
      database as unknown as AccountDeletionDatabase,
      probe,
      { tenantId: identity.tenantId, userId: identity.userId },
    )) {
      keys.add(key);
    }
    const prefixes = [
      ...resumeAssetIds.map((id) => `generated-resumes/${id}/`),
      ...applicationIds.map((id) => `application-packages/${id}/`),
    ];
    for (const prefix of prefixes) {
      let listed: Awaited<ReturnType<FilesystemInterface['list']>> = [];
      try {
        listed = await options.filesystem.list(prefix, { recursive: true });
      } catch {
        listed = [];
      }
      for (const info of listed) {
        if (info.isDirectory) continue;
        const raw = info.path.replace(/^\/+/u, '');
        const key = safeAssetKey(raw.startsWith(prefix) ? raw : prefix + raw);
        if (
          key?.startsWith(prefix) &&
          ASSET_COLUMN_PREFIXES.some((p) => key.startsWith(`${p}/`))
        ) {
          keys.add(key);
        }
      }
    }
    for (const key of [...keys].sort()) {
      let bytes: Buffer;
      try {
        const read = await options.filesystem.read(key, { raw: true });
        bytes = typeof read === 'string' ? Buffer.from(read) : read;
      } catch {
        assetsMissing += 1;
        continue;
      }
      const target = bundleAssetPath(outDir, key);
      mkdirSync(dirname(target), { mode: 0o700, recursive: true });
      writeFileSync(target, bytes, { mode: 0o600 });
      assets.push({ path: key, sha256: sha256Hex(bytes), size: bytes.length });
    }
  }

  const base: Omit<BundleManifest, 'bundleSha256'> = {
    assets,
    assetsMissing,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    dialect,
    excludedByPolicy,
    format: BUNDLE_FORMAT,
    identity,
    skippedOwnerTables,
    tables,
    version: BUNDLE_VERSION,
  };
  const manifest: BundleManifest = {
    ...base,
    bundleSha256: computeBundleSha256(base),
  };
  writeFileSync(`${outDir}/manifest.json`, `${canonicalJson(manifest)}\n`, {
    mode: 0o600,
  });
  return {
    assets: assets.length,
    assetsMissing,
    bundleSha256: manifest.bundleSha256,
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, entry]) => [name, entry.rows]),
    ),
  };
}
