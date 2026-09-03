import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDatabaseUrl, getDatabaseUrl } from './db';

describe('getDatabaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the configured database URL when present', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://example/db');

    expect(getDatabaseUrl()).toBe('postgresql://example/db');
  });

  it('keeps the local development fallback outside production', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('NODE_ENV', 'development');

    expect(getDatabaseUrl()).toBe(defaultDatabaseUrl);
  });

  it('requires an explicit database URL in production', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => getDatabaseUrl()).toThrow(
      'DATABASE_URL is required in production.',
    );
  });
});
