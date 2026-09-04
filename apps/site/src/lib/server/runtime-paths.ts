import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveLocalRuntimePaths } from '@happyvertical/smrt-app-runtime';
import { canonicalizeDataDirectory } from '../../../../../scripts/smrt-runtime-identity.mjs';

export const IOLAUS_APPLICATION_ID = 'iolaus';

/** Resolve the monorepo root from either a root or apps/site process cwd. */
export function getIolausSourceRoot(cwd = process.cwd()): string {
  if (existsSync(resolve(cwd, 'apps/site/package.json'))) return resolve(cwd);
  const candidate = resolve(cwd, '../..');
  if (existsSync(resolve(candidate, 'apps/site/package.json')))
    return candidate;
  throw new Error('Unable to resolve the Iolaus source root.');
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
