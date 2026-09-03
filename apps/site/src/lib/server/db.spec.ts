import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDatabaseUrl, getDbConfig } from './db';

describe('getDatabaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the canonical SQLite runtime database in the default local profile', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://example/ignored-in-local-mode');

    expect(getDbConfig()).toMatchObject({ type: 'sqlite' });
    expect(getDatabaseUrl()).toBe(getDbConfig().url);
    expect(getDatabaseUrl()).toMatch(/application\.sqlite$/u);
  });
});
