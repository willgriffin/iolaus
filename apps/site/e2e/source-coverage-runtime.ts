import '../scripts/jobs-worker-bootstrap.js';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { TaskRunner } from '@happyvertical/smrt-jobs';
import { getDbConfig } from '../src/lib/server/db.js';
import { getOpportunityIntelligenceJobDedupeStatus } from '../src/lib/server/opportunity-intelligence-job-schema.js';
import { readRecordedRequirementCoverageOutcome } from '../src/lib/server/opportunity-requirement-coverage-provider.js';
import { fingerprintOpportunitySourceContent } from '../src/lib/server/opportunity-source-content.js';
import { getCollection } from '../src/lib/server/smrt.js';

const fixturePath = process.env.IOLAUS_E2E_FIXTURE;
if (
  !fixturePath ||
  process.env.SMRT_APP_ID !== 'iolaus-e2e' ||
  process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1'
)
  throw new Error(
    'Source coverage helper requires its disposable opt-in runtime',
  );
const root = realpathSync(dirname(fixturePath));
if (
  !basename(root).startsWith('iolaus-mobile-e2e-') ||
  realpathSync(String(process.env.SMRT_DATA_DIR)) !== `${root}/runtime`
)
  throw new Error(
    'Source coverage helper refused a non-fixture data directory',
  );
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  sourceCoverageOpportunities: Record<string, Record<string, string>>;
};
const [mode, id] = process.argv.slice(2);
if (
  !id ||
  !Object.values(fixture.sourceCoverageOpportunities).some((group) =>
    Object.values(group).includes(id),
  )
)
  throw new Error('Source coverage helper refused a non-fictional record');
const db = await resolveDatabase(getDbConfig());
if (!(await getOpportunityIntelligenceJobDedupeStatus(db)).activeIndexPresent)
  throw new Error(
    'Fixture migration did not install the native intelligence dedupe index',
  );
const opportunities = await getCollection('Opportunity');
const native = await opportunities.get(id);
if (!native) throw new Error('Fictional source posting missing');
const posting = native as unknown as Record<string, unknown>;
const jobs = async () =>
  (
    await db.query(
      'SELECT id, method, status, tenant_id, args, attempts, last_error FROM _smrt_jobs WHERE object_id = ? ORDER BY created_at, id',
      [id],
    )
  ).rows ?? [];

if (mode === 'revise') {
  const source = JSON.parse(String(posting.sourceContentJson)) as Record<
    string,
    unknown
  >;
  source.descriptionRaw = `${String(source.descriptionRaw)}\nYou must preserve source version two in this fictional local QA role.`;
  Object.assign(native, {
    descriptionRaw: source.descriptionRaw,
    sourceContentJson: JSON.stringify(source),
    sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
    sourceContentVersion: Number(posting.sourceContentVersion) + 1,
  });
  await native.save();
} else if (mode === 'service') {
  const before = await jobs();
  if (
    !before.some((row) => ['pending', 'running'].includes(String(row.status)))
  )
    throw new Error('No action-created native fixture job to service');
  const runner = new TaskRunner({
    concurrency: 1,
    queues: ['opportunity-intelligence'],
    pollInterval: 100,
    idlePollInterval: 100,
    shutdownTimeout: 10_000,
    retention: false,
  });
  runner.on('runner:error', (error) =>
    console.error('Fixture native runner:', error.message),
  );
  runner.on('job:failed', (job, error) =>
    console.error('Fixture native job failed:', job.id, error.message),
  );
  await runner.initialize(db);
  await runner.start();
  try {
    const deadline = Date.now() + 120_000;
    let empty = 0;
    while (Date.now() < deadline) {
      const active = (await jobs()).some((row) =>
        ['pending', 'running'].includes(String(row.status)),
      );
      empty = active ? 0 : empty + 1;
      if (empty >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (
      (await jobs()).some((row) =>
        ['pending', 'running'].includes(String(row.status)),
      )
    )
      throw new Error('Native source/private fixture queue did not settle');
  } finally {
    await runner.stop();
  }
} else if (mode !== 'inspect')
  throw new Error('Unknown source coverage fixture mode');

const current = await opportunities.get(id);
if (!current) throw new Error('Fictional source posting vanished');
const record = current as unknown as Record<string, unknown>;
const receipts =
  (
    await db.query(
      'SELECT feature, status, tenant_id, owner_user_id, candidate_profile_id, owner_request_id, input_fingerprint, output_json FROM opportunity_intelligence_results WHERE opportunity_id = ? ORDER BY created_at',
      [id],
    )
  ).rows ?? [];
const requests =
  (
    await db.query(
      'SELECT request_id, agent_run_id, feature, status, input_fingerprint, content_fingerprint, accounting_basis, actual_total_tokens, provider_request_id, error_code, duration_ms FROM opportunity_intelligence_requests WHERE opportunity_id = ? ORDER BY created_at',
      [id],
    )
  ).rows ?? [];
const agentRuns =
  (
    await db.query(
      'SELECT id, status, error, tenant_id, owner_user_id, candidate_profile_id, intelligence_actual_calls, intelligence_actual_input_tokens, intelligence_actual_output_tokens, intelligence_actual_spend_micros FROM agent_runs WHERE opportunity_id = ? ORDER BY created_at',
      [id],
    )
  ).rows ?? [];
const assessments =
  (
    await db.query(
      'SELECT id, tenant_id, owner_user_id, candidate_profile_id, source_content_fingerprint, source_content_version, candidate_material_fingerprint, status FROM opportunity_assessments WHERE opportunity_id = ?',
      [id],
    )
  ).rows ?? [];
console.log(
  `IOLAUS_E2E_RESULT:${JSON.stringify({ jobs: await jobs(), receipts, requests, agentRuns, assessments, posting: { id, sourceContentFingerprint: record.sourceContentFingerprint, sourceContentVersion: record.sourceContentVersion, preparedPostingJson: record.preparedPostingJson }, coverage: await readRecordedRequirementCoverageOutcome(id, record), nativeDedupeIndex: true })}`,
);
process.exit(0);
