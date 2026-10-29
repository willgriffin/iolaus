import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  events: [] as string[],
  pending: Promise.resolve(),
  failure: false,
}));
vi.mock('../src/lib/server/deployment/observer.js', () => ({
  releaseIdentity: () => ({
    application: 'iolaus',
    environment: 'test',
    release: 'r1',
    attempt: 'a1',
  }),
  waitForWriterFenceEnrollment: async () => {
    state.events.push('wait');
    if (state.failure)
      throw new Error('Fresh native writer-fence lease is unverified.');
    await state.pending;
    state.events.push('enrolled');
  },
}));
vi.mock('./db-migrate-options.js', () => ({
  parseDbMigrateOptions: () => ({ maintenanceWindow: true }),
}));
vi.mock('../../../scripts/smrt-deployment-schema.mjs', () => ({
  releaseDeploymentProtocolEnabled: () => true,
  assertDeploymentSchemaReady: async () => {
    state.events.push('schema');
  },
}));
vi.mock('./db-common.js', () => {
  state.events.push('preload');
  return {
    withSmrtDatabaseMigrationLock: async (work: () => Promise<void>) => work(),
  };
});
vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: { getAllSchemasAsDefinitions: () => ({}) },
  resolveDatabase: async () => {
    state.events.push('db');
    return {
      close: async () => {
        state.events.push('close');
      },
    };
  },
}));
vi.mock('../src/lib/server/db.js', () => ({
  getDbConfig: () => {
    state.events.push('configuration');
    return { type: 'postgres' };
  },
}));
vi.mock('./db-release-safety.js', () => ({
  createReleaseSafetyCheck: () => async () => {
    state.events.push('fresh-safety');
  },
}));
vi.mock('./db-release-schema.js', () => ({
  prepareReleaseSchema: async (_db: unknown, check: () => Promise<void>) =>
    check(),
  finalizeReleaseIntegrity: async (_db: unknown, check: () => Promise<void>) =>
    check(),
  verifyReleaseIntegrity: async () => {},
}));
vi.mock('./db-release-catalog.js', () => ({ releaseCatalog: () => [] }));
vi.mock('./db-release-executor.js', () => ({
  executeReleaseCatalog: async (options: {
    checkSafety: () => Promise<void>;
  }) => {
    await options.checkSafety();
    return [];
  },
}));

describe('published release migration startup ordering', () => {
  beforeEach(() => {
    vi.resetModules();
    state.events = [];
    state.failure = false;
    state.pending = Promise.resolve();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  it('awaits native enrollment before importing DB closure or invoking factory, then retains fresh mutation checks', async () => {
    let enrolled = () => {};
    state.pending = new Promise<void>((resolve) => {
      enrolled = resolve;
    });
    const running = import('./db-release-migrate.js');
    await vi.waitFor(() => expect(state.events).toContain('wait'));
    expect(state.events).toEqual(['wait']);
    enrolled();
    await running;
    expect(state.events.indexOf('enrolled')).toBeLessThan(
      state.events.indexOf('preload'),
    );
    expect(state.events.indexOf('enrolled')).toBeLessThan(
      state.events.indexOf('db'),
    );
    expect(state.events.filter((e) => e === 'fresh-safety')).toHaveLength(4);
    expect(state.events.at(-1)).toBe('close');
  });
  it('does not import DB closure or call factory when startup rejects an expired/drifted lease', async () => {
    state.failure = true;
    await expect(import('./db-release-migrate.js')).rejects.toThrow(
      'Fresh native writer-fence lease is unverified.',
    );
    expect(state.events).toEqual(['wait']);
  });
});
