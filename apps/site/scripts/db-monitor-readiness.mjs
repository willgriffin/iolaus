import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Add the native PostgreSQL session constraint before loading app configuration. */
export function monitorReadinessDatabaseUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
      throw new Error('Invalid PostgreSQL connection');
    }
    const options = url.searchParams.get('options') || '';
    url.searchParams.set('options', `${options} -c default_transaction_read_only=on`.trim());
    return url.href;
  } catch {
    throw new Error('Monitor readiness requires a valid PostgreSQL DATABASE_URL.');
  }
}

export async function runMonitorReadiness({
  env = process.env,
  loadStatus = async () => {
    const { checkDatabaseStatus } = await import('./db-status.ts');
    await checkDatabaseStatus({ schemaOnly: true });
  },
} = {}) {
  try {
    env.DATABASE_URL = monitorReadinessDatabaseUrl(env.DATABASE_URL);
  } catch (error) {
    error.readinessPhase = 'configuration';
    throw error;
  }
  await loadStatus();
}

/** Emit only a bounded phase and SQLSTATE; query text/URLs never cross this fence. */
export function monitorReadinessFailure(error) {
  const phase = error?.readinessPhase === 'configuration' ? 'configuration' : 'status';
  let cause = error;
  for (let depth = 0; cause && depth < 5; depth++) {
    if (typeof cause.code === 'string' && /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/.test(cause.code)) {
      return { phase, sqlState: cause.code };
    }
    cause = cause.cause ?? cause.originalError;
  }
  return { phase, sqlState: 'unknown' };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Monitor readiness accepts no arguments.');
    await runMonitorReadiness();
  } catch (error) {
    const { phase, sqlState } = monitorReadinessFailure(error);
    console.error(`Monitor schema readiness failed (phase=${phase}, sqlstate=${sqlState}). Inspect private migration/readiness diagnostics.`);
    process.exitCode = 1;
  }
}
