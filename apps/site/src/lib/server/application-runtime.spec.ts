import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  assertHostedRuntimeConfiguration,
  validateHostedDatabaseUrl,
} from './application-runtime';

const execFileAsync = promisify(execFile);
const siteRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const sourceRoot = resolve(siteRoot, '../..');
const applicationRuntimeModule = pathToFileURL(
  resolve(siteRoot, 'src/lib/server/application-runtime.ts'),
).href;

describe('local runtime database affinity', () => {
  it('shares one executor for concurrent application writes, rollback and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'iolaus-affinity-'));
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=commonjs',
          '--eval',
          `
          (async () => {
          const { default: assert } = await import('node:assert/strict');
          const { realpath } = await import('node:fs/promises');
          const { initializeLocalApplicationRuntime } = await import('@happyvertical/smrt-app-runtime');
          const { resolveDatabase } = await import('@happyvertical/smrt-core');
          const app = await import(${JSON.stringify(applicationRuntimeModule)});
          const { getSmrtOptions } = await import(${JSON.stringify(pathToFileURL(resolve(siteRoot, 'src/lib/server/db.ts')).href)});
          const options = {
            appId: 'iolaus-affinity',
            createSchema: true,
            dataDirectory: await realpath(process.env.SMRT_DATA_DIR),
            sourceRoot: ${JSON.stringify(sourceRoot)},
            bindHost: '127.0.0.1',
          };
          let runtime;
          try {
            ({ runtime } = await initializeLocalApplicationRuntime(options));
            const ordinary = await Promise.all(Array.from({ length: 4 }, () => resolveDatabase(getSmrtOptions().db)));
            for (const db of ordinary) assert.strictEqual(db, runtime.db);
            assert.equal(runtime.db.engine, 'node-sqlite');
            assert.equal(app.getApplicationDatabaseConfig().secureFile.root, runtime.paths.root);
            await runtime.db.query('CREATE TABLE affinity_records (id TEXT PRIMARY KEY, kind TEXT, revision INTEGER)');
            await Promise.all(ordinary.map((db, index) => db.transaction(async tx => {
              await tx.query('INSERT INTO affinity_records VALUES (?, ?, ?)', [String(index), index % 2 ? 'draft' : 'session', 1]);
              await new Promise(resolve => setTimeout(resolve, 5));
              await tx.query('UPDATE affinity_records SET revision = revision + 1 WHERE id = ?', [String(index)]);
            })));
            await assert.rejects(ordinary[0].transaction(async tx => {
              await tx.query("UPDATE affinity_records SET revision = 99 WHERE kind = 'draft'");
              throw new Error('synthetic rollback');
            }), /synthetic rollback/);
            assert.equal((await runtime.db.query('SELECT * FROM affinity_records WHERE revision = 2')).rows.length, 4);
            await runtime.db.close();
            const previous = runtime.db;
            ({ runtime } = await initializeLocalApplicationRuntime(options));
            assert.notStrictEqual(runtime.db, previous);
            assert.strictEqual(await resolveDatabase(getSmrtOptions().db), runtime.db);
            assert.equal(runtime.db.engine, 'node-sqlite');
            assert.equal((await runtime.db.query('SELECT * FROM affinity_records WHERE revision = 2')).rows.length, 4);
            process.stdout.write('affinity lifecycle passed');
          } finally {
            await runtime?.db.close();
          }
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
        ],
        {
          cwd: siteRoot,
          env: {
            ...process.env,
            SMRT_APP_ID: 'iolaus-affinity',
            SMRT_DATA_DIR: directory,
            SMRT_RUNTIME_PROFILE: 'local',
            TSX_TSCONFIG_PATH: resolve(siteRoot, 'tsconfig.runtime.json'),
          },
          timeout: 20_000,
        },
      );
      expect(stdout).toContain('affinity lifecycle passed');
      expect(stderr).not.toContain('HV_SQL_SQLITE_ENGINE_MIX');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 25_000);
});

async function probeHostedRuntime(
  cwd: string,
  primeLocalConfigCache = false,
): Promise<{
  database: string;
  timeout: number;
  profile: string;
}> {
  const cacheDirectory = primeLocalConfigCache
    ? await mkdtemp(join(tmpdir(), 'iolaus-runtime-config-'))
    : undefined;
  const cachedConfigPath = cacheDirectory
    ? join(cacheDirectory, 'smrt.config.js')
    : undefined;
  if (cachedConfigPath) {
    await writeFile(
      cachedConfigPath,
      "export default { runtime: { profile: 'local' } };\n",
    );
  }

  const cachePreload = cachedConfigPath
    ? `const { loadConfig } = await import('@happyvertical/smrt-config'); await loadConfig({ configPath: ${JSON.stringify(cachedConfigPath)} });`
    : '';
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `${cachePreload} const runtime = await import(${JSON.stringify(applicationRuntimeModule)}); process.stdout.write(JSON.stringify({ profile: runtime.applicationRuntime.profile, database: runtime.getApplicationDatabaseConfig().type, timeout: runtime.getApplicationDatabaseConfig().connectionTimeoutMillis }));`,
      ],
      {
        cwd,
        env: {
          ...process.env,
          DATABASE_URL:
            'postgresql://runtime:runtime@127.0.0.1:5432/runtime_bootstrap_test',
          IOLAUS_DB_CONNECTION_TIMEOUT_MS: '5000',
          SMRT_APP_ID: 'runtime-bootstrap',
          SMRT_RUNTIME_PROFILE: 'self-hosted',
          TSX_TSCONFIG_PATH: resolve(siteRoot, 'tsconfig.runtime.json'),
        },
      },
    );
    return JSON.parse(stdout) as {
      database: string;
      timeout: number;
      profile: string;
    };
  } finally {
    if (cacheDirectory)
      await rm(cacheDirectory, { force: true, recursive: true });
  }
}

describe('validateHostedDatabaseUrl', () => {
  it('requires an operator-specific public database namespace', () => {
    expect(() =>
      validateHostedDatabaseUrl('postgresql://db.example.com/iolaus'),
    ).toThrow(/operator-unique PostgreSQL database name/u);
    expect(() =>
      validateHostedDatabaseUrl('postgresql://db.example.com/iolaus_dev'),
    ).toThrow(/operator-unique PostgreSQL database name/u);
    expect(() =>
      validateHostedDatabaseUrl('postgresql://db.example.com/postgres'),
    ).toThrow(/operator-unique PostgreSQL database name/u);
    expect(() =>
      validateHostedDatabaseUrl('postgresql://db.example.com'),
    ).toThrow(/operator-unique PostgreSQL database name/u);
    expect(() => validateHostedDatabaseUrl('sqlite:///tmp/iolaus.db')).toThrow(
      /require a PostgreSQL DATABASE_URL/u,
    );
    expect(
      validateHostedDatabaseUrl('postgresql://db.example.com/iolaus_release'),
    ).toBe('postgresql://db.example.com/iolaus_release');
    expect(() =>
      validateHostedDatabaseUrl('postgresql://db.example.com/shared_career'),
    ).toThrow(/operator-unique PostgreSQL database name/u);
  });
});

describe('hosted runtime configuration', () => {
  it('fails closed when an explicit hosted profile has no loaded config', () => {
    expect(() => assertHostedRuntimeConfiguration({}, 'self-hosted')).toThrow(
      /Unable to load SMRT runtime configuration/u,
    );
    expect(() => assertHostedRuntimeConfiguration({}, 'cloud')).toThrow(
      /Unable to load SMRT runtime configuration/u,
    );
  });

  it('keeps local as the canonical fallback and accepts loaded hosted config', () => {
    expect(() => assertHostedRuntimeConfiguration({}, 'local')).not.toThrow();
    expect(() =>
      assertHostedRuntimeConfiguration({ runtime: { profile: 'self-hosted' } }),
    ).not.toThrow();
  });
});

describe('deployed runtime entrypoints', () => {
  it('loads the self-hosted site config from root and site working directories', async () => {
    await expect(probeHostedRuntime(sourceRoot)).resolves.toEqual({
      database: 'postgres',
      timeout: 5_000,
      profile: 'self-hosted',
    });
    await expect(probeHostedRuntime(siteRoot)).resolves.toEqual({
      database: 'postgres',
      timeout: 5_000,
      profile: 'self-hosted',
    });
    await expect(probeHostedRuntime(sourceRoot, true)).resolves.toEqual({
      database: 'postgres',
      timeout: 5_000,
      profile: 'self-hosted',
    });
  }, 15_000);
});

describe('hosted database pool ceiling', () => {
  it('defaults each process to a pool that fits the runtime role limit', async () => {
    const { DEFAULT_HOSTED_DATABASE_POOL_MAX, hostedDatabasePoolMax } =
      await import('./application-runtime');
    expect(hostedDatabasePoolMax({})).toBe(DEFAULT_HOSTED_DATABASE_POOL_MAX);
    // Two web replicas plus a rollout surge and both workers must fit the
    // 30-connection runtime role alongside one readiness client each.
    expect(5 * DEFAULT_HOSTED_DATABASE_POOL_MAX + 5).toBeLessThanOrEqual(30);
  });

  it('accepts a positive integer override and rejects anything else', async () => {
    const { hostedDatabasePoolMax } = await import('./application-runtime');
    expect(hostedDatabasePoolMax({ IOLAUS_DB_POOL_MAX: ' 8 ' })).toBe(8);
    for (const value of ['0', '-1', '2.5', 'many']) {
      expect(() =>
        hostedDatabasePoolMax({ IOLAUS_DB_POOL_MAX: value }),
      ).toThrow('IOLAUS_DB_POOL_MAX must be a positive integer.');
    }
  });
});

describe('native database acquisition timeout', () => {
  it('uses a positive bounded timeout and validates overrides', async () => {
    const { databaseConnectionTimeoutMillis } = await import(
      './application-runtime'
    );
    expect(databaseConnectionTimeoutMillis({})).toBe(5_000);
    expect(
      databaseConnectionTimeoutMillis({
        IOLAUS_DB_CONNECTION_TIMEOUT_MS: ' 250 ',
      }),
    ).toBe(250);
    for (const value of ['0', '-1', '1.5', 'many', '2147483648'])
      expect(() =>
        databaseConnectionTimeoutMillis({
          IOLAUS_DB_CONNECTION_TIMEOUT_MS: value,
        }),
      ).toThrow('positive bounded integer');
  });
});
