import { realpathSync } from 'node:fs';
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
  loadStatus = () => import('./db-status.ts'),
} = {}) {
  env.DATABASE_URL = monitorReadinessDatabaseUrl(env.DATABASE_URL);
  await loadStatus();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Monitor readiness accepts no arguments.');
    await runMonitorReadiness();
  } catch {
    console.error('Monitor schema readiness failed. Run the dedicated migration and inspect its private diagnostics.');
    process.exitCode = 1;
  }
}
