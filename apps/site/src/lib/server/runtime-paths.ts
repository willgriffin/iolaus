import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveLocalRuntimePaths } from '@happyvertical/smrt-app-runtime';
import { canonicalizeDataDirectory } from '../../../../../scripts/smrt-runtime-identity.mjs';

export const IOLAUS_APPLICATION_ID = 'iolaus';

/** Resolve the monorepo root from root, site, or generated-server process cwd. */
export function getIolausSourceRoot(cwd = process.cwd()): string {
  let candidate = resolve(cwd);
  while (true) {
    if (existsSync(resolve(candidate, 'apps/site/package.json')))
      return candidate;
    if (
      existsSync(resolve(candidate, 'package.json')) &&
      existsSync(resolve(candidate, 'smrt.config.js'))
    ) {
      return resolve(candidate, '../..');
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error('Unable to resolve the Iolaus source root.');
}

/** Resolve the application config independently of the invoking entrypoint cwd. */
export function getIolausSmrtConfigPath(
  sourceRoot = getIolausSourceRoot(),
): string {
  return resolve(sourceRoot, 'apps/site/smrt.config.js');
}

export function resolveIolausLocalRuntimePaths() {
  return resolveLocalRuntimePaths({
    appId: process.env.SMRT_APP_ID || IOLAUS_APPLICATION_ID,
    dataDirectory: canonicalizeDataDirectory(process.env.SMRT_DATA_DIR),
    sourceRoot: getIolausSourceRoot(),
  });
}

/** User-owned application data root; never inside the source checkout. */
export function getIolausUserDataRoot(): string {
  return resolveIolausLocalRuntimePaths().root;
}

/** User-owned profile/candidate asset root. */
export function getIolausUserAssetsRoot(): string {
  return resolveIolausLocalRuntimePaths().assets;
}
