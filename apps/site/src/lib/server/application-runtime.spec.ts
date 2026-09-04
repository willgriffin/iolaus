import { describe, expect, it } from 'vitest';
import { validateHostedDatabaseUrl } from './application-runtime';

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
