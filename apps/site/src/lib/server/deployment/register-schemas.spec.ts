import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// deployment -> server -> lib -> src -> site -> apps -> <repository root>
const repositoryRoot = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);
const siteRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Run the module in a fresh Node process from `cwd` and report what it
 * registered. The deployed image runs migrations and the server from the
 * repository root (`cd /app && node --import tsx apps/site/scripts/...`),
 * where `@happyvertical/smrt-chat` is not resolvable from `process.cwd()`. */
function registerFrom(cwd: string): {
  ok: boolean;
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
      const modulePath = ${JSON.stringify(
        fileURLToPath(new URL('./register-schemas.ts', import.meta.url)),
      )};
      try {
        await import(modulePath);
        // Resolve smrt-core from apps/site, not from the cwd under test.
        const { createRequire } = await import('node:module');
        const { pathToFileURL } = await import('node:url');
        const corePath = createRequire(${JSON.stringify(`${siteRoot}package.json`)})
          .resolve('@happyvertical/smrt-core');
        const { ObjectRegistry } = await import(pathToFileURL(corePath).href);
        const tables = Object.keys(ObjectRegistry.getAllSchemasAsDefinitions()).sort();
        console.log(JSON.stringify({ ok: true, tables }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, tables: [], error: String(error?.message ?? error) }));
      }
      `,
    ],
    {
      encoding: 'utf8',
      cwd,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: `${siteRoot}tsconfig.runtime.json`,
      },
    },
  );
  const lines = output.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('registerDeploymentSchemaMetadata', () => {
  it('registers the released chat schemas when run from apps/site', () => {
    const result = registerFrom(siteRoot);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.tables).toContain('chat_messages');
  });

  it('registers the same schemas from the repository root, as the deployed image does', () => {
    const fromRoot = registerFrom(repositoryRoot);
    expect(fromRoot.error).toBeUndefined();
    expect(fromRoot.ok).toBe(true);
    expect(fromRoot.tables).toEqual(registerFrom(siteRoot).tables);
  });
});
