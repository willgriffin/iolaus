import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getIolausSourceRoot,
  getIolausUserAssetsRoot,
  resolveIolausLocalRuntimePaths,
} from './runtime-paths';

describe('Iolaus local runtime paths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the default user data and assets outside the source checkout', () => {
    const paths = resolveIolausLocalRuntimePaths();
    const sourceRoot = `${getIolausSourceRoot()}/`;

    expect(`${paths.root}/`.startsWith(sourceRoot)).toBe(false);
    expect(`${paths.database}/`.startsWith(sourceRoot)).toBe(false);
    expect(`${getIolausUserAssetsRoot()}/`.startsWith(sourceRoot)).toBe(false);
  });

  it('honors an explicit absolute data root for agent-managed installs', () => {
    vi.stubEnv('SMRT_DATA_DIR', '/tmp/iolaus-explicit-data');

    const paths = resolveIolausLocalRuntimePaths();
    const canonicalTemporaryRoot = realpathSync('/tmp');
    expect(paths.root).toBe(`${canonicalTemporaryRoot}/iolaus-explicit-data`);
    expect(paths.database).toBe(
      `${canonicalTemporaryRoot}/iolaus-explicit-data/application.sqlite`,
    );
    expect(getIolausUserAssetsRoot()).toBe(
      `${canonicalTemporaryRoot}/iolaus-explicit-data/assets`,
    );
  });
});
