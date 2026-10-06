import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFilesystem } from '@happyvertical/files';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  backfillProfileEmailKeys,
  ProfileCollection,
} from '@happyvertical/smrt-profiles';
import {
  backfillUserEmailKeys,
  UserCollection,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { insert } from './fixtures/account-seed.js';
import './smrt.js';
import { exportWorkspace } from './workspace-export.js';
import {
  importWorkspace,
  rollbackWorkspaceImport,
} from './workspace-import.js';
import { workspaceOwnershipClasses } from './workspace-ownership-backfill.js';
import {
  canonicalJson,
  computeBundleSha256,
  ownedTables,
  sha256Hex,
  type TransferDatabase,
  type TransferDialect,
  WorkspaceTransferError,
} from './workspace-transfer.js';

// Two schemas of ~70 tables are created per test.
vi.setConfig({ hookTimeout: 300_000, testTimeout: 300_000 });

type TestDatabase = Awaited<ReturnType<typeof getTestDatabase>>;

const shared = {
  IOLAUS_WORKSPACE_MODE: 'shared',
  SMRT_APP_ID: 'beta-app',
  SMRT_RUNTIME_PROFILE: 'self-hosted',
};

const classes = [
  ...workspaceOwnershipClasses,
  'OpportunityRecommendationRank',
  'Tag',
  'Company',
  'CompanyResearch',
  'Source',
  'Opportunity',
  'SourceTag',
  'CompanyTag',
  'OpportunityTag',
  'HostedInvite',
  'User',
  'Tenant',
  'Membership',
  'Role',
  'Permission',
  'RolePermission',
  'Session',
  'Profile',
  'ProfileType',
  'OidcIdentity',
  'OidcProfileEmailReservation',
];

interface Principal {
  candidateProfileId: string;
  email: string;
  smrtProfileId: string;
  tenantId: string;
  userId: string;
}

function principal(label: string): Principal {
  return {
    candidateProfileId: randomUUID(),
    email: `${label}@example.invalid`,
    smrtProfileId: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
  };
}

const SECRET = 'PRIVATE-NOTE-SHOULD-NOT-TRAVEL';

interface Seeded {
  agentRunKept: string;
  agentRunDropped: string;
  assetKey: string;
  opportunityIds: string[];
}

async function count(
  db: TransferDatabase,
  table: string,
  where = '1 = 1',
  values: unknown[] = [],
): Promise<number> {
  const result = (await db.query(
    `SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`,
    values,
  )) as { rows: Array<{ n: unknown }> };
  return Number(result.rows[0].n);
}

async function seedSource(
  db: TestDatabase,
  who: Principal,
  dialect: TransferDialect,
): Promise<Seeded> {
  const bool = (value: boolean) =>
    dialect === 'sqlite' ? (value ? 1 : 0) : value;
  await insert(db, 'users', {
    email: `source-${who.email}`,
    email_key: `source-${who.email}`,
    id: who.userId,
    profile_id: who.smrtProfileId,
    status: 'active',
  });
  const tag = randomUUID();
  await insert(db, 'tags', {
    _meta_type: 'tag',
    id: tag,
    name: 'remote',
    slug: 'remote-x',
  });
  const company = randomUUID();
  await insert(db, 'companies', {
    company_key: 'acme',
    id: company,
    name: 'Acme',
    slug: 'acme',
  });
  // The parent sorts after its child, so id order alone would insert the child
  // first and violate the self-referencing foreign key.
  const source = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await insert(db, 'sources', {
    account_notes: SECRET,
    id: source,
    is_active: bool(true),
    login_identity: SECRET,
    owner: SECRET,
    slug: 'board-x',
    warden_reference: SECRET,
  });
  await insert(db, 'sources', {
    account_notes: SECRET,
    id: '00000000-0000-4000-8000-000000000001',
    is_active: bool(false),
    parent_source_id: source,
    slug: 'board-child',
  });
  const opportunityIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of opportunityIds.entries()) {
    await insert(db, 'opportunities', {
      canonical_url: `https://jobs.example.invalid/${index}`,
      // U+2028 is legal inside JSON strings but splits lines in readline.
      title: `Engineer\u2028${index}`,
      company_id: company,
      id,
      preferred_skills: 'sql',
      required_skills: 'typescript,go',
      reviewed_by_user_id: randomUUID(),
      slug: `opp-${index}`,
      source_id: source,
    });
  }
  await insert(db, 'source_tags', { source_id: source, tag_id: tag });
  await insert(db, 'opportunity_tags', {
    opportunity_id: opportunityIds[0],
    tag_id: tag,
    tag_role: 'general',
  });
  await insert(db, 'company_research', { why_interesting: SECRET });

  const agentRunKept = randomUUID();
  const agentRunDropped = randomUUID();
  const tuple = {
    owner_user_id: who.userId,
    tenant_id: who.tenantId,
  };
  for (const table of ownedTables) {
    const own =
      table === 'candidate_profiles'
        ? { ...tuple, id: who.candidateProfileId }
        : { ...tuple, candidate_profile_id: who.candidateProfileId };
    const extra: Record<string, unknown> = {};
    if (table === 'agent_runs') {
      await insert(db, table, { ...own, id: agentRunKept });
      await insert(db, table, { ...own, id: agentRunDropped });
      continue;
    }
    if (
      table === 'opportunity_assessments' ||
      table === 'opportunity_recommendation_ranks'
    ) {
      extra.agent_run_id = agentRunKept;
      extra.opportunity_id = opportunityIds[0];
    }
    if (table === 'decisions') extra.decider_user_id = randomUUID();
    await insert(db, table, { ...own, ...extra });
  }
  return { agentRunDropped, agentRunKept, assetKey: '', opportunityIds };
}

async function seedBystander(
  db: TestDatabase,
  other: Principal,
): Promise<void> {
  for (const table of ownedTables) {
    await insert(db, table, {
      ...(table === 'candidate_profiles'
        ? { id: other.candidateProfileId }
        : { candidate_profile_id: other.candidateProfileId }),
      owner_user_id: other.userId,
      tenant_id: other.tenantId,
    });
  }
}

function transfer(contract: {
  open: () => Promise<TestDatabase>;
  dialect: TransferDialect;
}) {
  const { dialect, open } = contract;
  const dirs: string[] = [];
  let sourceDb: TestDatabase | undefined;
  let targetDb: TestDatabase | undefined;
  const bundles = new Map<string, ReturnType<typeof buildBundle>>();

  afterAll(async () => {
    await sourceDb?.close?.();
    await targetDb?.close?.();
    for (const dir of dirs.splice(0))
      rmSync(dir, { force: true, recursive: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'iolaus-transfer-'));
    dirs.push(dir);
    return dir;
  };

  /** One source workspace (owner + bystander + assets); bundles are read-only. */
  async function buildBundle() {
    sourceDb ??= await open();
    const source = sourceDb;
    const who = principal('owner');
    const seeded = await seedSource(source, who, dialect);
    await seedBystander(source, principal('bystander'));
    const sourceFs = await getFilesystem({
      basePath: tempDir(),
      type: 'local',
    });
    const owned = (
      (await source.query('SELECT id FROM resume_assets WHERE tenant_id = ?', [
        who.tenantId,
      ])) as unknown as { rows: Array<{ id: string }> }
    ).rows[0].id;
    seeded.assetKey = `generated-resumes/${owned}/resume.pdf`;
    await sourceFs.write(seeded.assetKey, Buffer.from('%PDF-owner-bytes'));
    await sourceFs.write(
      'generated-resumes/not-owned/x.pdf',
      Buffer.from('nope'),
    );
    const out = join(tempDir(), 'bundle');
    const result = await exportWorkspace({
      database: source as unknown as TransferDatabase,
      dialect,
      filesystem: sourceFs,
      outDir: out,
      tenantId: who.tenantId,
      userId: who.userId,
    });
    // The source is only needed to build the bundle; release it so an
    // in-memory SQLite target is a different database.
    await source.close?.();
    sourceDb = undefined;
    return { out, result, seeded, who };
  }
  async function exported(options: { stripRankSnapshots?: boolean } = {}) {
    if (!bundles.has('plain')) bundles.set('plain', buildBundle());
    const plain = await (bundles.get('plain') as ReturnType<
      typeof buildBundle
    >);
    if (!options.stripRankSnapshots) return plain;
    if (!bundles.has('strip')) {
      const out = join(tempDir(), 'bundle');
      cpSync(plain.out, out, { recursive: true });
      stripRankSnapshots(out);
      bundles.set('strip', Promise.resolve({ ...plain, out }));
    }
    return await (bundles.get('strip') as ReturnType<typeof buildBundle>);
  }

  /** The hosted target, emptied so each test starts from a migrated empty database. */
  const hostedTarget = async () => {
    if (dialect === 'sqlite') {
      // An in-memory database is cheap to replace; wiping one in place is not
      // reliable across the adapter's transaction handling.
      await targetDb?.close?.();
      targetDb = await open();
    } else {
      targetDb ??= await open();
    }
    const db = targetDb;
    if (dialect === 'postgres') {
      const names = (
        (await db.query(
          `SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()`,
        )) as unknown as { rows: Array<{ name: string }> }
      ).rows
        .map((row) => row.name)
        .filter((name) => !name.startsWith('_smrt'));
      await db.query(
        `TRUNCATE ${names.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
    }
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    const fs = await getFilesystem({ basePath: tempDir(), type: 'local' });
    return { db, fs, receipt: join(tempDir(), 'receipt.json') };
  };

  const run = (
    db: TestDatabase,
    fs: Awaited<ReturnType<typeof getFilesystem>>,
    out: string,
    extra: Partial<Parameters<typeof importWorkspace>[0]> = {},
  ) =>
    importWorkspace({
      bundleDir: out,
      database: db as unknown as TransferDatabase,
      dialect,
      email: 'Owner@Example.invalid',
      environment: shared,
      filesystem: fs,
      mode: 'dry-run',
      ...extra,
    });

  it('exports only the owner workspace plus catalog and never the private fields', async () => {
    const { out, result, seeded, who } = await exported();
    for (const table of ownedTables) {
      if (table === 'agent_runs') continue;
      expect(result.tables[table], table).toBe(1);
    }
    // only the referenced agent run travels
    expect(result.tables.agent_runs).toBe(1);
    expect(result.tables.opportunities).toBe(3);
    expect(result.tables.sources).toBe(2);
    expect(result.tables.company_research).toBeUndefined();
    expect(result.assets).toBe(1);
    const everything = readdirDeep(out)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(seeded.agentRunDropped);
    expect(everything).toContain(who.tenantId);
    const manifest = JSON.parse(
      readFileSync(join(out, 'manifest.json'), 'utf8'),
    );
    expect(manifest.identity).toEqual({
      candidateProfileId: who.candidateProfileId,
      smrtProfileId: who.smrtProfileId,
      tenantId: who.tenantId,
      userId: who.userId,
    });
  });

  it('dry-runs without writing, refuses a wrong digest, then applies the reviewed plan', async () => {
    const { out, seeded, who } = await exported({ stripRankSnapshots: true });
    const { db, fs, receipt } = await hostedTarget();

    const plan = await run(db, fs, out);
    expect(plan.mode).toBe('dry-run');
    expect(plan.plan.eligible).toBe(true);
    expect(plan.plan.identity.create).toBe(true);
    expect(plan.plan.tables.opportunities.inserted).toBe(3);
    expect(plan.plan.assets.toUpload).toBe(1);
    expect(await count(db, 'users')).toBe(0);
    expect(await count(db, 'opportunities')).toBe(0);
    expect(await fs.exists(seeded.assetKey)).toBe(false);
    // counts only: no identifiers or content in the plan output
    const printed = JSON.stringify(plan);
    expect(printed).not.toContain(who.userId);
    expect(printed).not.toContain('owner@example.invalid');

    await expect(
      run(db, fs, out, {
        expectedPlanSha256: sha256Hex('nope'),
        mode: 'apply',
        receiptPath: receipt,
      }),
    ).rejects.toMatchObject({ code: 'plan-mismatch' });
    expect(await count(db, 'users')).toBe(0);
    expect(await fs.exists(seeded.assetKey)).toBe(false);
    await expect(
      run(db, fs, out, { mode: 'apply', receiptPath: receipt }),
    ).rejects.toMatchObject({ code: 'plan-mismatch' });

    const applied = await run(db, fs, out, {
      expectedPlanSha256: plan.planSha256,
      mode: 'apply',
      receiptPath: receipt,
    });
    expect(applied.mode).toBe('applied');
    expect(applied.planSha256).toBe(plan.planSha256);
    expect(existsSync(receipt)).toBe(true);

    // identity preserved, target email used
    const user = (
      (await db.query('SELECT id, email, profile_id FROM users')) as {
        rows: Array<Record<string, string>>;
      }
    ).rows;
    expect(user).toHaveLength(1);
    expect(user[0].id).toBe(who.userId);
    expect(user[0].email).toBe('owner@example.invalid');
    expect(user[0].profile_id).toBe(who.smrtProfileId);
    expect(await count(db, 'tenants', 'id = ?', [who.tenantId])).toBe(1);
    expect(await count(db, 'memberships')).toBe(1);

    // every private row carries exactly the owner tuple
    for (const table of ownedTables) {
      expect(await count(db, table), table).toBe(1);
      expect(
        await count(
          db,
          table,
          'NOT (CAST(tenant_id AS TEXT) = ? AND CAST(owner_user_id AS TEXT) = ?)',
          [who.tenantId, who.userId],
        ),
        table,
      ).toBe(0);
    }
    // catalog: private fields blanked, state preserved, nothing skipped leaked
    expect(await count(db, 'company_research')).toBe(0);
    const source = (
      (await db.query('SELECT * FROM sources')) as {
        rows: Array<Record<string, unknown>>;
      }
    ).rows[0];
    expect(source.account_notes).toBe('');
    expect(source.login_identity).toBe('');
    expect(source.warden_reference).toBe('');
    expect(source.owner).toBe('');
    expect(
      Boolean(Number(source.is_active === true ? 1 : source.is_active)),
    ).toBe(true);
    // rank snapshot columns backfilled from the imported opportunity
    const rank = (
      (await db.query(
        'SELECT required_skills_snapshot AS r, preferred_skills_snapshot AS p FROM opportunity_recommendation_ranks',
      )) as { rows: Array<Record<string, string>> }
    ).rows[0];
    expect(rank).toEqual({ p: 'sql', r: 'typescript,go' });
    expect(
      await count(db, 'opportunities', 'reviewed_by_user_id <> ?', ['']),
    ).toBe(0);
    // assets uploaded byte for byte
    expect((await fs.read(seeded.assetKey, { raw: true })).toString()).toBe(
      '%PDF-owner-bytes',
    );
    expect(await fs.exists('generated-resumes/not-owned/x.pdf')).toBe(false);

    // idempotent: re-running changes nothing
    const again = await run(db, fs, out);
    expect(again.plan.identity.create).toBe(false);
    for (const [table, stats] of Object.entries(again.plan.tables)) {
      expect(stats.inserted, table).toBe(0);
    }
    const rerun = await run(db, fs, out, {
      expectedPlanSha256: again.planSha256,
      mode: 'apply',
      receiptPath: join(tempDir(), 'receipt-2.json'),
    });
    expect(rerun.plan.assets.toUpload).toBe(0);
    expect(await count(db, 'users')).toBe(1);
    expect(await count(db, 'opportunities')).toBe(3);
    expect(await count(db, 'opportunity_recommendation_ranks')).toBe(1);

    // the first magic-link sign-in reuses the imported identity
    const { provisionHostedMagicLinkUser } = await import(
      './hosted-oidc-provisioning.js'
    );
    const { ensureHostedWorkspaceAccess } = await import('./auth.js');
    const users = await UserCollection.create({ db });
    const signedIn = await provisionHostedMagicLinkUser(
      'owner@example.invalid',
      users,
    );
    expect(signedIn.id).toBe(who.userId);
    const access = await ensureHostedWorkspaceAccess(signedIn, {
      options: { db },
    });
    expect(access.tenant.id).toBe(who.tenantId);
    expect(await count(db, 'users')).toBe(1);
    expect(await count(db, 'tenants')).toBe(1);
    expect(await ProfileCollection.create({ db })).toBeDefined();
  });

  it('keeps a second user from seeing anything private', async () => {
    const { out, who } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    const other = principal('other');
    await seedBystander(db, other);
    const plan = await run(db, fs, out);
    await run(db, fs, out, {
      expectedPlanSha256: plan.planSha256,
      mode: 'apply',
      receiptPath: receipt,
    });
    for (const table of ownedTables) {
      expect(
        await count(db, table, 'CAST(tenant_id AS TEXT) = ?', [other.tenantId]),
        table,
      ).toBe(1);
      expect(
        await count(db, table, 'CAST(owner_user_id AS TEXT) = ?', [
          other.userId,
        ]),
        table,
      ).toBe(1);
      expect(
        await count(
          db,
          table,
          'CAST(tenant_id AS TEXT) = ? AND CAST(owner_user_id AS TEXT) <> ?',
          [who.tenantId, who.userId],
        ),
        table,
      ).toBe(0);
    }
    expect(
      await count(
        db,
        'opportunity_assessments',
        'CAST(owner_user_id AS TEXT) = ? AND CAST(tenant_id AS TEXT) = ?',
        [other.userId, who.tenantId],
      ),
    ).toBe(0);
  });

  it('dedupes catalog rows against the target and remaps references', async () => {
    const { out, seeded } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    const existing = randomUUID();
    await insert(db, 'opportunities', {
      canonical_url: 'https://jobs.example.invalid/0',
      id: existing,
      slug: 'already-there',
    });
    // The target already has the same tag on that posting: the remapped join
    // row would violate the (parent, tag, role) unique index if not deduped.
    const existingTag = randomUUID();
    await insert(db, 'tags', {
      _meta_type: 'tag',
      id: existingTag,
      name: 'remote',
      slug: 'remote-x',
    });
    await insert(db, 'opportunity_tags', {
      opportunity_id: existing,
      tag_id: existingTag,
      tag_role: 'general',
    });
    const plan = await run(db, fs, out);
    expect(plan.plan.eligible).toBe(true);
    expect(plan.plan.tables.opportunities.deduped).toBe(1);
    expect(plan.plan.tables.opportunities.inserted).toBe(2);
    expect(plan.plan.tables.tags.deduped).toBe(1);
    expect(plan.plan.tables.opportunity_tags.deduped).toBe(1);
    // ranks that hash the opportunity id cannot stay current: surfaced, not hidden
    expect(
      Object.keys(plan.plan.warnings).filter((key) =>
        key.startsWith('opportunity_recommendation_ranks'),
      ),
    ).toHaveLength(1);
    await run(db, fs, out, {
      expectedPlanSha256: plan.planSha256,
      mode: 'apply',
      receiptPath: receipt,
    });
    expect(await count(db, 'opportunities')).toBe(3);
    expect(await count(db, 'opportunity_tags')).toBe(1);
    const rank = (
      (await db.query(
        'SELECT opportunity_id FROM opportunity_recommendation_ranks',
      )) as {
        rows: Array<Record<string, string>>;
      }
    ).rows[0];
    expect(rank.opportunity_id).toBe(existing);
    expect(rank.opportunity_id).not.toBe(seeded.opportunityIds[0]);
  });

  it('blocks on slug collisions and on an account with different ids, writing nothing', async () => {
    const { out, who } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    const exportedSlug = JSON.parse(
      readFileSync(join(out, 'data', 'candidate_profiles.jsonl'), 'utf8').split(
        '\n',
      )[0],
    ).slug as string;
    await insert(db, 'candidate_profiles', {
      owner_user_id: randomUUID(),
      slug: exportedSlug,
      tenant_id: randomUUID(),
    });
    const blocked = await run(db, fs, out);
    expect(blocked.plan.eligible).toBe(false);
    expect(
      blocked.plan.issues['candidate_profiles: slug/context already taken'],
    ).toBe(1);
    await expect(
      run(db, fs, out, {
        expectedPlanSha256: blocked.planSha256,
        mode: 'apply',
        receiptPath: receipt,
      }),
    ).rejects.toMatchObject({ code: 'collision' });
    expect(await count(db, 'users')).toBe(0);

    // a fresh target that already has this address under different ids
    const second = await hostedTarget();
    await insert(second.db, 'users', {
      email: 'owner@example.invalid',
      email_key: 'owner@example.invalid',
      profile_id: randomUUID(),
      status: 'active',
    });
    await expect(run(second.db, second.fs, out)).rejects.toMatchObject({
      code: 'identity',
    });
    expect(who.userId).toBeDefined();
  });

  it('refuses a tampered bundle and a wrong deployment mode', async () => {
    const { out: shared_ } = await exported();
    const out = join(tempDir(), 'copy');
    cpSync(shared_, out, { recursive: true });
    const { db, fs } = await hostedTarget();
    await expect(
      run(db, fs, out, { environment: { SMRT_RUNTIME_PROFILE: 'local' } }),
    ).rejects.toMatchObject({ code: 'mode' });
    const file = join(out, 'data', 'tags.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')} \n`);
    await expect(run(db, fs, out)).rejects.toBeInstanceOf(
      WorkspaceTransferError,
    );
    await expect(run(db, fs, out)).rejects.toMatchObject({ code: 'bundle' });
  });

  it('rolls an applied import back from its receipt without touching pre-existing rows', async () => {
    const { out, seeded } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    await insert(db, 'opportunities', {
      canonical_url: 'https://jobs.example.invalid/0',
      slug: 'already-there',
    });
    const bystander = principal('target-bystander');
    await seedBystander(db, bystander);
    const plan = await run(db, fs, out);
    await run(db, fs, out, {
      expectedPlanSha256: plan.planSha256,
      mode: 'apply',
      receiptPath: receipt,
    });
    // A damaged receipt must not reach another tenant's rows.
    const bystanderDecision = (
      (await db.query('SELECT id FROM decisions WHERE tenant_id = ?', [
        bystander.tenantId,
      ])) as unknown as { rows: Array<{ id: string }> }
    ).rows[0].id;
    const edited = JSON.parse(readFileSync(receipt, 'utf8'));
    edited.inserted.decisions.push(bystanderDecision);
    writeFileSync(receipt, JSON.stringify(edited));
    const result = await rollbackWorkspaceImport({
      database: db as unknown as TransferDatabase,
      dialect,
      filesystem: fs,
      receiptPath: receipt,
    });
    expect(result.assetsRemoved).toBe(1);
    expect(await fs.exists(seeded.assetKey)).toBe(false);
    for (const table of ['users', 'tenants', 'memberships', 'profiles']) {
      expect(await count(db, table), table).toBe(0);
    }
    for (const table of ownedTables) {
      expect(
        await count(db, table, 'CAST(tenant_id AS TEXT) <> ?', [
          bystander.tenantId,
        ]),
        table,
      ).toBe(0);
      expect(
        await count(db, table, 'CAST(tenant_id AS TEXT) = ?', [
          bystander.tenantId,
        ]),
        table,
      ).toBe(1);
    }
    expect(await count(db, 'opportunities')).toBe(1);
    expect(await count(db, 'sources')).toBe(0);
    expect(await count(db, 'tags')).toBe(0);
    // and the import can be run again after a rollback
    const retry = await run(db, fs, out);
    expect(retry.plan.eligible).toBe(true);
    expect(retry.plan.tables.opportunities.deduped).toBe(1);
  });

  it('refuses to roll back while later rows reference imported catalog rows', async () => {
    const { out } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    const plan = await run(db, fs, out);
    await run(db, fs, out, {
      expectedPlanSha256: plan.planSha256,
      mode: 'apply',
      receiptPath: receipt,
    });
    // what the crawler does after import: new postings under an imported source
    await insert(db, 'opportunities', {
      canonical_url: 'https://jobs.example.invalid/crawled',
      slug: 'crawled-later',
      source_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    await expect(
      rollbackWorkspaceImport({
        database: db as unknown as TransferDatabase,
        dialect,
        filesystem: fs,
        receiptPath: receipt,
      }),
    ).rejects.toMatchObject({ code: 'rollback' });
    // nothing was removed: the refusal rolled the whole transaction back
    expect(await count(db, 'users')).toBe(1);
    expect(await count(db, 'sources')).toBe(2);
    expect(await count(db, 'opportunity_recommendation_ranks')).toBe(1);
  });

  it('never lets a re-run or pending receipt delete files the committed import uses', async () => {
    const { out, seeded } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    const plan = await run(db, fs, out);
    await run(db, fs, out, {
      expectedPlanSha256: plan.planSha256,
      mode: 'apply',
      receiptPath: receipt,
    });
    expect(JSON.parse(readFileSync(receipt, 'utf8')).committed).toBe(true);
    // idempotent re-run with its own receipt: nothing inserted, assets identical
    const again = await run(db, fs, out);
    const receipt2 = join(tempDir(), 'receipt-rerun.json');
    await run(db, fs, out, {
      expectedPlanSha256: again.planSha256,
      mode: 'apply',
      receiptPath: receipt2,
    });
    const rerun = await rollbackWorkspaceImport({
      database: db as unknown as TransferDatabase,
      dialect,
      filesystem: fs,
      receiptPath: receipt2,
    });
    expect(rerun.assetsRemoved).toBe(0);
    expect(rerun.assetsKept).toBe(1);
    expect(await fs.exists(seeded.assetKey)).toBe(true);
    expect(await count(db, 'users')).toBe(1);
    expect(await count(db, 'opportunity_recommendation_ranks')).toBe(1);
    // a receipt whose commit was never confirmed only cleans unreferenced objects
    const pending = JSON.parse(readFileSync(receipt, 'utf8'));
    pending.committed = false;
    const receipt3 = join(tempDir(), 'receipt-pending.json');
    writeFileSync(receipt3, JSON.stringify(pending));
    const result = await rollbackWorkspaceImport({
      database: db as unknown as TransferDatabase,
      dialect,
      filesystem: fs,
      receiptPath: receipt3,
    });
    expect(result.databaseRolledBack).toBe(false);
    expect(result.assetsRemoved).toBe(0);
    expect(await fs.exists(seeded.assetKey)).toBe(true);
    expect(await count(db, 'users')).toBe(1);
    expect(await count(db, 'opportunities')).toBe(3);
  });

  it('refuses a bundle whose asset key is not owned by an imported record', async () => {
    const { out: shared_ } = await exported();
    const out = join(tempDir(), 'copy');
    cpSync(shared_, out, { recursive: true });
    const key = 'generated-resumes/not-an-imported-record/x.pdf';
    mkdirSync(
      join(out, 'assets', 'generated-resumes', 'not-an-imported-record'),
      {
        recursive: true,
      },
    );
    writeFileSync(join(out, 'assets', key), 'planted');
    const manifestPath = join(out, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.assets.push({ path: key, sha256: sha256Hex('planted'), size: 7 });
    manifest.assets.sort((a: { path: string }, b: { path: string }) =>
      a.path.localeCompare(b.path),
    );
    const { bundleSha256: _old, ...rest } = manifest;
    manifest.bundleSha256 = computeBundleSha256(rest);
    writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
    const { db, fs } = await hostedTarget();
    await expect(run(db, fs, out)).rejects.toMatchObject({ code: 'bundle' });
    expect(await fs.exists(key)).toBe(false);
  });

  it('lets an operator confirm a receipt whose commit marker was lost', async () => {
    const { out } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    const plan = await run(db, fs, out);
    await run(db, fs, out, {
      expectedPlanSha256: plan.planSha256,
      mode: 'apply',
      receiptPath: receipt,
    });
    const lost = JSON.parse(readFileSync(receipt, 'utf8'));
    lost.committed = false;
    const lostPath = join(tempDir(), 'receipt-lost.json');
    writeFileSync(lostPath, JSON.stringify(lost));
    const result = await rollbackWorkspaceImport({
      confirmCommitted: true,
      database: db as unknown as TransferDatabase,
      dialect,
      filesystem: fs,
      receiptPath: lostPath,
    });
    expect(result.databaseRolledBack).toBe(true);
    expect(Object.keys(result.deleted).length).toBeGreaterThan(0);
    expect(await count(db, 'users')).toBe(0);
    expect(await count(db, 'opportunity_recommendation_ranks')).toBe(0);
  });

  it('refuses to roll back an account that gained memberships since the import', async () => {
    const { out } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    const plan = await run(db, fs, out);
    await run(db, fs, out, {
      expectedPlanSha256: plan.planSha256,
      mode: 'apply',
      receiptPath: receipt,
    });
    const manifest = JSON.parse(
      readFileSync(join(out, 'manifest.json'), 'utf8'),
    );
    const otherTenant = randomUUID();
    await insert(db, 'tenants', {
      _meta_type: 'tenant',
      id: otherTenant,
      name: 'shared team',
      status: 'active',
    });
    const roleId = (
      (await db.query('SELECT role_id FROM memberships WHERE user_id = ?', [
        manifest.identity.userId,
      ])) as unknown as { rows: Array<{ role_id: string }> }
    ).rows[0].role_id;
    await insert(db, 'memberships', {
      role_id: roleId,
      status: 'active',
      tenant_id: otherTenant,
      user_id: manifest.identity.userId,
    });
    await expect(
      rollbackWorkspaceImport({
        database: db as unknown as TransferDatabase,
        dialect,
        filesystem: fs,
        receiptPath: receipt,
      }),
    ).rejects.toMatchObject({ code: 'rollback' });
    expect(await count(db, 'users')).toBe(1);
    expect(await count(db, 'opportunity_recommendation_ranks')).toBe(1);
  });

  it('requires an explicit receipt path for apply and records every asset before uploading', async () => {
    const { out, seeded } = await exported();
    const { db, fs, receipt } = await hostedTarget();
    const plan = await run(db, fs, out);
    await expect(
      run(db, fs, out, { expectedPlanSha256: plan.planSha256, mode: 'apply' }),
    ).rejects.toMatchObject({ code: 'receipt' });
    expect(await count(db, 'users')).toBe(0);
    // an existing receipt path is refused before any upload happens
    writeFileSync(receipt, '{}');
    await expect(
      run(db, fs, out, {
        expectedPlanSha256: plan.planSha256,
        mode: 'apply',
        receiptPath: receipt,
      }),
    ).rejects.toMatchObject({ code: 'receipt' });
    expect(await fs.exists(seeded.assetKey)).toBe(false);
    expect(await count(db, 'users')).toBe(0);
  });
}

function readdirDeep(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? readdirDeep(path) : [path];
  });
}

/** Simulate an older source that predates the rank skill snapshot columns. */
function stripRankSnapshots(out: string): void {
  const table = 'opportunity_recommendation_ranks';
  const file = join(out, 'data', `${table}.jsonl`);
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      row.required_skills_snapshot = undefined;
      row.preferred_skills_snapshot = undefined;
      return JSON.stringify(row);
    });
  const body = `${rows.join('\n')}\n`;
  writeFileSync(file, body);
  const manifestPath = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.tables[table].columns = manifest.tables[table].columns.filter(
    (column: string) => !column.endsWith('_skills_snapshot'),
  );
  manifest.tables[table].sha256 = sha256Hex(body);
  const { bundleSha256: _old, ...rest } = manifest;
  manifest.bundleSha256 = computeBundleSha256(rest);
  writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
}

describe('workspace transfer on SQLite', () => {
  transfer({
    dialect: 'sqlite',
    // Uncached, so source and target are two distinct in-memory databases.
    open: async () =>
      await getTestDatabase({
        classes,
        db: await getDatabase({
          cache: false,
          type: 'sqlite',
          url: ':memory:',
        }),
      }),
  });
});

const postgresUrl =
  process.env.WORKSPACE_TRANSFER_POSTGRES_TEST_DATABASE_URL?.trim();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe.runIf(postgresUrl)('workspace transfer on PostgreSQL', () => {
  const databases: string[] = [];
  let control: DatabaseInterface | undefined;
  afterAll(async () => {
    for (const name of databases.splice(0)) {
      await control?.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`,
      );
    }
    await control?.close?.();
    control = undefined;
  });
  transfer({
    dialect: 'postgres',
    open: async () => {
      if (!postgresUrl) throw new Error('Expected a PostgreSQL test URL.');
      control ??= await getDatabase({
        cache: false,
        type: 'postgres',
        url: postgresUrl,
      });
      const name = `iolaus_transfer_${randomUUID().replaceAll('-', '')}`;
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
    },
  });
});
