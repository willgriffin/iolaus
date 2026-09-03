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
    vi.stubEnv('SMRT_DATA_DIR', '/private/tmp/iolaus-explicit-data');

    const paths = resolveIolausLocalRuntimePaths();
    expect(paths.root).toBe('/private/tmp/iolaus-explicit-data');
    expect(paths.database).toBe(
      '/private/tmp/iolaus-explicit-data/application.sqlite',
    );
    expect(getIolausUserAssetsRoot()).toBe(
      '/private/tmp/iolaus-explicit-data/assets',
    );
  });
});
