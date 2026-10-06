import { randomUUID } from 'node:crypto';
import type { FilesystemInterface } from '@happyvertical/files';
import { type AppConfigEnvironment, isSharedHosted } from './app-config.js';
import { workspaceOwnershipTables } from './workspace-ownership-backfill.js';

/**
 * Self-service (and operator-recoverable) deletion of one hosted account.
 *
 * Retention choices, enforced here and documented in docs/data-export-import.md:
 *
 * - Everything the user owns is deleted: candidate-owned workspace rows, files,
 *   sessions, CLI tokens, queued jobs, assistant turns, facts, the identity
 *   records (user, profile, OIDC links, membership) and their private tenant.
 * - `ai_user_spend_entries` rows are retained for platform cost accounting but
 *   detached: tenant and owner become a random pseudonym that is not derived
 *   from the user, and the provider request id is blanked.
 * - Profile `audit_logs` rows are deleted with the profile. They are bound to
 *   it by a NOT NULL foreign key, so they cannot be detached without a
 *   stand-in profile; the `account_deletion_records` row below is the audit
 *   trail that is retained.
 * - The user's `hosted_invites` row is revoked, not deleted, so the address
 *   cannot silently re-enter. It keeps the normalized email as the admission
 *   key; the operator can reinstate it explicitly.
 * - A non-PII `account_deletion_records` row records that a deletion happened.
 *
 * Ordering is the crash-safety argument. Phase 1 makes the account unusable
 * (invite revoked, membership/user/tenant deactivated, sessions and CLI tokens
 * removed); phase 2 deletes files, whose rows remain as the manifest until the
 * very last step; phase 3 deletes every row and completes the audit record in
 * one transaction, so storage is never half-deleted. Every statement is keyed
 * by tenant and user, so re-running after a crash at any point converges.
 */

type QueryResult =
  | { rows?: Array<Record<string, unknown>> }
  | Array<Record<string, unknown>>;

export interface AccountDeletionDatabase {
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>;
  transaction?: <T>(
    work: (transaction: AccountDeletionDatabase) => Promise<T>,
  ) => Promise<T>;
  url?: string;
}

export type AccountDeletionDialect = 'postgres' | 'sqlite';

export interface AccountDeletionScope {
  tenantId: string;
  userId: string;
}

export type AccountDeletionInitiator = 'operator' | 'self';

export interface AccountDeletionDependencies {
  database: AccountDeletionDatabase;
  dialect: AccountDeletionDialect;
  /** Test seam; production runs against `process.env`. */
  environment?: AppConfigEnvironment;
  filesystem?: Pick<FilesystemInterface, 'delete' | 'exists'>;
  initiatedBy?: AccountDeletionInitiator;
  /** Test seam: invoked after a phase completes, to inject a crash. */
  afterPhase?: (phase: 'files' | 'lock' | 'record') => Promise<void> | void;
  randomId?: () => string;
}

export interface AccountDeletionResult {
  deletionId: string;
  /** Aggregate counts only; table names and integers, never row content. */
  summary: Record<string, number>;
  status: 'already-deleted' | 'deleted';
}

export type AccountDeletionErrorCode =
  | 'disabled'
  | 'files'
  | 'invalid-scope'
  | 'scope-mismatch'
  | 'schema'
  | 'tenant-not-exclusive'
  | 'transaction-required';

export class AccountDeletionError extends Error {
  constructor(
    readonly code: AccountDeletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

export type AccountDeletionMode = 'disabled' | 'enabled';

/**
 * Deletion is a hosted-workspace feature. A private installation has one
 * operator-owned workspace that is the whole installation, so account deletion
 * is disabled there; the operator removes data with database tooling.
 */
export function accountDeletionMode(
  environment: AppConfigEnvironment = process.env,
): AccountDeletionMode {
  return isSharedHosted(environment) ? 'enabled' : 'disabled';
}

export const ACCOUNT_DELETION_DISABLED_MESSAGE =
  'Account deletion is only available on shared hosted workspaces. On a private installation the operator removes data with database tooling.';

/** Phrase the user must type, in addition to their email, to confirm. */
export const ACCOUNT_DELETION_CONFIRMATION_PHRASE = 'DELETE MY ACCOUNT';

export function accountDeletionConfirmed(input: {
  email: string | null | undefined;
  typedEmail: string | null | undefined;
  typedPhrase: string | null | undefined;
}): boolean {
  const email = input.email?.trim().toLowerCase() ?? '';
  return (
    email.length > 0 &&
    input.typedEmail?.trim().toLowerCase() === email &&
    input.typedPhrase?.trim() === ACCOUNT_DELETION_CONFIRMATION_PHRASE
  );
}

/** Tables keyed by the candidate-owned tenant + owner tuple. */
export const accountOwnedTables: readonly string[] = [
  ...new Set([
    ...workspaceOwnershipTables,
    // Tenant-scoped, owner-keyed records outside the ownership manifest.
    'opportunity_recommendation_ranks',
    'admin_assistant_turns',
    // Operator cap override for this user; the spend ledger is anonymized.
    'ai_user_budgets',
  ]),
];

/** Tables keyed by the user's private tenant alone. */
export const accountTenantTables: readonly string[] = [
  'fact_tags',
  'fact_evidences',
  'fact_contents',
  'fact_sources',
  'fact_subjects',
  'facts',
  '_smrt_job_events',
  '_smrt_jobs',
  'tenant_integrations',
  'tenant_permission_overrides',
];

const LEDGER_TABLE = 'ai_user_spend_entries';
const LEDGER_TENANT_TOMBSTONE = 'deleted';
const FILE_PREFIXES = ['generated-resumes', 'application-packages'] as const;

function rowsOf(result: QueryResult): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function identifier(value: unknown, label: string): string {
  const id = typeof value === 'string' ? value : '';
  if (
    !id ||
    id !== id.trim() ||
    id.length > 160 ||
    [...id].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new AccountDeletionError(
      'invalid-scope',
      `A valid ${label} is required.`,
    );
  }
  return id;
}

function quoted(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(table)) {
    throw new AccountDeletionError('schema', 'Table name is invalid.');
  }
  return `"${table}"`;
}

export class SchemaProbe {
  private readonly cache = new Map<string, Set<string> | null>();

  constructor(
    private readonly database: AccountDeletionDatabase,
    private readonly dialect: AccountDeletionDialect,
  ) {}

  /** Columns of `table`, or null when the table does not exist. */
  async columns(table: string): Promise<Set<string> | null> {
    if (this.cache.has(table)) return this.cache.get(table) ?? null;
    const result =
      this.dialect === 'sqlite'
        ? await this.database.query(`PRAGMA table_info(${quoted(table)})`)
        : await this.database.query(
            `SELECT column_name AS name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = ?`,
            [table],
          );
    const names = rowsOf(result).map((row) => text(row.name));
    const columns = names.length ? new Set(names) : null;
    this.cache.set(table, columns);
    return columns;
  }
}

interface StatementSpec {
  /** Columns the predicate and assignments reference; all must exist. */
  columns: string[];
  set?: { assignments: string; values: unknown[] };
  table: string;
  values: unknown[];
  where: string;
}

/**
 * Count then delete (or update) one predicate. A missing table means no data
 * can exist there. A present table that lacks a referenced column fails closed
 * rather than deleting with a predicate that does not mean what it says.
 */
async function applyStatement(
  database: AccountDeletionDatabase,
  probe: SchemaProbe,
  kind: 'delete' | 'update',
  spec: StatementSpec,
): Promise<number> {
  const columns = await probe.columns(spec.table);
  if (!columns) return 0;
  const missing = spec.columns.filter((column) => !columns.has(column));
  if (missing.length) {
    throw new AccountDeletionError(
      'schema',
      `Table ${spec.table} is missing expected column(s) ${missing.join(', ')}; run db:migrate and retry.`,
    );
  }
  const counted = rowsOf(
    await database.query(
      `SELECT COUNT(*) AS n FROM ${quoted(spec.table)} WHERE ${spec.where}`,
      spec.values,
    ),
  );
  const count = Number(counted[0]?.n ?? 0);
  if (count === 0) return 0;
  if (kind === 'delete') {
    await database.query(
      `DELETE FROM ${quoted(spec.table)} WHERE ${spec.where}`,
      spec.values,
    );
  } else {
    await database.query(
      `UPDATE ${quoted(spec.table)} SET ${spec.set?.assignments ?? ''} WHERE ${spec.where}`,
      [...(spec.set?.values ?? []), ...spec.values],
    );
  }
  return count;
}

function safeRelativePath(path: string): string | null {
  const trimmed = path.trim().replace(/^\/+/u, '');
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) return null;
  if (
    trimmed.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    return null;
  }
  return trimmed;
}

/**
 * Files recorded in this user's own rows that sit under a prefix derived from
 * one of this user's own record ids. The published/current resume, the legacy
 * shared path and anything outside the generators' layouts are never touched.
 */
export async function collectOwnedFilePaths(
  database: AccountDeletionDatabase,
  probe: SchemaProbe,
  scope: AccountDeletionScope,
): Promise<string[]> {
  const ownerValues = [scope.tenantId, scope.userId];
  const ownerWhere = 'tenant_id = ? AND owner_user_id = ?';
  const prefixes: string[] = [];
  const recorded: string[] = [];

  const assetColumns = await probe.columns('resume_assets');
  if (assetColumns) {
    const wanted = [
      'id',
      'generated_path',
      'markdown_path',
      'text_path',
      'html_path',
      'pdf_path',
    ];
    if (wanted.some((column) => !assetColumns.has(column))) {
      throw new AccountDeletionError(
        'schema',
        'resume_assets is missing expected columns; run db:migrate and retry.',
      );
    }
    const assets = rowsOf(
      await database.query(
        `SELECT ${wanted.join(', ')} FROM resume_assets WHERE ${ownerWhere}`,
        ownerValues,
      ),
    );
    for (const asset of assets) {
      prefixes.push(`generated-resumes/${text(asset.id)}/`);
      for (const column of wanted.slice(2)) recorded.push(text(asset[column]));
    }
  }
  const applicationColumns = await probe.columns('applications');
  if (applicationColumns?.has('id')) {
    const applications = rowsOf(
      await database.query(
        `SELECT id FROM applications WHERE ${ownerWhere}`,
        ownerValues,
      ),
    );
    for (const application of applications) {
      prefixes.push(`application-packages/${text(application.id)}/`);
    }
  }
  const attachmentColumns = await probe.columns('attachments');
  if (attachmentColumns?.has('file_path')) {
    const attachments = rowsOf(
      await database.query(
        `SELECT file_path FROM attachments WHERE ${ownerWhere}`,
        ownerValues,
      ),
    );
    for (const attachment of attachments)
      recorded.push(text(attachment.file_path));
  }

  const owned = new Set<string>();
  for (const candidate of recorded) {
    const path = safeRelativePath(candidate);
    if (!path) continue;
    if (!FILE_PREFIXES.some((prefix) => path.startsWith(`${prefix}/`)))
      continue;
    if (
      prefixes.some(
        (prefix) => path.startsWith(prefix) && path.length > prefix.length,
      )
    ) {
      owned.add(path);
    }
  }
  return [...owned].sort();
}

async function findStartedRecord(
  database: AccountDeletionDatabase,
  scope: AccountDeletionScope,
): Promise<{ id: string; pseudonym: string } | null> {
  const found = rowsOf(
    await database.query(
      `SELECT id, ledger_pseudonym FROM account_deletion_records
        WHERE status = 'started' AND tenant_id = ? AND user_id = ? LIMIT 1`,
      [scope.tenantId, scope.userId],
    ),
  )[0];
  return found
    ? { id: text(found.id), pseudonym: text(found.ledger_pseudonym) }
    : null;
}

/**
 * Delete one hosted account. Idempotent and resumable: call it again with the
 * same scope after any failure. Throws `AccountDeletionError` for refusals.
 */
export async function deleteAccount(
  scope: AccountDeletionScope,
  dependencies: AccountDeletionDependencies,
): Promise<AccountDeletionResult> {
  const { database, dialect } = dependencies;
  if (
    accountDeletionMode(dependencies.environment ?? process.env) !== 'enabled'
  ) {
    throw new AccountDeletionError(
      'disabled',
      ACCOUNT_DELETION_DISABLED_MESSAGE,
    );
  }
  const tenantId = identifier(scope?.tenantId, 'tenant ID');
  const userId = identifier(scope?.userId, 'user ID');
  const target = { tenantId, userId };
  if (typeof database.transaction !== 'function') {
    throw new AccountDeletionError(
      'transaction-required',
      'Account deletion requires transactional storage.',
    );
  }
  const probe = new SchemaProbe(database, dialect);
  const newId = dependencies.randomId ?? randomUUID;

  const user = rowsOf(
    await database.query(
      'SELECT id, email, profile_id FROM users WHERE id = ?',
      [userId],
    ),
  )[0];
  const tenant = rowsOf(
    await database.query('SELECT id FROM tenants WHERE id = ?', [tenantId]),
  )[0];
  const memberships = rowsOf(
    await database.query(
      'SELECT user_id FROM memberships WHERE tenant_id = ?',
      [tenantId],
    ),
  );
  const started = await findStartedRecord(database, target);

  if (!user && !tenant && !started) {
    return { deletionId: '', status: 'already-deleted', summary: {} };
  }
  // A hosted tenant is one user's private workspace. Refuse any scope that does
  // not demonstrably belong to this user, or that is shared with anyone else.
  const owned = memberships.some(
    (membership) => text(membership.user_id) === userId,
  );
  if (!started && !(user && tenant && owned)) {
    throw new AccountDeletionError(
      'scope-mismatch',
      'The user and tenant do not form one hosted workspace.',
    );
  }
  if (memberships.some((membership) => text(membership.user_id) !== userId)) {
    throw new AccountDeletionError(
      'tenant-not-exclusive',
      'Refusing to delete a tenant that has another member.',
    );
  }
  const email = text(user?.email).trim().toLowerCase();
  const profileId = text(user?.profile_id);
  const pseudonym = started?.pseudonym || newId();
  let deletionId = started?.id ?? '';
  if (!started) {
    deletionId = newId();
    await database.query(
      `INSERT INTO account_deletion_records (
         id, slug, context, status, initiated_by, tenant_id, user_id,
         ledger_pseudonym, started_at, summary, created_at, updated_at
       ) VALUES (?, ?, 'account-deletion', 'started', ?, ?, ?, ?, CURRENT_TIMESTAMP, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        deletionId,
        deletionId,
        dependencies.initiatedBy ?? 'self',
        tenantId,
        userId,
        pseudonym,
      ],
    );
  }
  await dependencies.afterPhase?.('record');

  // Phase 1: make the account unusable before touching any data.
  const summary: Record<string, number> = {};
  const count = (
    counts: Record<string, number>,
    key: string,
    value: number,
  ) => {
    if (value > 0) counts[key] = (counts[key] ?? 0) + value;
  };
  if (email) {
    count(
      summary,
      'hosted_invites_revoked',
      await applyStatement(database, probe, 'update', {
        columns: ['email', 'revoked_at'],
        set: {
          assignments:
            'revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP',
          values: [],
        },
        table: 'hosted_invites',
        values: [email],
        where: 'lower(email) = ? AND revoked_at IS NULL',
      }),
    );
  }
  const deactivations: Array<[string, string, string, unknown[]]> = [
    [
      'memberships',
      'inactive',
      'user_id = ? AND tenant_id = ?',
      [userId, tenantId],
    ],
    ['users', 'suspended', 'id = ?', [userId]],
    ['tenants', 'suspended', 'id = ?', [tenantId]],
  ];
  for (const [table, status, where, values] of deactivations) {
    await applyStatement(database, probe, 'update', {
      columns: ['status'],
      set: {
        assignments: 'status = ?, updated_at = CURRENT_TIMESTAMP',
        values: [status],
      },
      table,
      values: [...values, status],
      where: `${where} AND (status IS NULL OR status <> ?)`,
    });
  }
  // Stop queued work from starting; workers also refuse it once the invite is
  // revoked and the user is suspended.
  count(
    summary,
    'jobs_cancelled',
    await applyStatement(database, probe, 'update', {
      columns: ['tenant_id', 'status'],
      set: {
        assignments: "status = 'cancelled', updated_at = CURRENT_TIMESTAMP",
        values: [],
      },
      table: '_smrt_jobs',
      values: [tenantId],
      where: "tenant_id = ? AND status = 'pending'",
    }),
  );
  for (const statement of credentialStatements(target)) {
    count(
      summary,
      statement.table,
      await applyStatement(database, probe, 'delete', statement),
    );
  }
  await dependencies.afterPhase?.('lock');

  // Phase 2: files. The rows that name them still exist, so a failure here is
  // retried from the same manifest.
  if (dependencies.filesystem) {
    const paths = await collectOwnedFilePaths(database, probe, target);
    const failures: string[] = [];
    let removed = 0;
    for (const path of paths) {
      try {
        if (await dependencies.filesystem.exists(path)) {
          await dependencies.filesystem.delete(path);
          removed += 1;
        }
      } catch {
        failures.push(path);
      }
    }
    if (failures.length) {
      throw new AccountDeletionError(
        'files',
        `${failures.length} file(s) could not be deleted; the account is locked and the deletion can be re-run.`,
      );
    }
    count(summary, 'files', removed);
  }
  await dependencies.afterPhase?.('files');

  // Phase 3: every row, plus the audit record, in one transaction. Schemas are
  // probed first so the transaction never waits on a second connection.
  const plan = rowStatements({ email, pseudonym, profileId, ...target });
  for (const step of plan) await probe.columns(step.spec.table);
  const rowCounts: Record<string, number> = {};
  await database.transaction(async (transaction) => {
    for (const step of plan) {
      count(
        rowCounts,
        step.key,
        await applyStatement(transaction, probe, step.kind, step.spec),
      );
    }
    await transaction.query(
      `UPDATE account_deletion_records
          SET status = 'completed', tenant_id = NULL, user_id = NULL,
              completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
              summary = ?
        WHERE status = 'started' AND tenant_id = ? AND user_id = ?`,
      [JSON.stringify({ ...summary, ...rowCounts }), tenantId, userId],
    );
  });

  return {
    deletionId,
    status: 'deleted',
    summary: { ...summary, ...rowCounts },
  };
}

function credentialStatements(scope: AccountDeletionScope): StatementSpec[] {
  const { tenantId, userId } = scope;
  // Order matters: users_cli_auth_requests.session_id references sessions.
  return [
    {
      columns: ['user_id', 'tenant_id'],
      table: 'users_cli_auth_requests',
      values: [userId, tenantId],
      where: 'user_id = ? OR tenant_id = ?',
    },
    {
      columns: ['user_id', 'tenant_id'],
      table: 'cli_auth_requests',
      values: [userId, tenantId],
      where: 'user_id = ? OR tenant_id = ?',
    },
    {
      columns: ['user_id'],
      table: 'sessions',
      values: [userId],
      where: 'user_id = ?',
    },
  ];
}

interface PlannedStatement {
  key: string;
  kind: 'delete' | 'update';
  spec: StatementSpec;
}

/** Every phase-3 statement, in execution order, as data. */
function rowStatements(input: {
  email: string;
  profileId: string;
  pseudonym: string;
  tenantId: string;
  userId: string;
}): PlannedStatement[] {
  const { email, profileId, pseudonym, tenantId, userId } = input;
  const plan: PlannedStatement[] = [];
  const del = (spec: StatementSpec, key = spec.table) =>
    plan.push({ key, kind: 'delete', spec });

  for (const table of accountOwnedTables) {
    del({
      columns: ['tenant_id', 'owner_user_id'],
      table,
      values: [tenantId, userId],
      where: 'tenant_id = ? AND owner_user_id = ?',
    });
  }
  for (const table of accountTenantTables) {
    del({
      columns: ['tenant_id'],
      table,
      values: [tenantId],
      where: 'tenant_id = ?',
    });
  }
  del({
    columns: ['tenant_id', 'actor_user_id', 'on_behalf_of_user_id'],
    table: 'data_surface_preview_tokens',
    values: [tenantId, userId, userId],
    where: 'tenant_id = ? OR actor_user_id = ? OR on_behalf_of_user_id = ?',
  });

  // Retained for platform cost accounting, detached from the user.
  plan.push({
    key: `${LEDGER_TABLE}_anonymized`,
    kind: 'update',
    spec: {
      columns: ['tenant_id', 'owner_user_id', 'request_id'],
      set: {
        assignments: "tenant_id = ?, owner_user_id = ?, request_id = ''",
        values: [LEDGER_TENANT_TOMBSTONE, `deleted:${pseudonym}`],
      },
      table: LEDGER_TABLE,
      values: [tenantId, userId],
      where: 'tenant_id = ? AND owner_user_id = ?',
    },
  });
  del({
    columns: ['tenant_id', 'profile_id', 'on_behalf_of_id'],
    table: 'audit_logs',
    values: profileId ? [tenantId, profileId, profileId] : [tenantId],
    where: profileId
      ? 'tenant_id = ? OR profile_id = ? OR on_behalf_of_id = ?'
      : 'tenant_id = ?',
  });

  // Identity records, user and tenant last.
  for (const spec of credentialStatements({ tenantId, userId })) del(spec);
  del({
    columns: ['user_id'],
    table: 'users_cli_auth_approve_limits',
    values: [userId],
    where: 'user_id = ?',
  });
  del({
    columns: ['user_id', 'tenant_id'],
    table: 'resource_grants',
    values: [userId, tenantId],
    where: 'user_id = ? OR tenant_id = ?',
  });
  del({
    columns: ['user_id'],
    table: 'group_members',
    values: [userId],
    where: 'user_id = ?',
  });
  del({
    columns: ['group_id'],
    table: 'group_members',
    values: [tenantId],
    where: 'group_id IN (SELECT id FROM groups WHERE tenant_id = ?)',
  });
  del({
    columns: ['group_id'],
    table: 'group_roles',
    values: [tenantId],
    where: 'group_id IN (SELECT id FROM groups WHERE tenant_id = ?)',
  });
  del({
    columns: ['tenant_id'],
    table: 'groups',
    values: [tenantId],
    where: 'tenant_id = ?',
  });
  del({
    columns: ['membership_id'],
    table: 'membership_overrides',
    values: [userId, tenantId],
    where:
      'membership_id IN (SELECT id FROM memberships WHERE user_id = ? OR tenant_id = ?)',
  });
  del({
    columns: ['user_id', 'tenant_id'],
    table: 'memberships',
    values: [userId, tenantId],
    where: 'user_id = ? OR tenant_id = ?',
  });
  if (email) {
    del({
      columns: ['email'],
      table: 'users_magic_link_tokens',
      values: [email],
      where: 'lower(email) = ?',
    });
    del({
      columns: ['email', 'resulting_user_id'],
      table: 'access_requests',
      values: [userId, email],
      where: 'resulting_user_id = ? OR lower(email) = ?',
    });
  }
  if (profileId) {
    for (const table of [
      'oidc_identities',
      'oidc_profile_email_reservations',
      'profile_links',
      'profile_assets',
      'profile_metadata',
      'api_keys',
      'nostr_identities',
    ]) {
      del({
        columns: ['profile_id'],
        table,
        values: [profileId],
        where: 'profile_id = ?',
      });
    }
    del({
      columns: ['from_profile_id', 'to_profile_id'],
      table: 'profile_relationships',
      values: [profileId, profileId],
      where: 'from_profile_id = ? OR to_profile_id = ?',
    });
    del({
      columns: ['id'],
      table: 'profiles',
      values: [profileId],
      where: 'id = ?',
    });
  }
  del({ columns: ['id'], table: 'users', values: [userId], where: 'id = ?' });
  del({
    columns: ['role_id'],
    table: 'role_permissions',
    values: [tenantId],
    where: 'role_id IN (SELECT id FROM roles WHERE tenant_id = ?)',
  });
  del({
    columns: ['tenant_id'],
    table: 'roles',
    values: [tenantId],
    where: 'tenant_id = ?',
  });
  del({
    columns: ['id'],
    table: 'tenants',
    values: [tenantId],
    where: 'id = ?',
  });
  return plan;
}

/** Deletions that were started but never completed, for operator recovery. */
export async function listIncompleteAccountDeletions(
  database: AccountDeletionDatabase,
): Promise<
  Array<{ id: string; initiatedBy: string; tenantId: string; userId: string }>
> {
  return rowsOf(
    await database.query(
      `SELECT id, initiated_by, tenant_id, user_id FROM account_deletion_records
        WHERE status = 'started' ORDER BY created_at ASC`,
    ),
  ).map((row) => ({
    id: text(row.id),
    initiatedBy: text(row.initiated_by),
    tenantId: text(row.tenant_id),
    userId: text(row.user_id),
  }));
}
