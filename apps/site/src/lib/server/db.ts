import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  getApplicationDatabaseConfig,
  type IolausDatabaseConfig,
} from './application-runtime.js';

export function getDatabaseUrl(): string {
  const config = getApplicationDatabaseConfig();
  if (!config?.url)
    throw new Error('The application database URL is unavailable.');
  return config.url;
}

export function getDbConfig(): IolausDatabaseConfig {
  const config = getApplicationDatabaseConfig();
  if (!config)
    throw new Error('The application database configuration is unavailable.');
  return config;
}

export function getSmrtOptions(): SmrtClassOptions {
  return {
    db: getDbConfig(),
  };
}
