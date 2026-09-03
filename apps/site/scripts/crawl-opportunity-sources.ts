import { pathToFileURL } from 'node:url';
import {
  crawlOpportunitySources,
  type CrawlOpportunitySourcesOptions,
  type CrawlOpportunitySourcesSummary,
} from '../src/lib/server/opportunity-source-crawler.js';

interface CliOptions extends CrawlOpportunitySourcesOptions {
  all?: boolean;
  json?: boolean;
  sourceIds: string[];
}

function usage(): never {
  throw new Error(
    [
      'Usage:',
      '  pnpm --filter @willgriffin/iolaus-site opportunities:crawl -- --source <source-id>',
      '  pnpm --filter @willgriffin/iolaus-site opportunities:crawl -- --all',
      '',
      'Options:',
      '  --source <id>        Crawl one source. Can be repeated.',
      '  --all                Crawl all active Ashby/Greenhouse sources.',
      '  --include-generic    Also crawl generic pages for Ashby/Greenhouse links.',
      '  --limit <n>          Max candidates per source.',
      '  --dry-run            Discover and resolve without writing records.',
      '  --json               Print the merged summary as JSON.',
    ].join('\n'),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { sourceIds: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--include-generic') {
      options.includeGeneric = true;
      continue;
    }
    if (arg === '--source') {
      const value = args[index + 1];
      if (!value) usage();
      options.sourceIds.push(value);
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value) || value <= 0) usage();
      options.limit = value;
      index += 1;
      continue;
    }

    usage();
  }

  if (!options.all && options.sourceIds.length === 0) usage();
  if (options.all && options.sourceIds.length > 0) usage();

  return options;
}

export function mergeSummaries(summaries: CrawlOpportunitySourcesSummary[]): CrawlOpportunitySourcesSummary {
  return {
    candidates: summaries.reduce((total, summary) => total + summary.candidates, 0),
    created: summaries.reduce((total, summary) => total + summary.created, 0),
    duplicates: summaries.reduce((total, summary) => total + summary.duplicates, 0),
    errors: summaries.flatMap((summary) => summary.errors),
    intelligenceDuplicateSuppressed: summaries.reduce(
      (total, summary) => total + summary.intelligenceDuplicateSuppressed,
      0,
    ),
    intelligenceEnqueued: summaries.reduce(
      (total, summary) => total + summary.intelligenceEnqueued,
      0,
    ),
    intelligenceSkipped: summaries.reduce(
      (total, summary) => total + summary.intelligenceSkipped,
      0,
    ),
    failedPersistence: summaries.reduce(
      (total, summary) => total + summary.failedPersistence,
      0,
    ),
    relisted: summaries.reduce((total, summary) => total + summary.relisted, 0),
    reused: summaries.reduce((total, summary) => total + summary.reused, 0),
    skipped: summaries.reduce((total, summary) => total + summary.skipped, 0),
    sources: summaries.flatMap((summary) => summary.sources),
  };
}

export function printSummary(summary: CrawlOpportunitySourcesSummary): void {
  for (const source of summary.sources) {
    console.log(
      [
        source.sourceName,
        `candidates=${source.candidates}`,
        `created=${source.created}`,
        `reused=${source.reused}`,
        `relisted=${source.relisted}`,
        `duplicates=${source.duplicates}`,
        `failedPersistence=${source.failedPersistence}`,
        `intelligenceQueued=${source.intelligenceEnqueued}`,
        `intelligenceDeduped=${source.intelligenceDuplicateSuppressed}`,
        `intelligenceSkipped=${source.intelligenceSkipped}`,
        `skipped=${source.skipped}`,
        `errors=${source.errors.length}`,
      ].join(' | '),
    );
  }

  console.log(
    [
      'Total',
      `sources=${summary.sources.length}`,
      `candidates=${summary.candidates}`,
      `created=${summary.created}`,
      `reused=${summary.reused}`,
      `relisted=${summary.relisted}`,
      `duplicates=${summary.duplicates}`,
      `failedPersistence=${summary.failedPersistence}`,
      `intelligenceQueued=${summary.intelligenceEnqueued}`,
      `intelligenceDeduped=${summary.intelligenceDuplicateSuppressed}`,
      `intelligenceSkipped=${summary.intelligenceSkipped}`,
      `skipped=${summary.skipped}`,
      `errors=${summary.errors.length}`,
    ].join(' | '),
  );

  if (summary.errors.length) {
    console.error(summary.errors.join('\n'));
  }
}

export function formatSummaryJson(
  summary: CrawlOpportunitySourcesSummary,
): string {
  return JSON.stringify(summary);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const summaries = options.all
    ? [
        await crawlOpportunitySources({
          dryRun: options.dryRun,
          includeGeneric: options.includeGeneric,
          limit: options.limit,
        }),
      ]
    : await Promise.all(
        options.sourceIds.map((sourceId) =>
          crawlOpportunitySources({
            dryRun: options.dryRun,
            includeGeneric: options.includeGeneric,
            limit: options.limit,
            sourceId,
          }),
        ),
      );

  const summary = mergeSummaries(summaries);
  if (options.json) console.log(formatSummaryJson(summary));
  else printSummary(summary);
  process.exitCode = summary.errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
