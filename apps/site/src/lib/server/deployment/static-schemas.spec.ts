import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);
const siteRoot = fileURLToPath(new URL('../../../../', import.meta.url));
let nestedCwd: string;

beforeAll(() => {
  mkdirSync(join(siteRoot, '.svelte-kit'), { recursive: true });
  nestedCwd = mkdtempSync(join(siteRoot, '.svelte-kit/schema-cwd-'));
});
afterAll(() => rmSync(nestedCwd, { recursive: true, force: true }));

function checkMetadata(cwd: string): {
  reachedDatabase: boolean;
  tables: string[];
  error?: string;
} {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    try {
      const { assertDeployedSchemaReady } = await import(${JSON.stringify(
        fileURLToPath(new URL('./schema.ts', import.meta.url)),
      )});
      let reachedDatabase = false;
      try {
        await assertDeployedSchemaReady({ query: async () => {
          reachedDatabase = true;
          throw new Error('metadata-probe-database-boundary');
        } });
      } catch (error) {
        if (error.message !== 'metadata-probe-database-boundary') throw error;
      }
      const { readApplicationDeploymentSchemas } = await import(${JSON.stringify(
        fileURLToPath(new URL('./static-schemas.ts', import.meta.url)),
      )});
      const tables = (await readApplicationDeploymentSchemas()).map(s => s.tableName).sort();
      console.log(JSON.stringify({ reachedDatabase, tables }));
    } catch (error) {
      console.log(JSON.stringify({ reachedDatabase: false, tables: [], error: error.message }));
    }
  `,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SMRT_RUNTIME_PROFILE: 'local',
        SMRT_APP_ID: 'iolaus-schema-regression',
        DATABASE_URL: '',
        IOLAUS_POSTGRES_PERMISSION_CONTRACT: 'false',
        TSX_TSCONFIG_PATH: join(siteRoot, 'tsconfig.runtime.json'),
      },
    },
  );
  const lines = output.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('published deployment schema authority', () => {
  it('declares the four packages whose public manifests it reads', () => {
    const { dependencies } = JSON.parse(
      readFileSync(join(siteRoot, 'package.json'), 'utf8'),
    );
    for (const suffix of ['prompts', 'secrets', 'playbooks', 'reports']) {
      expect(dependencies[`@happyvertical/smrt-${suffix}`]).toBe(
        dependencies['@happyvertical/smrt-core'],
      );
    }
  });

  for (const location of ['repository', 'site', 'nested'] as const) {
    it(`resolves the required published schema closure from the ${location} cwd before database reads`, () => {
      const cwd =
        location === 'repository'
          ? repositoryRoot
          : location === 'site'
            ? siteRoot
            : nestedCwd;
      const result = checkMetadata(cwd);
      expect(result.error).toBeUndefined();
      expect(result.reachedDatabase).toBe(true);
      expect(result.tables.length).toBeGreaterThan(0);
      expect(new Set(result.tables).size).toBe(result.tables.length);
      expect(result.tables).toEqual(
        expect.arrayContaining([
          '_smrt_prompt_overrides',
          'secrets',
          '_smrt_playbook_overrides',
          'runtime_reports',
        ]),
      );
    });
  }
});
