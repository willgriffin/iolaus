import { randomUUID } from 'node:crypto';
import { getDatabase, type DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import type { DeploymentStepTransaction } from '@happyvertical/smrt-core/migrations';
import {
  executeReleaseCatalog,
  type ReleaseStep,
} from './db-release-executor.js';
import {
  assertDeploymentSchemaReady,
  assertRuntimeDatabaseRole,
} from '../../../scripts/smrt-deployment-schema.mjs';

const fixtureUrl = process.env.IOLAUS_RELEASE_TEST_DATABASE_URL;
const suite = fixtureUrl ? describe : describe.skip;
suite('release executor on isolated real PostgreSQL', () => {
  async function fixture(work: (db: DatabaseInterface) => Promise<void>) {
    if (!fixtureUrl) throw new Error('Isolated fixture URL is required.');
    const admin = await getDatabase({ type: 'postgres', url: fixtureUrl });
    const schema = `release_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scopedUrl = new URL(fixtureUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schema}`);
    const db = await getDatabase({
      type: 'postgres',
      url: scopedUrl.href,
      max: 8,
    });
    try {
      await db.query(
        'CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)',
      );
      await db.query('INSERT INTO sentinel VALUES (1, 10)');
      await work(db);
    } finally {
      await db.close?.();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close?.();
    }
  }
  function execute(
    db: DatabaseInterface,
    steps: ReleaseStep[],
    checkSafety = async () => {},
  ) {
    return executeReleaseCatalog({
      database: db,
      application: 'iolaus-test',
      environment: 'isolated',
      checkSafety,
      steps,
    });
  }
  const increment = (id: string): ReleaseStep => ({
    id,
    specification: 'increment sentinel v1',
    mode: 'transactional',
    apply: async (tx) => {
      await tx.query('UPDATE sentinel SET value = value + 1 WHERE id = 1');
    },
  });

  it('keeps writes and marker atomic on rollback and uses one backend', async () =>
    fixture(async (db) => {
      let backend: unknown;
      await expect(
        execute(db, [
          {
            ...increment('rollback'),
            apply: async (tx: DeploymentStepTransaction) => {
              backend = (await tx.query('SELECT pg_backend_pid() AS pid'))
                .rows[0]?.pid;
              expect(Object.keys(tx)).toEqual(['query']);
              await tx.query('UPDATE sentinel SET value = 99 WHERE id = 1');
              throw new Error('synthetic interruption');
            },
          },
        ]),
      ).rejects.toThrow('synthetic interruption');
      expect(backend).toBeTruthy();
      expect((await db.query('SELECT value FROM sentinel')).rows[0].value).toBe(
        10,
      );
      expect(
        (await db.query('SELECT 1 FROM _smrt_deployment_steps')).rows,
      ).toHaveLength(0);
    }));
  it('refuses before ledger initialization or data mutation when safety fails', async () =>
    fixture(async (db) => {
      await expect(
        execute(db, [increment('guard')], async () => {
          throw new Error('writer still present');
        }),
      ).rejects.toThrow('writer still present');
      expect(
        (
          await db.query(
            "SELECT to_regclass('_smrt_deployment_steps') AS relation",
          )
        ).rows[0].relation,
      ).toBeNull();
      expect((await db.query('SELECT value FROM sentinel')).rows[0].value).toBe(
        10,
      );
    }));
  it('serializes concurrent migrators, rechecks completed steps and rejects changed checksum', async () =>
    fixture(async (db) => {
      let safetyCalls = 0;
      const safety = async () => {
        safetyCalls++;
      };
      await Promise.all([
        execute(db, [increment('concurrent')], safety),
        execute(db, [increment('concurrent')], safety),
      ]);
      expect((await db.query('SELECT value FROM sentinel')).rows[0].value).toBe(
        11,
      );
      expect(safetyCalls).toBe(3);
      await expect(
        execute(db, [increment('concurrent')], async () => {
          throw new Error('fresh refusal');
        }),
      ).rejects.toThrow('fresh refusal');
      await expect(
        execute(db, [{ ...increment('concurrent'), specification: 'changed' }]),
      ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    }));
  it('recovers a lost COMMIT acknowledgement by observing the durable marker', async () =>
    fixture(async (db) => {
      // Public adapter test instrumentation only: the real server COMMIT happens,
      // then the transport acknowledgement is lost. No application pool shim.
      let loseAcknowledgement = true;
      const transport: DatabaseInterface = {
        ...db,
        acquireSession: async () => {
          if (!db.acquireSession)
            throw new Error('Pinned sessions unavailable.');
          const session = await db.acquireSession();
          return {
            ...session,
            query: async (sql, ...params) => {
              const result = await session.query(sql, ...params);
              if (sql === 'COMMIT' && loseAcknowledgement) {
                loseAcknowledgement = false;
                throw new Error('synthetic lost acknowledgement');
              }
              return result;
            },
          };
        },
      };
      await expect(
        execute(transport, [increment('lost-commit')]),
      ).rejects.toThrow('synthetic lost acknowledgement');
      await execute(db, [increment('lost-commit')]);
      expect((await db.query('SELECT value FROM sentinel')).rows[0].value).toBe(
        11,
      );
      expect(
        (
          await db.query(
            "SELECT status FROM _smrt_deployment_steps WHERE step_id = 'lost-commit'",
          )
        ).rows[0].status,
      ).toBe('complete');
    }));
  it('marks ambiguous interrupted reconciled work needs-repair without replay', async () =>
    fixture(async (db) => {
      let applied = false;
      const step: ReleaseStep = {
        id: 'uncertain',
        specification: 'inspect real sentinel state v1',
        mode: 'reconciled',
        inspect: async (context) => ({
          outcome:
            Number(
              (await context.query('SELECT value FROM sentinel')).rows[0].value,
            ) === 10
              ? 'safe-to-resume'
              : 'needs-repair',
        }),
        apply: async (context) => {
          applied = true;
          await context.query('UPDATE sentinel SET value = 20');
          throw new Error('interrupted external batch');
        },
      };
      await expect(execute(db, [step])).rejects.toThrow(
        'interrupted external batch',
      );
      expect(applied).toBe(true);
      applied = false;
      await expect(execute(db, [step])).rejects.toMatchObject({
        code: 'NEEDS_REPAIR',
      });
      expect(applied).toBe(false);
      expect(
        (await db.query('SELECT status FROM _smrt_deployment_steps')).rows[0]
          .status,
      ).toBe('needs-repair');
    }));
  it('starts under a runtime role denied DDL, allows queue writes after readiness, and refuses each missing queue table', async () =>
    fixture(async (db) => {
      const role = `runtime_${randomUUID().replaceAll('-', '')}`;
      const schema = String(
        (await db.query('SELECT current_schema() AS name')).rows[0].name,
      );
      await db.query(`CREATE ROLE ${role} NOLOGIN`);
      const required = [
        '_smrt_migrations',
        '_smrt_agent_schedules',
        '_smrt_jobs',
        '_smrt_job_events',
      ];
      for (const table of required)
        await db.query(`CREATE TABLE ${table} (id INTEGER)`);
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await db.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
      );
      if (!db.acquireSession) throw new Error('Pinned sessions unavailable.');
      const session = await db.acquireSession();
      try {
        await session.query(`SET ROLE ${role}`);
        await assertRuntimeDatabaseRole(session);
        const schemas = [
          {
            tableName: 'sentinel',
            columns: {
              id: { type: 'INTEGER', notNull: true },
              value: { type: 'INTEGER', notNull: true },
            },
          },
        ];
        await assertDeploymentSchemaReady(session, schemas);
        await session.query('UPDATE sentinel SET value = value + 1');
        await expect(
          session.query('CREATE TABLE forbidden (id INTEGER)'),
        ).rejects.toThrow(/permission denied/);
        for (const table of required) {
          await db.query(`DROP TABLE ${table}`);
          await expect(
            assertDeploymentSchemaReady(session, schemas),
          ).rejects.toThrow(table);
          await db.query(`CREATE TABLE ${table} (id INTEGER)`);
          await db.query(`GRANT SELECT ON ${table} TO ${role}`);
        }
        await session.query('RESET ROLE');
      } finally {
        await session.release();
        await db.query(`DROP OWNED BY ${role}`);
        await db.query(`DROP ROLE ${role}`);
      }
    }));
  it('keeps a restricted monitor readable and unable to write or issue DDL', async () =>
    fixture(async (db) => {
      const role = `monitor_${randomUUID().replaceAll('-', '')}`;
      const schema = String(
        (await db.query('SELECT current_schema() AS name')).rows[0].name,
      );
      await db.query(`CREATE ROLE ${role} NOLOGIN`);
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await db.query(`GRANT SELECT ON sentinel TO ${role}`);
      if (!db.acquireSession) throw new Error('Pinned sessions unavailable.');
      const session = await db.acquireSession();
      try {
        await session.query(`SET ROLE ${role}`);
        await assertRuntimeDatabaseRole(session);
        expect(
          (await session.query('SELECT value FROM sentinel')).rows[0].value,
        ).toBe(10);
        await expect(
          session.query('UPDATE sentinel SET value = 20'),
        ).rejects.toThrow(/permission denied/);
        await expect(
          session.query('ALTER TABLE sentinel ADD COLUMN forbidden TEXT'),
        ).rejects.toThrow(/must be owner/);
        await session.query('RESET ROLE');
      } finally {
        await session.release();
        await db.query(`DROP OWNED BY ${role}`);
        await db.query(`DROP ROLE ${role}`);
      }
    }));
});
