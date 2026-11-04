import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import { runMatchingSourceExtraction } from '../src/lib/server/matching-source-extraction-worker.js';

const args = process.argv.slice(2);
const expectedDatabase = args.find((arg) => arg.startsWith('--database-name='))?.slice(16);
const ids = [...new Set(args.filter((arg) => arg.startsWith('--opportunity=')).map((arg) => arg.slice(14)))];
if (
  args.some((arg) => !arg.startsWith('--opportunity=') && !arg.startsWith('--database-name=')) ||
  !expectedDatabase || !/^[a-z][a-z0-9_]*(?:_clone|_qa|_test)$/.test(expectedDatabase) ||
  !ids.length || ids.length > 10 ||
  ids.some((id) => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(id))
) throw new Error('Pass --database-name=<isolated PostgreSQL database> and up to ten explicit --opportunity=<UUID> arguments.');

const config = getDbConfig();
const url = new URL(config.url);
const explicitUrl = process.env.DATABASE_URL;
if (config.type !== 'postgres' || !explicitUrl || url.href !== new URL(explicitUrl).href ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
    url.pathname !== `/${expectedDatabase}`)
  throw new Error('Matching extraction QA requires an explicit loopback PostgreSQL database.');

const capMicros = Number(process.env.OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS);
const callCap = Number(process.env.OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT);
const tokenCap = Number(process.env.OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT);
if (!Number.isSafeInteger(capMicros) || capMicros < 1 || capMicros > 1_000_000 ||
    !Number.isSafeInteger(callCap) || callCap < 1 || callCap > 10 ||
    !Number.isSafeInteger(tokenCap) || tokenCap < 1 || tokenCap > 160_000)
  throw new Error('Set source-only governance limits: at most ten calls, 160,000 input tokens, and one dollar.');
const database = await resolveDatabase(config);
try {
  const outcomes: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const diagnostics: Record<string, number> = {};
  for (const opportunityId of ids) {
    const outcome = await runMatchingSourceExtraction(database, 'postgres', capMicros, {
      opportunityId,
      onFailure(kind) { failures[kind] = (failures[kind] ?? 0) + 1; },
      onDiagnostic(kind) { diagnostics[kind] = (diagnostics[kind] ?? 0) + 1; },
    });
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  console.log(JSON.stringify({ selected: ids.length, outcomes, failures, diagnostics }));
} finally {
  await database.close();
}
