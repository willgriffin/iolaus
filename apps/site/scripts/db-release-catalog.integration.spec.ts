import { randomUUID } from 'node:crypto';
import { getDatabase, type DatabaseInterface } from '@happyvertical/sql';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { executeReleaseCatalog } from './db-release-executor.js';
import { releaseCatalog } from './db-release-catalog.js';
import {
  finalizeReleaseIntegrity,
  prepareReleaseSchema,
  verifyReleaseIntegrity,
} from './db-release-schema.js';
import { withSmrtDatabaseMigrationLock } from './db-common.js';
import { readApplicationDeploymentSchemas } from '../src/lib/server/deployment/static-schemas.js';
import {
  assertDeploymentSchemaReady,
  assertRuntimeStaticAgreement,
} from '../../../scripts/smrt-deployment-schema.mjs';
import { ObjectRegistry } from '@happyvertical/smrt-core';

// Isolate unrelated provider services; the production startup callback and real
// PostgreSQL connection/role/schema checks execute unchanged.
vi.mock('@happyvertical/smrt-app-runtime', async (load) => ({
  ...(await load<typeof import('@happyvertical/smrt-app-runtime')>()),
  initializeDeployedApplicationRuntime: async (options: {
    database: {
      connect: () => Promise<DatabaseInterface>;
      close: (db: DatabaseInterface) => Promise<void>;
    };
  }) => {
    const db = await options.database.connect();
    await options.database.close(db);
    return {};
  },
}));

const fixtureUrl = process.env.IOLAUS_RELEASE_TEST_DATABASE_URL;
const originalEnvironment = vi.hoisted(() => {
  const saved = {
    profile: process.env.SMRT_RUNTIME_PROFILE,
    app: process.env.SMRT_APP_ID,
    auth: Object.fromEntries(
      [
        'IOLAUS_AUTH_MODE',
        'IOLAUS_WORKSPACE_MODE',
        'IOLAUS_PUBLIC_URL',
        'IOLAUS_MAGIC_LINK_SECRET',
        'SMTP_HOST',
        'SMTP_USER',
        'SMTP_PASSWORD',
        'SMTP_FROM',
        'ADDRESS_HEADER',
      ].map((key) => [key, process.env[key]]),
    ),
  };
  if (process.env.IOLAUS_RELEASE_TEST_DATABASE_URL) {
    process.env.SMRT_RUNTIME_PROFILE = 'self-hosted';
    process.env.SMRT_APP_ID = 'adoption';
    Object.assign(process.env, {
      IOLAUS_AUTH_MODE: 'magic-link',
      IOLAUS_WORKSPACE_MODE: 'shared',
      IOLAUS_PUBLIC_URL: 'https://fixture.example.invalid',
      IOLAUS_MAGIC_LINK_SECRET: 'f'.repeat(64),
      SMTP_HOST: 'mail.example.invalid',
      SMTP_USER: 'fixture',
      SMTP_PASSWORD: 'fixture-only',
      SMTP_FROM: 'fixture@example.invalid',
      ADDRESS_HEADER: 'x-forwarded-for',
    });
  }
  return saved;
});
afterAll(() => {
  for (const [key, value] of Object.entries(originalEnvironment.auth)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalEnvironment.profile === undefined)
    delete process.env.SMRT_RUNTIME_PROFILE;
  else process.env.SMRT_RUNTIME_PROFILE = originalEnvironment.profile;
  if (originalEnvironment.app === undefined) delete process.env.SMRT_APP_ID;
  else process.env.SMRT_APP_ID = originalEnvironment.app;
});
const suite = fixtureUrl ? describe : describe.skip;
suite('real application release catalog', () => {
  it('bootstraps and replays durable phases, preserves the sentinel and legacy owner startup, and attests strict runtime schema semantics', async () => {
    if (!fixtureUrl) throw new Error('Isolated fixture required.');
    const previousUrl = process.env.DATABASE_URL;
    const previousApp = process.env.SMRT_APP_ID;
    const admin = await getDatabase({ type: 'postgres', url: fixtureUrl });
    const name = `adoption_catalog_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(fixtureUrl);
    url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE ${name}`);
    process.env.DATABASE_URL = url.href;
    process.env.SMRT_APP_ID = 'adoption';
    const database = await getDatabase({
      type: 'postgres',
      url: url.href,
      max: 8,
    });
    try {
      const checkSafety = async () => {
        assertRuntimeStaticAgreement(
          ObjectRegistry.getAllSchemasAsDefinitions(),
          await readApplicationDeploymentSchemas(),
        );
      };
      for (let pass = 0; pass < 2; pass++) {
        await withSmrtDatabaseMigrationLock(async () => {
          await prepareReleaseSchema(database, checkSafety);
          const records = await executeReleaseCatalog({
            database,
            application: 'iolaus',
            environment: name,
            checkSafety,
            steps: releaseCatalog(database),
          });
          expect(records.every((record) => record.status === 'complete')).toBe(
            true,
          );
          await finalizeReleaseIntegrity(database, checkSafety);
          await assertDeploymentSchemaReady(
            database,
            Object.values(ObjectRegistry.getAllSchemasAsDefinitions()),
          );
          await verifyReleaseIntegrity(database);
        }, database);
        if (pass === 0) {
          await database.query(
            'CREATE TABLE release_sentinel (value TEXT NOT NULL)',
          );
          await database.query(
            "INSERT INTO release_sentinel VALUES ('retained')",
          );
        }
      }
      expect(
        (await database.query('SELECT value FROM release_sentinel')).rows,
      ).toEqual([{ value: 'retained' }]);
      const previousProtocol = process.env.IOLAUS_DEPLOYMENT_PROTOCOL;
      const role = `runtime_${randomUUID().replaceAll('-', '')}`;
      const password = randomUUID().replaceAll('-', '');
      await database.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await database.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await database.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      );
      const runtimeUrl = new URL(url);
      runtimeUrl.username = role;
      runtimeUrl.password = password;
      const runtimeDb = await getDatabase({
        type: 'postgres',
        url: runtimeUrl.href,
      });
      try {
        const { ensureApplicationRuntimeReady } = await import(
          '../src/lib/server/application-runtime.js'
        );
        const { assertDeployedSchemaReady } = await import(
          '../src/lib/server/deployment/schema.js'
        );
        const { ensureSourceScheduleTable } = await import(
          '../src/lib/server/source-schedules.js'
        );
        process.env.IOLAUS_DEPLOYMENT_PROTOCOL = 'smrt-release-v1';
        // The actual web startup connection callback refuses the legacy owner.
        await expect(ensureApplicationRuntimeReady()).rejects.toThrow(
          /denied DDL/,
        );
        await assertDeployedSchemaReady(runtimeDb);
        const foreignKey = 'profiles_type_id_profile_types_id_fkey';
        await database.query(
          `ALTER TABLE profiles DROP CONSTRAINT ${foreignKey}`,
        );
        await expect(assertDeployedSchemaReady(runtimeDb)).rejects.toThrow(
          /foreign key/,
        );
        await database.query(
          `ALTER TABLE profiles ADD CONSTRAINT ${foreignKey} FOREIGN KEY(type_id) REFERENCES profile_types(id) ON DELETE CASCADE ON UPDATE CASCADE`,
        );
        await expect(assertDeployedSchemaReady(runtimeDb)).rejects.toThrow(
          /foreign key/,
        );
        await database.query(
          `ALTER TABLE profiles DROP CONSTRAINT ${foreignKey}`,
        );
        await database.query(
          `ALTER TABLE profiles ADD CONSTRAINT ${foreignKey} FOREIGN KEY(type_id) REFERENCES profile_types(id) ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID`,
        );
        await expect(assertDeployedSchemaReady(runtimeDb)).rejects.toThrow(
          /foreign key/,
        );
        await database.query(
          `ALTER TABLE profiles VALIDATE CONSTRAINT ${foreignKey}`,
        );
        await database.query('DROP INDEX profiles_email_key_idx');
        await expect(assertDeployedSchemaReady(runtimeDb)).rejects.toThrow(
          /profiles_email_key_idx/,
        );
        await database.query(
          'CREATE INDEX profiles_email_key_idx ON profiles(email_key)',
        );
        await database.query('DROP INDEX profiles_slug_context_meta_type_idx');
        await database.query(
          'CREATE UNIQUE INDEX profiles_slug_context_meta_type_idx ON profiles(tenant_id,slug,context,_meta_type)',
        );
        await expect(assertDeployedSchemaReady(runtimeDb)).rejects.toThrow(
          /profiles_slug_context_meta_type_idx/,
        );
        await database.query('DROP INDEX profiles_slug_context_meta_type_idx');
        await database.query(
          'CREATE UNIQUE INDEX profiles_slug_context_meta_type_idx ON profiles(tenant_id,slug,context,_meta_type) NULLS NOT DISTINCT',
        );
        await database.query('DROP INDEX _smrt_jobs_ready_idx');
        await database.query(
          "CREATE INDEX _smrt_jobs_ready_idx ON _smrt_jobs(status,run_at) WHERE status='pending'",
        );
        await expect(assertDeployedSchemaReady(runtimeDb)).rejects.toThrow(
          /_smrt_jobs_ready_idx/,
        );
        await database.query('DROP INDEX _smrt_jobs_ready_idx');
        await database.query(
          "CREATE INDEX _smrt_jobs_ready_idx ON _smrt_jobs(status,run_at) WHERE status='pending' AND (task_input_requests IS NULL OR task_input_responses IS NOT NULL)",
        );
        await assertDeployedSchemaReady(runtimeDb);
        process.env.DATABASE_URL = runtimeUrl.href;
        await database.query('DROP TABLE _smrt_job_events');
        await expect(ensureApplicationRuntimeReady()).rejects.toThrow(
          /_smrt_job_events/,
        );
        // No protocol retains the actual legacy web connection and task ensure.
        delete process.env.IOLAUS_DEPLOYMENT_PROTOCOL;
        process.env.DATABASE_URL = url.href;
        await ensureApplicationRuntimeReady();
        await ensureSourceScheduleTable(database);
        process.env.IOLAUS_DEPLOYMENT_PROTOCOL = '';
        await expect(ensureApplicationRuntimeReady()).rejects.toThrow(
          /IOLAUS_DEPLOYMENT_PROTOCOL/,
        );
      } finally {
        if (previousProtocol === undefined)
          delete process.env.IOLAUS_DEPLOYMENT_PROTOCOL;
        else process.env.IOLAUS_DEPLOYMENT_PROTOCOL = previousProtocol;
        process.env.DATABASE_URL = url.href;
        await runtimeDb.close?.();
        await database.query(`DROP OWNED BY ${role}`);
        await database.query(`DROP ROLE ${role}`);
      }
    } catch (error) {
      console.error(
        'Fixture ledger outcomes:',
        (
          await database.query(
            'SELECT step_id, status, checkpoint FROM _smrt_deployment_steps',
          )
        ).rows,
      );
      throw error;
    } finally {
      process.env.DATABASE_URL = previousUrl;
      process.env.SMRT_APP_ID = previousApp;
      await database.close?.();
      // Root adapter cache used by public collections may hold additional
      // clients until their idle expiry. Only our synthetic database is closed.
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close?.();
    }
  }, 120_000);
});
