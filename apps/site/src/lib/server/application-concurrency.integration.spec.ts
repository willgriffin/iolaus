import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Application } from '../objects/Application.js';
import { clearApplicationApprovalFields } from '../objects/application-approval-scope.js';
import { ResumeVariant } from '../objects/ResumeVariant.js';
import { commitApplicationIfCurrent } from './application-concurrency.js';
import {
  runOpportunityLifecycleTransaction,
  withOpportunityLifecycleLock,
} from './application-workflow.js';
import { commitResumeVariantIfCurrent } from './resume-variant-concurrency.js';
import './smrt.js';

// Only configuration is substituted: all reads, writes, locks, and transactions
// below use the production SQL adapter and production lifecycle executor.
const fixture = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock('./db.js', () => ({
  getDbConfig: () => fixture.config,
  getSmrtOptions: () => ({ db: fixture.config }),
}));

const materialOld = randomUUID();
const materialNew = randomUUID();
const reviewerId = randomUUID();
const postgresUrl = process.env.APPLICATION_CAS_TEST_POSTGRES_URL?.trim();
for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !postgresUrl)(
    `application material/approval CAS on native ${dialect}`,
    () => {
      let database: DatabaseInterface;
      let control: DatabaseInterface | undefined;
      let directory: string | undefined;
      let schema: string | undefined;

      beforeAll(async () => {
        if (dialect === 'postgres') {
          if (!postgresUrl) throw new Error('Missing PostgreSQL fixture URL.');
          const url = new URL(postgresUrl);
          if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
            throw new Error(
              'CAS fixtures require a local disposable PostgreSQL database.',
            );
          schema = `application_cas_${randomUUID().replaceAll('-', '')}`;
          control = await getDatabase({
            type: 'postgres',
            url: postgresUrl,
            cache: false,
          });
          await control.query(`CREATE SCHEMA "${schema}"`);
          url.searchParams.set('options', `-c search_path=${schema},public`);
          fixture.config = { type: dialect, url: url.toString(), dbid: schema };
        } else {
          directory = await mkdtemp(join(tmpdir(), 'application-cas-'));
          fixture.config = {
            type: dialect,
            url: join(directory, 'cas.sqlite'),
            dbid: randomUUID(),
          };
        }
        database = await getDatabase(fixture.config as never);
        const ddl = getDDLStrategy(dialect);
        for (const tableName of ['applications', 'resume_variants']) {
          const definition = Object.values(
            ObjectRegistry.getAllSchemasAsDefinitions(),
          ).find((entry) => entry.tableName === tableName);
          if (!definition)
            throw new Error(`Missing native schema for ${tableName}`);
          await database.query(ddl.generateCreateTable(definition));
        }
      }, 20_000);

      afterAll(async () => {
        await database?.close?.();
        if (control && schema)
          await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await control?.close?.();
        if (directory) await rm(directory, { recursive: true, force: true });
      });

      async function seed() {
        const id = randomUUID();
        // Persist model defaults, then hydrate through the real SMRT formatter.
        const values: Record<string, unknown> = {
          id,
          slug: id,
          context: '',
          created_at: new Date(),
          updated_at: new Date(),
          status: 'awaiting_user',
        };
        const fields = ObjectRegistry.getAllSchemasAsDefinitions();
        const definition = Object.values(fields).find(
          (entry) => entry.tableName === 'applications',
        );
        if (!definition) throw new Error('Missing Application schema.');
        for (const [name, column] of Object.entries(definition.columns)) {
          if (!(name in values) && column.type === 'TEXT') values[name] = '';
          if (!(name in values) && column.type === 'UUID' && column.notNull)
            values[name] = randomUUID();
        }
        values.resume_asset_id = materialOld;
        await database.insert('applications', values);
        return id;
      }

      async function hydrate(id: string) {
        const record = new Application({ db: database });
        const result = await database.query(
          'SELECT * FROM applications WHERE id = ?',
          id,
        );
        await record.loadDataFromDb(result.rows[0]);
        return record as unknown as Record<string, unknown>;
      }

      async function inMaterialTransaction<T>(
        id: string,
        action: (db: DatabaseInterface) => Promise<T>,
      ) {
        return (await withOpportunityLifecycleLock(
          id,
          async () => await runOpportunityLifecycleTransaction(action as never),
        )) as T;
      }

      it('allows exactly one competing material/approval commit and never approves a losing material snapshot', async () => {
        const id = await seed();
        const material = await hydrate(id);
        const approval = await hydrate(id);
        const invalidation: Record<string, unknown> = {
          resumeAssetId: materialNew,
          status: 'awaiting_user',
        };
        clearApplicationApprovalFields(invalidation);
        const results = await Promise.all([
          commitApplicationIfCurrent(material, invalidation, database),
          commitApplicationIfCurrent(
            approval,
            {
              finalApprovalKind: 'final_submission',
              finalApprovalAt: new Date(),
              finalApprovalMaterialsJson: JSON.stringify([materialOld]),
              finalApprovedByUserId: reviewerId,
              status: 'approved',
            },
            database,
          ),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const stored = await hydrate(id);
        if (results[0])
          expect(stored).toMatchObject({
            resumeAssetId: materialNew,
            finalApprovalKind: '',
            status: 'awaiting_user',
          });
        else
          expect(stored).toMatchObject({
            resumeAssetId: materialOld,
            finalApprovalKind: 'final_submission',
            status: 'approved',
          });
      });

      it('rejects a stale hydrated approval/edit after a material reservation without restoring old fields', async () => {
        const id = await seed();
        const stale = await hydrate(id);
        const current = await hydrate(id);
        expect(
          await commitApplicationIfCurrent(
            current,
            {
              materialWriteLock: 'material-writer',
              resumeAssetId: materialNew,
            },
            database,
          ),
        ).toBe(true);
        expect(
          await commitApplicationIfCurrent(
            stale,
            { status: 'approved', finalApprovalKind: 'final_submission' },
            database,
          ),
        ).toBe(false);
        expect(
          await commitApplicationIfCurrent(
            stale,
            { notes: 'stale hydrated admin edit' },
            database,
          ),
        ).toBe(false);
        expect(stale.status).toBe('awaiting_user');
        expect(await hydrate(id)).toMatchObject({
          materialWriteLock: 'material-writer',
          resumeAssetId: materialNew,
          finalApprovalKind: '',
          notes: '',
        });
      });

      it('commits a fresh hydrated write and reuses the same executor for nested lifecycle work', async () => {
        const id = await seed();
        const application = await hydrate(id);
        await inMaterialTransaction(id, async (transaction) => {
          await runOpportunityLifecycleTransaction(async (nested) => {
            expect(nested).toBe(transaction);
            expect(
              await commitApplicationIfCurrent(
                application,
                { resumeAssetId: materialNew },
                nested,
              ),
            ).toBe(true);
          });
        });
        expect(await hydrate(id)).toMatchObject({
          resumeAssetId: materialNew,
          status: 'awaiting_user',
        });
      });

      it('rolls back a successful material CAS when the application CAS loses inside the lifecycle executor', async () => {
        const id = await seed();
        const stale = await hydrate(id);
        const current = await hydrate(id);
        expect(
          await commitApplicationIfCurrent(
            current,
            { resumeAssetId: materialNew },
            database,
          ),
        ).toBe(true);
        const variantId = randomUUID();
        const revision = new Date('2026-10-01T00:00:00.000Z');
        await database.insert('resume_variants', {
          id: variantId,
          slug: variantId,
          context: '',
          created_at: revision,
          updated_at: revision,
          tenant_id: randomUUID(),
          owner_user_id: randomUUID(),
          candidate_profile_id: randomUUID(),
          status: 'draft',
          resume_asset_id: materialOld,
        });
        const variant = new ResumeVariant({ db: database });
        await variant.loadDataFromDb(
          (
            await database.query(
              'SELECT * FROM resume_variants WHERE id = ?',
              variantId,
            )
          ).rows[0],
        );
        const persisted = {
          id: variant.id,
          resumeAssetId: variant.resumeAssetId,
          updated_at: revision,
        };
        await expect(
          inMaterialTransaction(id, async (transaction) => {
            expect(transaction).not.toBe(database);
            expect(
              await commitResumeVariantIfCurrent(
                persisted,
                { id: variant.id, resumeAssetId: materialNew },
                transaction,
              ),
            ).toBe(true);
            if (
              !(await commitApplicationIfCurrent(
                stale,
                { resumeAssetId: materialNew },
                transaction,
              ))
            )
              throw new Error('stale application');
          }),
        ).rejects.toThrow('stale application');
        expect(
          (
            await database.query(
              'SELECT resume_asset_id FROM resume_variants WHERE id = ?',
              variantId,
            )
          ).rows[0],
        ).toMatchObject({ resume_asset_id: materialOld });
        expect(await hydrate(id)).toMatchObject({
          resumeAssetId: materialNew,
          finalApprovalKind: '',
        });
      });
    },
  );
}
