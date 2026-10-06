// Operator-run recurring crawl for shared hosted deployments (run it from a
// CronJob). See src/lib/server/due-source-crawl.ts for why it exists. Prints
// counts only.
import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import {
  nextCheckAfter,
  selectDueSources,
} from '../src/lib/server/due-source-crawl.js';
import { crawlOpportunitySource } from '../src/lib/server/opportunity-source-crawler.js';
import { getCollection } from '../src/lib/server/smrt.js';

const usage = `Usage: pnpm --filter @willgriffin/iolaus-site sources:crawl-due -- [--max N] [--budget-minutes M] [--dry-run]

Crawls up to N (default 10) active root sources whose own cadence says they are
due, stopping early after M minutes (default 40), then advances each source's
next check. Output is counts only.`;

const args = process.argv.slice(2).filter((arg) => arg !== '--');
function option(name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(usage);
    process.exit(2);
  }
  return value;
}
for (const arg of args) {
  if (
    arg.startsWith('--') &&
    !['--budget-minutes', '--dry-run', '--max'].includes(arg)
  ) {
    console.error(usage);
    process.exit(2);
  }
}
const max = option('--max', 10);
const budgetMs = option('--budget-minutes', 40) * 60_000;
const dryRun = args.includes('--dry-run');

type SourceRecord = Record<string, unknown> & {
  id?: string;
  save?: () => Promise<unknown>;
};
const sources = (await getCollection('Source')) as unknown as {
  list: (options: { limit: number; offset?: number }) => Promise<SourceRecord[]>;
};
const all: SourceRecord[] = [];
for (let offset = 0; ; offset += 500) {
  const page = await sources.list({ limit: 500, offset });
  all.push(...page);
  if (page.length < 500) break;
}

const started = Date.now();
const due = selectDueSources(all as never[], new Date(), max) as SourceRecord[];
const totals = {
  attempted: 0,
  candidates: 0,
  created: 0,
  due: due.length,
  failed: 0,
  skippedForBudget: 0,
};
for (const source of due) {
  if (dryRun) continue;
  if (Date.now() - started > budgetMs) {
    totals.skippedForBudget += 1;
    continue;
  }
  totals.attempted += 1;
  let failed = false;
  try {
    const summary = await crawlOpportunitySource(source as never, {
      includeGeneric: true,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    totals.candidates += summary.candidates;
    totals.created += summary.created;
    // Board reconciliation needs a verified workspace subject in shared mode and
    // is reported as an error; the crawl itself still ingested its postings.
    failed = summary.candidates === 0 && summary.errors.length > 0;
  } catch {
    failed = true;
  }
  if (failed) totals.failed += 1;
  const now = new Date();
  source.lastCheckedAt = now;
  source.nextCheckAt = nextCheckAfter(source as never, now, failed);
  await source.save?.();
}
console.log(JSON.stringify({ dryRun, ...totals }));
process.exit(0);
