import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import { runMatchingSourceExtraction } from '../src/lib/server/matching-source-extraction-worker.js';

const args = process.argv.slice(2);
const MAX_SOURCE_ATTEMPTS = 10;
const databaseArgs = args.filter((arg) => arg.startsWith('--database-name='));
const expectedDatabase = databaseArgs[0]?.slice('--database-name='.length);
const ids = [
  ...new Set(
    args
      .filter((arg) => arg.startsWith('--opportunity='))
      .map((arg) => arg.slice('--opportunity='.length)),
  ),
];
const backlogArgs = args.filter((arg) => arg.startsWith('--backlog='));
const backlog = backlogArgs[0]?.slice('--backlog='.length);
const steps = backlog === undefined ? ids.length : Number(backlog);
if (
  args.some(
    (arg) =>
      !arg.startsWith('--opportunity=') &&
      !arg.startsWith('--database-name=') &&
      !arg.startsWith('--backlog='),
  ) ||
  databaseArgs.length !== 1 ||
  !expectedDatabase ||
  !/^[a-z][a-z0-9_]*(?:_clone|_qa|_test)$/u.test(expectedDatabase) ||
  backlogArgs.length > 1 ||
  (backlog === undefined
    ? !ids.length ||
      ids.length > MAX_SOURCE_ATTEMPTS ||
      ids.some((id) => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(id))
    : ids.length > 0 || !/^\d{1,3}$/u.test(backlog) || steps < 1 || steps > 250)
)
  throw new Error(
    'Pass --database-name=<isolated PostgreSQL database> and either up to ten --opportunity=<UUID> arguments or --backlog=<1–250 scan steps>.',
  );

const config = getDbConfig();
const url = new URL(config.url);
const explicitUrl = process.env.DATABASE_URL;
if (
  config.type !== 'postgres' ||
  !explicitUrl ||
  url.href !== new URL(explicitUrl).href ||
  !['127.0.0.1', '[::1]'].includes(url.hostname) ||
  !url.port ||
  url.pathname !== `/${expectedDatabase}`
)
  throw new Error('Matching extraction QA requires an explicit loopback PostgreSQL database.');

const capMicros = Number(process.env.OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS);
const callCap = Number(process.env.OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT);
const tokenCap = Number(process.env.OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT);
if (
  !Number.isSafeInteger(capMicros) ||
  capMicros < 1 ||
  capMicros > 1_000_000 ||
  !Number.isSafeInteger(callCap) ||
  callCap < 1 ||
  callCap > 8 ||
  !Number.isSafeInteger(tokenCap) ||
  tokenCap < 1 ||
  tokenCap > 100_000
)
  throw new Error(
    'Set source-only hourly governance limits: at most eight calls, 100,000 input tokens, and one dollar.',
  );

const windowId = new Date().toISOString().slice(0, 13);
const database = await resolveDatabase(config);
try {
  const outcomes: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const diagnostics: Record<string, number> = {};
  let attempted = 0;
  let scanned = 0;
  let stop = 'scan-limit';
  while (scanned < steps) {
    if (attempted >= MAX_SOURCE_ATTEMPTS) {
      stop = 'source-limit';
      break;
    }
    if (new Date().toISOString().slice(0, 13) !== windowId) {
      stop = 'window-ended';
      break;
    }
    const opportunityId = ids[scanned];
    let admissionBlocked = false;
    const outcome = await runMatchingSourceExtraction(database, 'postgres', capMicros, {
      opportunityId,
      windowId,
      onFailure(kind) {
        failures[kind] = (failures[kind] ?? 0) + 1;
        admissionBlocked = [
          'Governance:budget_exhausted',
          'Governance:budget_missing',
          'Governance:circuit_open',
          'Governance:disabled',
          'Governance:pricing_missing',
        ].includes(kind);
      },
      onDiagnostic(kind) {
        diagnostics[kind] = (diagnostics[kind] ?? 0) + 1;
      },
    });
    scanned += 1;
    if (outcome !== 'idle') attempted += 1;
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (admissionBlocked) {
      stop = 'governance';
      break;
    }
  }
  console.log(JSON.stringify({ mode: backlog ? 'backlog' : 'sample', selected: ids.length, scanned, attempted, stop, outcomes, failures, diagnostics }));
} finally {
  await database.close();
}
