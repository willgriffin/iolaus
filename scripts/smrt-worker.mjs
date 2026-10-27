#!/usr/bin/env node

import { join } from 'node:path';
import { initializeDeployedApplicationRuntime } from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import {
  assertDeploymentSchemaReady,
  assertDeploymentCatalogReady,
  assertRuntimeDatabaseRole,
  readDeploymentSchemas,
  releaseDeploymentProtocolEnabled,
} from './smrt-deployment-schema.mjs';
import { startWorkerHeartbeat } from './smrt-worker-heartbeat.mjs';
import { createProviderReadinessProbe } from './smrt-provider-readiness.mjs';

process.chdir(join(process.cwd(), 'apps', 'site'));

await loadConfig({ cache: false });
const configured = resolveConfiguredApplicationRuntime();
if (configured.profile === 'local') {
  throw new Error(
    'Local jobs run inline or embedded; a separate worker requires self-hosted or cloud.',
  );
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const releaseProtocol = releaseDeploymentProtocolEnabled();

const runtime = await initializeDeployedApplicationRuntime({
  profile: configured.profile,
  providers: {
    database: configured.providers.database,
    authentication: configured.providers.authentication,
    tenancy: configured.providers.tenancy,
    assets: configured.providers.assets,
    secrets: configured.providers.secrets,
    jobs: configured.providers.jobs,
    network: configured.providers.network,
  },
  database: {
    engine: 'postgres',
    connect: async () => {
      const db = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
      });
      try {
        if (!releaseProtocol) return db;
        await assertRuntimeDatabaseRole(db);
        const schemas = await readDeploymentSchemas();
        // This plain-Node process owns schedule dispatch, whose concrete model
        // closure is the public jobs + agent-schedules tables. The full app
        // registry is verified by web/task startup and the dedicated migrator.
        const tables = [
          '_smrt_jobs',
          '_smrt_job_events',
          '_smrt_agent_schedules',
        ];
        const required = schemas.filter((schema) =>
          tables.includes(schema.tableName),
        );
        if (required.length !== tables.length)
          throw new Error('Schedule schema artifact is incomplete.');
        await assertDeploymentSchemaReady(db, required);
        await assertDeploymentCatalogReady(db, required);
        return db;
      } catch (error) {
        await db.close?.();
        throw error;
      }
    },
    close: async (db) => db.close?.(),
  },
  authentication: {
    provider: configured.providers.authentication.provider,
    readiness: createProviderReadinessProbe('authentication', {
      profile: configured.profile,
      provider: configured.providers.authentication.provider,
    }),
  },
  assets: {
    provider: configured.providers.assets.provider,
    readiness: createProviderReadinessProbe('assets', {
      profile: configured.profile,
      provider: configured.providers.assets.provider,
    }),
  },
  secrets: {
    provider: configured.providers.secrets.provider,
    readiness: createProviderReadinessProbe('secrets', {
      profile: configured.profile,
      provider: configured.providers.secrets.provider,
    }),
  },
});

const kind = process.argv[2] || 'task';
const runner =
  kind === 'schedule'
    ? await runtime.createScheduleWorker()
    : await runtime.createTaskWorker({
        concurrency: Number.parseInt(
          process.env.SMRT_WORKER_CONCURRENCY || '4',
          10,
        ),
      });

await runner.start();
const stopHeartbeat = await startWorkerHeartbeat({ kind });
console.log(
  JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    kind,
    secretValuesIncluded: false,
  }),
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopHeartbeat();
  await runtime.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
