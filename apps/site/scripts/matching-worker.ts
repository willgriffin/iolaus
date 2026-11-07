import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import { runMatchingTick, startMatchingWorker } from '../src/lib/server/matching-projection-worker.js';

// This runner deliberately imports neither job registration nor schedule/crawl
// workers. Normal deployment uses the matching loop in jobs-worker.ts instead.
const args = process.argv.slice(2);
const continuous = args.includes('--watch');
const expectedDatabase = args.find((arg) => arg.startsWith('--database-name='))?.slice(16);
if (
  args.some((arg) => arg !== '--watch' && !arg.startsWith('--database-name=')) ||
  !expectedDatabase ||
  !/^[a-z][a-z0-9_]*(?:_clone|_qa|_test)$/.test(expectedDatabase)
) throw new Error('Use --database-name=<explicit isolated database ending in _clone, _qa, or _test> [--watch].');
const config = getDbConfig();
const url = new URL(config.url);
const explicitUrl = process.env.DATABASE_URL;
if (config.type !== 'postgres' || !explicitUrl || url.href !== new URL(explicitUrl).href ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
    url.pathname !== `/${expectedDatabase}`) {
  throw new Error('Matching QA requires an explicit loopback PostgreSQL DATABASE_URL and the matching isolated database name.');
}

const database = await resolveDatabase(config);
if (!continuous) {
  console.log(JSON.stringify(await runMatchingTick(database, 'postgres')));
  await database.close();
} else {
  const stop = startMatchingWorker(database, 'postgres');
  console.log('Local matching worker started.');
  const finish = async () => {
    await stop();
    await database.close();
  };
  process.once('SIGINT', () => void finish());
  process.once('SIGTERM', () => void finish());
}
