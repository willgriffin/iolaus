import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AccountDeletionDatabase,
  type AccountDeletionDialect,
  AccountDeletionError,
  accountOwnedTables,
  deleteAccount,
  listIncompleteAccountDeletions,
} from './account-deletion';
import { insert } from './fixtures/account-seed.js';
import './smrt.js';
import { workspaceOwnershipClasses } from './workspace-ownership-backfill.js';

type TestDatabase = Awaited<ReturnType<typeof getTestDatabase>>;

const shared = {
  IOLAUS_WORKSPACE_MODE: 'shared',
  SMRT_APP_ID: 'beta-app',
  SMRT_RUNTIME_PROFILE: 'self-hosted',
};

const classes = [
  ...workspaceOwnershipClasses,
  'OpportunityRecommendationRank',
  'AdminAssistantTurn',
  'AiUserBudget',
  'AiUserSpendEntry',
  'HostedInvite',
  'AccountDeletionRecord',
  'CliAuthRequest',
  'DataSurfacePreviewToken',
  'User',
  'Tenant',
  'Membership',
  'Session',
  'Profile',
  'OidcIdentity',
  'SmrtJob',
  'SmrtJobEvent',
  'Fact',
  'FactContent',
  'FactEvidence',
  'FactSource',
  'FactSubject',
  'FactTag',
  'AuditLog',
  'ApiKey',
  'ProfileLink',
  'ProfileAsset',
  'ProfileMetadata',
  'ProfileRelationship',
  'OidcProfileEmailReservation',
  'NostrIdentity',
  'ResourceGrant',
  'Group',
  'GroupMember',
  'MembershipOverride',
  'RolePermission',
  'Permission',
  'GroupRole',
  'UsersCliAuthRequest',
  'UsersCliAuthApproveLimit',
  'UsersMagicLinkToken',
  'AccessRequest',
  'TenantIntegration',
  'TenantPermissionOverride',
];

interface Principal {
  email: string;
  profileId: string;
  tenantId: string;
  userId: string;
}

function principal(label: string): Principal {
  return {
    email: `${label}@example.invalid`,
    profileId: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
  };
}

/** One fully provisioned hosted user: identity rows plus data in every shape. */
async function seedUser(db: TestDatabase, who: Principal): Promise<void> {
  await insert(db, 'tenants', {
    _meta_type: 'tenant',
    id: who.tenantId,
    name: `${who.email} workspace`,
    status: 'active',
  });
  const roleId = randomUUID();
  await insert(db, 'roles', {
    id: roleId,
    name: `member-${roleId}`,
  });
  await insert(db, 'profiles', {
    _meta_type: 'person',
    email: who.email,
    id: who.profileId,
    name: who.email,
  });
  await insert(db, 'users', {
    email: who.email,
    email_key: who.email,
    id: who.userId,
    profile_id: who.profileId,
    status: 'active',
  });
  await insert(db, 'memberships', {
    role_id: roleId,
    status: 'active',
    tenant_id: who.tenantId,
    user_id: who.userId,
  });
  await insert(db, 'oidc_identities', {
    identity_key: `kc:${who.userId}`,
    profile_id: who.profileId,
  });
  await insert(db, 'sessions', {
    status: 'active',
    tenant_id: who.tenantId,
    user_id: who.userId,
  });
  await insert(db, 'cli_auth_requests', {
    status: 'approved',
    tenant_id: who.tenantId,
    user_id: who.userId,
  });
  await insert(db, 'hosted_invites', { email: who.email });
  const membership = (
    await db.query('SELECT id FROM memberships WHERE user_id = ?', [who.userId])
  ).rows[0] as { id: string };
  const permissionId = randomUUID();
  await insert(db, 'permissions', {
    id: permissionId,
    name: `p-${permissionId}`,
  });
  await insert(db, 'membership_overrides', {
    membership_id: membership.id,
    permission_id: permissionId,
  });
  await insert(db, 'resource_grants', {
    tenant_id: who.tenantId,
    user_id: who.userId,
  });
  await insert(db, 'users_cli_auth_requests', { user_id: who.userId });
  await insert(db, 'users_cli_auth_approve_limits', { user_id: who.userId });
  await insert(db, 'users_magic_link_tokens', {
    email: who.email,
    nonce: randomUUID(),
  });
  await insert(db, 'access_requests', {
    email: who.email,
    resulting_user_id: who.userId,
  });
  await insert(db, 'tenant_integrations', { tenant_id: who.tenantId });
  await insert(db, 'api_keys', { profile_id: who.profileId });
  await insert(db, 'profile_links', { profile_id: who.profileId });
  await insert(db, 'profile_assets', { profile_id: who.profileId });
  await insert(db, 'profile_metadata', { profile_id: who.profileId });
  await insert(db, 'nostr_identities', { profile_id: who.profileId });
  await insert(db, 'oidc_profile_email_reservations', {
    email_key: who.email,
    profile_id: who.profileId,
  });
  await insert(db, 'audit_logs', {
    action: 'profile.update',
    metadata: JSON.stringify({ email: who.email }),
    profile_id: who.profileId,
    resource_id: who.userId,
    tenant_id: who.tenantId,
  });
  const factId = randomUUID();
  await insert(db, 'facts', { id: factId, tenant_id: who.tenantId });
  for (const table of [
    'fact_contents',
    'fact_evidences',
    'fact_sources',
    'fact_subjects',
    'fact_tags',
  ]) {
    await insert(db, table, { fact_id: factId, tenant_id: who.tenantId });
  }
  await insert(db, 'ai_user_budgets', {
    owner_user_id: who.userId,
    tenant_id: who.tenantId,
  });
  await insert(db, 'ai_user_spend_entries', {
    actual_micros: 1234,
    feature: 'assessment',
    owner_user_id: who.userId,
    period: '2026-10',
    request_id: `req-${who.userId}`,
    status: 'settled',
    tenant_id: who.tenantId,
  });
  await insert(db, '_smrt_jobs', {
    args: '{}',
    method: 'run',
    object_type: 'x',
    run_at: '2026-10-05',
    status: 'pending',
    tenant_id: who.tenantId,
  });
  await insert(db, 'data_surface_preview_tokens', {
    actor_user_id: who.userId,
    tenant_id: who.tenantId,
    token: randomUUID(),
  });
  for (const table of accountOwnedTables) {
    if (['ai_user_budgets'].includes(table)) continue;
    await insert(db, table, {
      ...(table === 'candidate_profiles'
        ? {}
        : { candidate_profile_id: who.profileId }),
      owner_user_id: who.userId,
      tenant_id: who.tenantId,
    });
  }
}

async function count(
  db: TestDatabase,
  table: string,
  where: string,
  values: unknown[],
): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`,
    values,
  );
  return Number((result.rows[0] as { n: unknown }).n);
}

function deletionContract(
  open: () => Promise<TestDatabase>,
  dialect: AccountDeletionDialect,
) {
  let db: TestDatabase | undefined;
  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });
  const setup = async () => {
    db = await open();
    return db;
  };
  const deps = (
    database: TestDatabase,
    extra: Partial<Parameters<typeof deleteAccount>[1]> = {},
  ) => ({
    database: database as unknown as AccountDeletionDatabase,
    dialect,
    environment: shared,
    ...extra,
  });

  it("deletes one user's data across every owned table and leaves the other user untouched", async () => {
    const database = await setup();
    const a = principal('alice');
    const b = principal('bob');
    await seedUser(database, a);
    await seedUser(database, b);
    const bobBefore = new Map<string, number>();
    for (const table of accountOwnedTables) {
      bobBefore.set(
        table,
        await count(database, table, 'tenant_id = ?', [b.tenantId]),
      );
    }

    const result = await deleteAccount(
      { tenantId: a.tenantId, userId: a.userId },
      deps(database),
    );
    expect(result.status).toBe('deleted');

    for (const table of accountOwnedTables) {
      expect(
        await count(database, table, 'tenant_id = ?', [a.tenantId]),
        `${table} still holds Alice rows`,
      ).toBe(0);
      expect(
        await count(database, table, 'tenant_id = ?', [b.tenantId]),
        `${table} lost Bob rows`,
      ).toBe(bobBefore.get(table));
    }
    // Identity, credentials, jobs and tokens.
    for (const [table, column] of [
      ['users', 'id'],
      ['profiles', 'id'],
      ['tenants', 'id'],
      ['memberships', 'user_id'],
      ['sessions', 'user_id'],
      ['cli_auth_requests', 'user_id'],
      ['oidc_identities', 'profile_id'],
    ] as const) {
      const keyFor = (who: Principal) =>
        table === 'tenants'
          ? who.tenantId
          : table === 'profiles' || column === 'profile_id'
            ? who.profileId
            : who.userId;
      const key = keyFor(a);
      const bobKey = keyFor(b);
      expect(await count(database, table, `${column} = ?`, [key])).toBe(0);
      expect(await count(database, table, `${column} = ?`, [bobKey])).toBe(1);
    }
    expect(
      await count(database, '_smrt_jobs', 'tenant_id = ?', [a.tenantId]),
    ).toBe(0);
    expect(
      await count(database, '_smrt_jobs', 'tenant_id = ?', [b.tenantId]),
    ).toBe(1);
    expect(
      await count(
        database,
        'data_surface_preview_tokens',
        'actor_user_id = ?',
        [b.userId],
      ),
    ).toBe(1);
  });

  it('revokes the hosted invite instead of deleting it', async () => {
    const database = await setup();
    const a = principal('alice');
    const b = principal('bob');
    await seedUser(database, a);
    await seedUser(database, b);
    await deleteAccount(
      { tenantId: a.tenantId, userId: a.userId },
      deps(database),
    );
    const invites = await database.query(
      'SELECT email, revoked_at FROM hosted_invites ORDER BY email',
    );
    const byEmail = new Map(
      (invites.rows as Array<{ email: string; revoked_at: unknown }>).map(
        (row) => [row.email, row.revoked_at],
      ),
    );
    expect(byEmail.get(a.email)).toBeTruthy();
    expect(byEmail.get(b.email) ?? null).toBeNull();
  });

  it('keeps the AI spend ledger but detaches it from the user, deletes profile audit rows and records a non-PII audit row', async () => {
    const database = await setup();
    const a = principal('alice');
    const b = principal('bob');
    await seedUser(database, a);
    await seedUser(database, b);
    await deleteAccount(
      { tenantId: a.tenantId, userId: a.userId },
      deps(database),
    );

    expect(
      await count(database, 'ai_user_spend_entries', 'owner_user_id = ?', [
        a.userId,
      ]),
    ).toBe(0);
    const ledger = await database.query(
      'SELECT tenant_id, owner_user_id, request_id, actual_micros, feature FROM ai_user_spend_entries WHERE actual_micros = 1234 AND tenant_id = ?',
      ['deleted'],
    );
    expect(ledger.rows).toHaveLength(1);
    const kept = ledger.rows[0] as Record<string, unknown>;
    expect(String(kept.owner_user_id)).toMatch(/^deleted:/u);
    expect(kept.request_id).toBe('');
    expect(kept.feature).toBe('assessment');
    // Bob's ledger row keeps its attribution.
    expect(
      await count(database, 'ai_user_spend_entries', 'owner_user_id = ?', [
        b.userId,
      ]),
    ).toBe(1);

    // Profile audit rows are FK-bound to the profile and are deleted with it;
    // Bob's is untouched.
    const audit = await database.query(
      'SELECT profile_id, metadata, resource_id FROM audit_logs',
    );
    expect(audit.rows).toHaveLength(1);
    const audited = JSON.stringify(audit.rows);
    expect(audited).toContain(b.profileId);
    expect(audited).not.toContain(a.profileId);

    const records = await database.query(
      'SELECT status, tenant_id, user_id, initiated_by, summary FROM account_deletion_records',
    );
    expect(records.rows).toHaveLength(1);
    const record = records.rows[0] as Record<string, unknown>;
    expect(record.status).toBe('completed');
    expect(record.tenant_id ?? null).toBeNull();
    expect(record.user_id ?? null).toBeNull();
    const serialised = JSON.stringify(record);
    for (const secret of [a.email, a.userId, a.tenantId, a.profileId]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('is idempotent: a second run reports already-deleted and changes nothing', async () => {
    const database = await setup();
    const a = principal('alice');
    await seedUser(database, a);
    const scope = { tenantId: a.tenantId, userId: a.userId };
    await deleteAccount(scope, deps(database));
    await expect(deleteAccount(scope, deps(database))).resolves.toMatchObject({
      status: 'already-deleted',
    });
    expect(await count(database, 'account_deletion_records', '1 = 1', [])).toBe(
      1,
    );
  });

  it.each([
    'record',
    'lock',
    'files',
  ] as const)('resumes to completion after a crash following the %s phase', async (phase) => {
    const database = await setup();
    const a = principal('alice');
    const b = principal('bob');
    await seedUser(database, a);
    await seedUser(database, b);
    const scope = { tenantId: a.tenantId, userId: a.userId };

    await expect(
      deleteAccount(
        scope,
        deps(database, {
          afterPhase: (reached) => {
            if (reached === phase) throw new Error('simulated crash');
          },
        }),
      ),
    ).rejects.toThrow('simulated crash');

    // The account is never half-visible: once past the record phase it is
    // already locked, and every row still exists to resume from.
    const incomplete = await listIncompleteAccountDeletions(
      database as unknown as AccountDeletionDatabase,
    );
    expect(incomplete).toEqual([
      expect.objectContaining({
        tenantId: a.tenantId,
        userId: a.userId,
      }),
    ]);
    if (phase !== 'record') {
      expect(
        await count(
          database,
          'hosted_invites',
          'email = ? AND revoked_at IS NOT NULL',
          [a.email],
        ),
      ).toBe(1);
      expect(await count(database, 'sessions', 'user_id = ?', [a.userId])).toBe(
        0,
      );
      expect(
        await count(database, 'users', "id = ? AND status = 'suspended'", [
          a.userId,
        ]),
      ).toBe(1);
    }

    await expect(deleteAccount(scope, deps(database))).resolves.toMatchObject({
      status: 'deleted',
    });
    expect(await count(database, 'users', 'id = ?', [a.userId])).toBe(0);
    expect(await count(database, 'users', 'id = ?', [b.userId])).toBe(1);
    expect(
      await listIncompleteAccountDeletions(
        database as unknown as AccountDeletionDatabase,
      ),
    ).toEqual([]);
    expect(
      await count(
        database,
        'account_deletion_records',
        "status = 'completed'",
        [],
      ),
    ).toBe(1);
  });

  it('rolls back every row if the final transaction fails, leaving the account locked', async () => {
    const database = await setup();
    const a = principal('alice');
    await seedUser(database, a);
    const failing = {
      ...database,
      query: database.query.bind(database),
      transaction: async <T>(
        work: (tx: AccountDeletionDatabase) => Promise<T>,
      ) =>
        await (database as unknown as AccountDeletionDatabase).transaction?.(
          async (tx) =>
            await work({
              query: async (sql: string, values?: unknown[]) => {
                if (/DELETE FROM "users"/u.test(sql))
                  throw new Error('simulated storage failure');
                return await tx.query(sql, values);
              },
            }),
        ),
    } as unknown as AccountDeletionDatabase;
    await expect(
      deleteAccount(
        { tenantId: a.tenantId, userId: a.userId },
        { database: failing, dialect, environment: shared },
      ),
    ).rejects.toThrow('simulated storage failure');
    // Nothing was deleted by the aborted transaction.
    for (const table of accountOwnedTables) {
      expect(
        await count(database, table, 'tenant_id = ?', [a.tenantId]),
      ).toBeGreaterThan(0);
    }
    expect(await count(database, 'users', 'id = ?', [a.userId])).toBe(1);
    await expect(
      deleteAccount({ tenantId: a.tenantId, userId: a.userId }, deps(database)),
    ).resolves.toMatchObject({ status: 'deleted' });
  });

  it('refuses a tenant with another member, a mismatched scope, and private mode', async () => {
    const database = await setup();
    const a = principal('alice');
    const b = principal('bob');
    await seedUser(database, a);
    await seedUser(database, b);
    await expect(
      deleteAccount({ tenantId: a.tenantId, userId: b.userId }, deps(database)),
    ).rejects.toMatchObject({ code: 'scope-mismatch' });
    const role = (await database.query('SELECT id FROM roles LIMIT 1'))
      .rows[0] as { id: string };
    await insert(database, 'memberships', {
      role_id: role.id,
      status: 'active',
      tenant_id: a.tenantId,
      user_id: b.userId,
    });
    await expect(
      deleteAccount({ tenantId: a.tenantId, userId: a.userId }, deps(database)),
    ).rejects.toMatchObject({ code: 'tenant-not-exclusive' });
    await expect(
      deleteAccount(
        { tenantId: a.tenantId, userId: a.userId },
        {
          ...deps(database),
          environment: { IOLAUS_WORKSPACE_MODE: 'private' },
        },
      ),
    ).rejects.toBeInstanceOf(AccountDeletionError);
    expect(await count(database, 'users', 'id = ?', [a.userId])).toBe(1);
    expect(await count(database, 'users', 'id = ?', [b.userId])).toBe(1);
  });

  it('deletes only recorded files under the user own prefixes', async () => {
    const database = await setup();
    const a = principal('alice');
    const b = principal('bob');
    await seedUser(database, a);
    await seedUser(database, b);
    const assetA = randomUUID();
    const assetB = randomUUID();
    const store = new Set([
      `generated-resumes/${assetA}/resume.pdf`,
      `generated-resumes/${assetA}/resume.md`,
      `generated-resumes/${assetB}/resume.pdf`,
      'published/resume.pdf',
      'current-resume/resume.pdf',
    ]);
    for (const [who, id] of [
      [a, assetA],
      [b, assetB],
    ] as const) {
      await insert(database, 'resume_assets', {
        candidate_profile_id: who.profileId,
        generated_path: `generated-resumes/${id}`,
        id,
        markdown_path: `generated-resumes/${id}/resume.md`,
        owner_user_id: who.userId,
        pdf_path: `generated-resumes/${id}/resume.pdf`,
        tenant_id: who.tenantId,
      });
    }
    // Alice also (wrongly) points at the operator's published resume and at
    // Bob's file; neither may be deleted.
    await insert(database, 'resume_assets', {
      candidate_profile_id: a.profileId,
      html_path: `generated-resumes/${assetB}/resume.pdf`,
      owner_user_id: a.userId,
      pdf_path: 'published/resume.pdf',
      tenant_id: a.tenantId,
      text_path: '../etc/passwd',
    });
    const deleted: string[] = [];
    await deleteAccount(
      { tenantId: a.tenantId, userId: a.userId },
      deps(database, {
        filesystem: {
          delete: async (path: string) => {
            deleted.push(path);
            store.delete(path);
          },
          exists: async (path: string) => store.has(path),
        },
      }),
    );
    expect(deleted.sort()).toEqual([
      `generated-resumes/${assetA}/resume.md`,
      `generated-resumes/${assetA}/resume.pdf`,
    ]);
    expect(store.has(`generated-resumes/${assetB}/resume.pdf`)).toBe(true);
    expect(store.has('published/resume.pdf')).toBe(true);
  });

  it('keeps the account locked and re-runnable when a file cannot be deleted', async () => {
    const database = await setup();
    const a = principal('alice');
    await seedUser(database, a);
    const id = randomUUID();
    await insert(database, 'resume_assets', {
      candidate_profile_id: a.profileId,
      owner_user_id: a.userId,
      pdf_path: `generated-resumes/${id}/resume.pdf`,
      id,
      tenant_id: a.tenantId,
    });
    let failing = true;
    const filesystem = {
      delete: async () => {
        if (failing) throw new Error('s3 unavailable');
      },
      exists: async () => true,
    };
    const scope = { tenantId: a.tenantId, userId: a.userId };
    await expect(
      deleteAccount(scope, deps(database, { filesystem })),
    ).rejects.toMatchObject({ code: 'files' });
    expect(await count(database, 'users', 'id = ?', [a.userId])).toBe(1);
    expect(
      await count(database, 'resume_assets', 'tenant_id = ?', [a.tenantId]),
    ).toBeGreaterThan(0);
    failing = false;
    await expect(
      deleteAccount(scope, deps(database, { filesystem })),
    ).resolves.toMatchObject({ status: 'deleted' });
  });
}

describe('account deletion on SQLite', () => {
  deletionContract(async () => await getTestDatabase({ classes }), 'sqlite');
});

const postgresUrl =
  process.env.ACCOUNT_DELETION_POSTGRES_TEST_DATABASE_URL?.trim();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe.runIf(postgresUrl)('account deletion on PostgreSQL', () => {
  const databases: string[] = [];
  let control: DatabaseInterface | undefined;

  afterEach(async () => {
    for (const name of databases.splice(0)) {
      await control?.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`,
      );
    }
    await control?.close?.();
    control = undefined;
  });

  deletionContract(async () => {
    if (!postgresUrl) throw new Error('Expected a PostgreSQL test URL.');
    control = await getDatabase({
      cache: false,
      type: 'postgres',
      url: postgresUrl,
    });
    const name = `iolaus_delete_${randomUUID().replaceAll('-', '')}`;
    databases.push(name);
    await control.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    const url = new URL(postgresUrl);
    url.pathname = `/${name}`;
    const db = await getDatabase({
      cache: false,
      type: 'postgres',
      url: url.toString(),
    });
    return await getTestDatabase({ db, classes });
  }, 'postgres');
});
