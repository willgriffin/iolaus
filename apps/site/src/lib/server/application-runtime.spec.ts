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
    expect(
      validateHostedDatabaseUrl('postgresql://db.example.com/career_hub'),
    ).toBe('postgresql://db.example.com/career_hub');
  });
});
