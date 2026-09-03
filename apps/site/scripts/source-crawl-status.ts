import {
  getSourceCrawlWatchdogStatus,
  reapStaleSourceCrawls,
} from '../src/lib/server/source-crawl-watchdog.js';

const args = new Set(process.argv.slice(2).filter((arg) => arg !== '--'));
if (args.size > 1 || (args.size === 1 && !args.has('--reconcile'))) {
  throw new Error(
    'Usage: pnpm --filter @willgriffin/iolaus-site opportunities:crawl-status [--reconcile]',
  );
}

const reconciled = args.has('--reconcile')
  ? await reapStaleSourceCrawls()
  : null;
const status = await getSourceCrawlWatchdogStatus();
console.log(JSON.stringify({ ...status, ...(reconciled ?? {}) }, null, 2));
