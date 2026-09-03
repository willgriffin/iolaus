import type { SmrtClassOptions } from '@happyvertical/smrt-core';

export const defaultDatabaseUrl =
  'postgresql://iolaus:iolaus@localhost:54329/iolaus_dev';

export function getDatabaseUrl(): string {
  const configuredUrl = process.env.DATABASE_URL?.trim();
  if (configuredUrl) return configuredUrl;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production.');
  }

  return defaultDatabaseUrl;
}

export function getDbConfig(): NonNullable<SmrtClassOptions['db']> {
  return {
    type: 'postgres',
    url: getDatabaseUrl(),
  };
}

export function getSmrtOptions(): SmrtClassOptions {
  return {
    db: getDbConfig(),
  };
}
