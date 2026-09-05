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

async function probeHostedRuntime(
  cwd: string,
  primeLocalConfigCache = false,
): Promise<{
  database: string;
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
        `${cachePreload} const runtime = await import(${JSON.stringify(applicationRuntimeModule)}); process.stdout.write(JSON.stringify({ profile: runtime.applicationRuntime.profile, database: runtime.getApplicationDatabaseConfig().type }));`,
      ],
      {
        cwd,
        env: {
          ...process.env,
          DATABASE_URL:
            'postgresql://runtime:runtime@127.0.0.1:5432/runtime_bootstrap_test',
          SMRT_APP_ID: 'runtime-bootstrap',
          SMRT_RUNTIME_PROFILE: 'self-hosted',
          TSX_TSCONFIG_PATH: resolve(siteRoot, 'tsconfig.runtime.json'),
        },
      },
    );
    return JSON.parse(stdout) as { database: string; profile: string };
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
      profile: 'self-hosted',
    });
    await expect(probeHostedRuntime(siteRoot)).resolves.toEqual({
      database: 'postgres',
      profile: 'self-hosted',
    });
    await expect(probeHostedRuntime(sourceRoot, true)).resolves.toEqual({
      database: 'postgres',
      profile: 'self-hosted',
    });
  }, 15_000);
});
