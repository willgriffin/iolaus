import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
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

const fixtureUrl = process.env.IOLAUS_RELEASE_TEST_DATABASE_URL;
const originalEnvironment = vi.hoisted(() => {
  const saved = {
    profile: process.env.SMRT_RUNTIME_PROFILE,
    app: process.env.SMRT_APP_ID,
  };
  if (process.env.IOLAUS_RELEASE_TEST_DATABASE_URL) {
    process.env.SMRT_RUNTIME_PROFILE = 'self-hosted';
    process.env.SMRT_APP_ID = 'adoption';
  }
  return saved;
});
afterAll(() => {
  if (originalEnvironment.profile === undefined)
    delete process.env.SMRT_RUNTIME_PROFILE;
  else process.env.SMRT_RUNTIME_PROFILE = originalEnvironment.profile;
  if (originalEnvironment.app === undefined) delete process.env.SMRT_APP_ID;
  else process.env.SMRT_APP_ID = originalEnvironment.app;
});
const suite = fixtureUrl ? describe : describe.skip;
suite('real application release catalog', () => {
  it('bootstraps a fresh database and verifies all durable phases twice while retaining a sentinel', async () => {
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
