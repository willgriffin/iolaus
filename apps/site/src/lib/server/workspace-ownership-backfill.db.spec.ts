import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyWorkspaceOwnershipBackfill,
  planWorkspaceOwnershipBackfill,
  type WorkspaceOwnershipDatabase,
} from './workspace-ownership-backfill.js';
import {
  prepareWorkspaceOwnershipSchema,
  workspaceOwnershipSchemaPrepared,
} from './workspace-ownership-schema.js';
import './smrt.js';

const postgresUrl = process.env.WORKSPACE_OWNERSHIP_TEST_POSTGRES_URL?.trim();
const binding = {
  candidateProfileId: 'profile-1',
  ownerUserId: 'user-1',
  tenantId: 'tenant-1',
};
const tables = ['candidate_profiles', 'applications'] as const;
const postgresFixtureSchema = 'hv_workspace_ownership_fixture';

async function selectFixtureSchema(
  database: DatabaseInterface,
  dialect: 'postgres' | 'sqlite',
): Promise<void> {
  if (dialect !== 'postgres') return;
  await database.query(`CREATE SCHEMA IF NOT EXISTS ${postgresFixtureSchema}`);
  // This suite uses a single pinned connection. The private schema prevents
  // fixture DDL from ever resolving to the disposable database's app tables.
  await database.query(`SET search_path TO ${postgresFixtureSchema}`);
}

async function setup(
  database: DatabaseInterface,
  dialect: 'postgres' | 'sqlite',
): Promise<void> {
  await database.query('DROP TABLE IF EXISTS applications');
  await database.query('DROP TABLE IF EXISTS candidate_profiles');
  await database.query(`CREATE TABLE candidate_profiles (
    id TEXT PRIMARY KEY, tenant_id TEXT, owner_user_id TEXT
  )`);
  await database.query(`CREATE TABLE applications (
    id TEXT PRIMARY KEY, tenant_id TEXT, owner_user_id TEXT,
    candidate_profile_id TEXT, immutable_history_target_id TEXT
  )`);
}

function runSuite(
  label: string,
  config: { type: 'postgres' | 'sqlite'; url: string },
): void {
  describe(label, () => {
    let database: DatabaseInterface;

    beforeAll(async () => {
      const fixtureConfig =
        config.type === 'postgres'
          ? (() => {
              const url = new URL(config.url);
              url.searchParams.set(
                'options',
                `-c search_path=${postgresFixtureSchema}`,
              );
              return { ...config, url: url.toString() };
            })()
          : config;
      database = await getDatabase(
        config.type === 'postgres'
          ? { ...fixtureConfig, cache: false, max: 1 }
          : { ...fixtureConfig, cache: false },
      );
      if (
        config.type === 'postgres' &&
        !new URL(config.url).pathname.includes('public_disposable_tests')
      ) {
        throw new Error(
          'PostgreSQL ownership fixture requires the dedicated disposable test database.',
        );
      }
      await selectFixtureSchema(database, config.type);
      await setup(database, config.type);
    });
    beforeEach(async () => {
      // The nullable-schema test intentionally replaces both tables. Rebuild
      // this suite's isolated schema for every following case so its legacy
      // shape cannot leak into a CAS assertion.
      await setup(database, config.type);
    });
    afterAll(async () => {
      await database.query('DROP TABLE IF EXISTS applications');
      await database.query('DROP TABLE IF EXISTS candidate_profiles');
      if (config.type === 'postgres') {
        await database.query(
          `DROP SCHEMA IF EXISTS ${postgresFixtureSchema} CASCADE`,
        );
      }
      await database.close?.();
    });

    it('adds missing ownership columns as nullable before the reviewed backfill', async () => {
      await database.query('DROP TABLE applications');
      await database.query('DROP TABLE candidate_profiles');
      await database.query(
        'CREATE TABLE candidate_profiles (id TEXT PRIMARY KEY)',
      );
      await database.query('CREATE TABLE applications (id TEXT PRIMARY KEY)');

      const statuses = await prepareWorkspaceOwnershipSchema(
        database as unknown as WorkspaceOwnershipDatabase,
        config.type,
        tables,
      );

      expect(workspaceOwnershipSchemaPrepared(statuses)).toBe(true);
      expect(statuses).toContainEqual(
        expect.objectContaining({
          addedColumns: ['tenant_id', 'owner_user_id'],
          table: 'candidate_profiles',
        }),
      );
      expect(statuses).toContainEqual(
        expect.objectContaining({
          addedColumns: ['tenant_id', 'owner_user_id', 'candidate_profile_id'],
          table: 'applications',
        }),
      );
      if (config.type === 'postgres') {
        const nullable = await database.query(
          "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'applications' AND table_schema = current_schema() AND column_name = 'candidate_profile_id'",
        );
        expect(nullable.rows).toEqual([{ is_nullable: 'YES' }]);
      } else {
        const columns = await database.query('PRAGMA table_info(applications)');
        expect(columns.rows).toContainEqual(
          expect.objectContaining({ name: 'candidate_profile_id', notnull: 0 }),
        );
      }
      if (
        config.type === 'postgres' &&
        !new URL(config.url).pathname.includes('public_disposable_tests')
      ) {
        throw new Error(
          'PostgreSQL ownership fixture requires the dedicated disposable test database.',
        );
      }
      await setup(database, config.type);
    });

    it('reports a newly introduced ownership table as a native empty-table requirement', async () => {
      const statuses = await prepareWorkspaceOwnershipSchema(
        database as unknown as WorkspaceOwnershipDatabase,
        config.type,
        ['opportunity_assessments'],
      );

      expect(statuses).toEqual([
        expect.objectContaining({
          addedColumns: [],
          needsNativeCreate: true,
          table: 'opportunity_assessments',
          tablePresent: false,
        }),
      ]);
      expect(workspaceOwnershipSchemaPrepared(statuses)).toBe(false);
    });

    it('binds only the explicit canonical tuple and preserves historical target identifiers', async () => {
      await database.query(
        "INSERT INTO candidate_profiles (id, tenant_id, owner_user_id) VALUES ('profile-1', '', '')",
      );
      await database.query(
        "INSERT INTO applications (id, tenant_id, owner_user_id, candidate_profile_id, immutable_history_target_id) VALUES ('application-1', '', '', '', 'retired-opportunity')",
      );
      const options = { binding, dialect: config.type, tables };
      const preview = await planWorkspaceOwnershipBackfill(
        database as unknown as WorkspaceOwnershipDatabase,
        options,
      );
      expect(preview).toMatchObject({
        eligible: true,
        profileCardinalityValid: true,
        tables: [
          { conflicts: 0, table: 'candidate_profiles', toBind: 1 },
          { conflicts: 0, table: 'applications', toBind: 1 },
        ],
      });
      await applyWorkspaceOwnershipBackfill(
        database as unknown as WorkspaceOwnershipDatabase,
        { ...options, expectedDigest: preview.digest },
      );
      const result = await database.query(
        'SELECT tenant_id, owner_user_id, candidate_profile_id, immutable_history_target_id FROM applications',
      );
      expect(result.rows).toEqual([
        {
          candidate_profile_id: 'profile-1',
          immutable_history_target_id: 'retired-opportunity',
          owner_user_id: 'user-1',
          tenant_id: 'tenant-1',
        },
      ]);
    });

    it('refuses an ambiguous profile set before beginning any writes', async () => {
      await database.query(
        "INSERT INTO candidate_profiles (id, tenant_id, owner_user_id) VALUES ('profile-1', '', ''), ('profile-2', '', '')",
      );
      const preview = await planWorkspaceOwnershipBackfill(
        database as unknown as WorkspaceOwnershipDatabase,
        { binding, dialect: config.type, tables },
      );
      expect(preview.eligible).toBe(false);
      expect(preview.profileCardinalityValid).toBe(false);
      await expect(
        applyWorkspaceOwnershipBackfill(
          database as unknown as WorkspaceOwnershipDatabase,
          {
            binding,
            dialect: config.type,
            expectedDigest: preview.digest,
            tables,
          },
        ),
      ).rejects.toThrow('ambiguous profiles');
      const rows = await database.query(
        'SELECT tenant_id, owner_user_id FROM candidate_profiles ORDER BY id',
      );
      expect(rows.rows).toEqual([
        { owner_user_id: '', tenant_id: '' },
        { owner_user_id: '', tenant_id: '' },
      ]);
    });

    it('rejects foreign and partially bound tuples without touching their rows', async () => {
      await database.query(
        "INSERT INTO candidate_profiles (id, tenant_id, owner_user_id) VALUES ('profile-1', '', '')",
      );
      await database.query(
        "INSERT INTO applications (id, tenant_id, owner_user_id, candidate_profile_id) VALUES ('foreign', 'tenant-other', 'user-other', 'profile-other'), ('partial', 'tenant-1', '', '')",
      );
      const options = { binding, dialect: config.type, tables };
      const preview = await planWorkspaceOwnershipBackfill(
        database as unknown as WorkspaceOwnershipDatabase,
        options,
      );

      expect(preview.eligible).toBe(false);
      expect(preview.tables).toContainEqual(
        expect.objectContaining({
          conflicts: 2,
          table: 'applications',
          toBind: 0,
        }),
      );
      await expect(
        applyWorkspaceOwnershipBackfill(
          database as unknown as WorkspaceOwnershipDatabase,
          { ...options, expectedDigest: preview.digest },
        ),
      ).rejects.toThrow('conflicts');
      const rows = await database.query(
        'SELECT id, tenant_id, owner_user_id, candidate_profile_id FROM applications ORDER BY id',
      );
      expect(rows.rows).toEqual([
        {
          candidate_profile_id: 'profile-other',
          id: 'foreign',
          owner_user_id: 'user-other',
          tenant_id: 'tenant-other',
        },
        {
          candidate_profile_id: '',
          id: 'partial',
          owner_user_id: '',
          tenant_id: 'tenant-1',
        },
      ]);
    });

    it('pins apply to the reviewed row set and rolls back a changed plan', async () => {
      await database.query(
        "INSERT INTO candidate_profiles (id, tenant_id, owner_user_id) VALUES ('profile-1', '', '')",
      );
      const options = { binding, dialect: config.type, tables };
      const preview = await planWorkspaceOwnershipBackfill(
        database as unknown as WorkspaceOwnershipDatabase,
        options,
      );
      await database.query(
        "INSERT INTO applications (id, tenant_id, owner_user_id, candidate_profile_id) VALUES ('late-row', '', '', '')",
      );
      await expect(
        applyWorkspaceOwnershipBackfill(
          database as unknown as WorkspaceOwnershipDatabase,
          { ...options, expectedDigest: preview.digest },
        ),
      ).rejects.toThrow('plan changed');
      const rows = await database.query(
        "SELECT tenant_id, owner_user_id, candidate_profile_id FROM applications WHERE id = 'late-row'",
      );
      expect(rows.rows).toEqual([
        { candidate_profile_id: '', owner_user_id: '', tenant_id: '' },
      ]);
    });

    it.skipIf(config.type !== 'postgres')(
      'uses a native UUID primary-key predicate for PostgreSQL CAS writes',
      async () => {
        await database.query('DROP TABLE IF EXISTS uuid_private_records');
        await database.query(`CREATE TABLE uuid_private_records (
          id UUID PRIMARY KEY, tenant_id TEXT, owner_user_id TEXT,
          candidate_profile_id TEXT
        )`);
        await database.query(
          "INSERT INTO candidate_profiles (id, tenant_id, owner_user_id) VALUES ('profile-1', '', '')",
        );
        await database.query(
          "INSERT INTO uuid_private_records (id, tenant_id, owner_user_id, candidate_profile_id) VALUES ('00000000-0000-0000-0000-000000000001', '', '', '')",
        );
        const options = {
          binding,
          dialect: config.type,
          tables: ['candidate_profiles', 'uuid_private_records'],
        } as const;
        const preview = await planWorkspaceOwnershipBackfill(
          database as unknown as WorkspaceOwnershipDatabase,
          options,
        );
        await applyWorkspaceOwnershipBackfill(
          database as unknown as WorkspaceOwnershipDatabase,
          { ...options, expectedDigest: preview.digest },
        );
        const rows = await database.query(
          'SELECT tenant_id, owner_user_id, candidate_profile_id FROM uuid_private_records',
        );
        expect(rows.rows).toEqual([
          {
            candidate_profile_id: 'profile-1',
            owner_user_id: 'user-1',
            tenant_id: 'tenant-1',
          },
        ]);
        await database.query('DROP TABLE uuid_private_records');
      },
    );
  });
}

runSuite('workspace ownership backfill on SQLite', {
  type: 'sqlite',
  url: ':memory:',
});
if (postgresUrl) {
  runSuite('workspace ownership backfill on disposable PostgreSQL', {
    type: 'postgres',
    url: postgresUrl,
  });
}
