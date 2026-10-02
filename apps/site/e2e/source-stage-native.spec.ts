import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test as base, expect, type TestInfo } from '@playwright/test';

type Json = Record<string, unknown>;
interface Snapshot {
  record: Json & {
    preparedPostingJson: {
      requirementCoverage?: { requirements: Json[]; audit?: Json };
      requirementCoverageSourceExtraction?: Json;
      requirementCoverageEvidenceAudit?: Json;
    };
  };
  jobs: Array<{
    id: string;
    method: string;
    status: string;
    tenant_id: string;
    args: string | Json;
    attempts: number;
    last_error: string | null;
  }>;
  receipts: Json[];
  requests: Json[];
  agentRuns: Json[];
  assessments: Json[];
  applications: Json[];
  evaluationScores: Json[];
  tasks: Json[];
  coverage: { status: string; reason?: string };
  eligibility?: { evidence: Json; sourceContext: Json };
  partial?: {
    mode: string;
    fingerprint: string;
    acceptedRequirements: Json[];
    unresolvedClauses: Json[];
    audit: Json;
  };
}
interface Result {
  scenario: string;
  id: string;
  owner: { tenantId: string; userId: string; profileId: string };
  selectedRequestId: string;
  afterExtraction: Snapshot;
  exact?: {
    inputFingerprint?: string;
    request: { state: Json; questions: Record<string, Json> };
    preflight: {
      fits: boolean;
      requestBytes: number;
      maxOutputTokens: number;
      reservedTokens: number;
      predicates: number;
    };
  };
  retryEventStart: number;
  refusal: string;
  providerEvents: Array<{
    kind: string;
    request: Json;
    job?: { id: string; status: string; method: string; args: string | Json };
    failed: boolean;
  }>;
  final: Snapshot;
  verified?: { complete: boolean };
  afterEvidence?: Snapshot;
  privateEnqueue?: Json;
  candidateBefore?: { fingerprint: string; sources: Json[] };
  privateRefusal?: string;
  privateEventStart?: number;
  privateProjection?: Json;
  privateProjectionReload?: Json;
  privateProjectionAfterForge?: Json;
  privateProjectionAfterForgeAttempted?: boolean;
  sourceEligibilityProjection?: Json;
  screenEnqueue?: Json;
  screenRefusal?: string;
  screenReceipt?: Json;
}
const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies are destructured.
  baseURL: async ({}, use) => {
    await use(process.env.IOLAUS_E2E_ORIGIN);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies are destructured.
  storageState: async ({}, use) => {
    await use(process.env.IOLAUS_E2E_AUTH);
  },
});
async function nativeStage(scenario: string, info: TestInfo): Promise<Result> {
  const path = process.env.IOLAUS_E2E_RUNTIME_ENVIRONMENT;
  if (!path)
    throw new Error('Source stage requires isolated runtime environment');
  let stdout = '';
  try {
    ({ stdout } = await promisify(execFile)(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('e2e/source-stage-runtime.ts'),
        scenario,
      ],
      {
        env: JSON.parse(readFileSync(path, 'utf8')) as NodeJS.ProcessEnv,
        timeout: 160_000,
        maxBuffer: 20_000_000,
      },
    ));
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    await info.attach('source-stage-native-failure', {
      body: Buffer.from((failure.stdout ?? '') + '\n' + (failure.stderr ?? '')),
      contentType: 'text/plain',
    });
    throw error;
  }
  const line = stdout
    .split('\n')
    .find((value) => value.startsWith('IOLAUS_SOURCE_STAGE_RESULT:'));
  if (!line) throw new Error('Native source stage result missing');
  const { resultPath } = JSON.parse(
    line.slice('IOLAUS_SOURCE_STAGE_RESULT:'.length),
  ) as { resultPath: string };
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Result;
  const target = info.outputPath(scenario + '-native-evidence.json');
  writeFileSync(target, JSON.stringify(result, null, 2), { mode: 0o600 });
  chmodSync(info.outputDir, 0o700);
  chmodSync(target, 0o600);
  await info.attach('source-stage-native-evidence', {
    path: target,
    contentType: 'application/json',
  });
  return result;
}
function parsed(value: string | Json): Json {
  return typeof value === 'string' ? (JSON.parse(value) as Json) : value;
}
function noPrivateWrites(result: Result) {
  expect(result.final.assessments).toHaveLength(0);
  expect(result.final.applications).toHaveLength(0);
  for (const receipt of result.final.receipts) {
    expect(receipt.tenant_id ?? '').toBe('');
    expect(receipt.owner_user_id ?? '').toBe('');
    expect(receipt.candidate_profile_id ?? '').toBe('');
  }
  const payload = JSON.stringify({
    events: result.providerEvents.map((row) => row.request),
    checkpoint: result.final.record.preparedPostingJson,
  });
  for (const identity of [
    result.owner.tenantId,
    result.owner.userId,
    result.owner.profileId,
  ])
    expect(payload).not.toContain(identity);
}
function actualCheckpoint(result: Result) {
  expect(result.afterExtraction.jobs).toHaveLength(1);
  expect(result.afterExtraction.jobs[0]).toMatchObject({
    method: 'prepareAssessmentCoverage',
    status: 'completed',
    tenant_id: result.owner.tenantId,
    attempts: 1,
  });
  expect(
    parsed(result.afterExtraction.jobs[0].args).sourceCoverageStage,
  ).toMatchObject({
    stage: 'extract',
    contract: 'native-source-coverage-stage/v1',
  });
  expect(result.providerEvents[0]).toMatchObject({
    kind: 'extraction',
    request: { model: 'openai/gpt-6-luna' },
    job: {
      id: result.afterExtraction.jobs[0].id,
      method: 'prepareAssessmentCoverage',
      status: 'running',
    },
  });
  expect(result.afterExtraction.receipts).toHaveLength(1);
  expect(result.afterExtraction.receipts[0]).toMatchObject({
    owner_request_id: result.selectedRequestId,
    feature: 'opportunity-extraction-chunk-1',
    status: 'completed',
    model: 'openai/gpt-6-luna',
  });
  expect(result.afterExtraction.requests).toHaveLength(1);
  expect(result.afterExtraction.requests[0]).toMatchObject({
    request_id: result.selectedRequestId,
    status: 'succeeded',
    accounting_basis: 'actual',
    actual_total_tokens: 10096,
    reserved_input_tokens: 6000,
    requested_max_output_tokens: 4096,
  });
  expect(result.afterExtraction.record.title).toBe(
    'Fictional staged source ' + result.scenario,
  );
  expect(result.afterExtraction.record.workMode).toBe(
    result.scenario.startsWith('captured-') ? 'remote' : '',
  );
  expect(result.afterExtraction.record.employmentType).toBe('');
  expect(result.afterExtraction.record.recomputedPreparedFingerprint).toBe(
    result.afterExtraction.record.preparedPostingFingerprint,
  );
  const saved = result.afterExtraction.record.preparedPostingJson;
  expect(saved.requirementCoverage?.requirements.length).toBeGreaterThan(0);
  expect(saved.requirementCoverage?.audit).toBeUndefined();
  expect(saved.requirementCoverageSourceExtraction).toMatchObject({
    version: 'opportunity-source-extraction-checkpoint/v1',
    requestIds: [result.selectedRequestId],
    reservation: { calls: 1, reservedTokens: 10096 },
  });
}

test.beforeEach(() => {
  test.skip(
    process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1',
    'Explicit fictional loopback transport and isolated native SQLite runtime required',
  );
  test.setTimeout(180_000);
});

test('native JEV-first screen excludes cited accountant duties before Luna or human review', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('screen-mismatch', info);
  expect(result.screenRefusal).toBe('');
  expect(result.providerEvents.map((event) => event.kind)).toEqual(['screen']);
  const screen = result.providerEvents[0];
  expect(screen.request.model).toBe('jev-latest');
  expect(screen.job).toMatchObject({
    method: 'prepareAssessmentCoverage',
    status: 'running',
  });
  expect(Object.keys(screen.request.questions)).toHaveLength(14);
  expect(result.final.requests).toHaveLength(1);
  expect(result.final.requests[0]).toMatchObject({
    feature: 'opportunity-screening',
    status: 'succeeded',
    accounting_basis: 'actual',
    tenant_id: result.owner.tenantId,
    owner_user_id: result.owner.userId,
    candidate_profile_id: result.owner.profileId,
  });
  expect(
    Number(result.final.requests[0].requested_max_output_tokens),
  ).toBeGreaterThan(0);
  expect(
    Number(result.final.requests[0].requested_max_output_tokens),
  ).toBeLessThanOrEqual(4096);
  expect(result.screenReceipt).toMatchObject({
    outcome: 'clear_mismatch',
    requestId: result.final.requests[0].request_id,
    agentRunId: result.final.requests[0].agent_run_id,
    screen: {
      mismatches: ['role_mismatch'],
      plausiblyRelevant: false,
      evidence: [
        expect.objectContaining({
          dimension: 'role_mismatch',
          witness: expect.objectContaining({
            text: expect.stringMatching(/tax returns|financial statements/iu),
          }),
        }),
      ],
    },
  });
  expect(result.final.receipts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        owner_request_id: result.screenReceipt?.requestId,
        feature: 'opportunity-screening',
        status: 'completed',
        output_schema_version: 'opportunity-screening/v1-jev-first',
        tenant_id: result.owner.tenantId,
        owner_user_id: result.owner.userId,
        candidate_profile_id: result.owner.profileId,
      }),
    ]),
  );
  expect(result.final.assessments).toHaveLength(0);
  expect(result.final.tasks).toHaveLength(0);
  expect(result.final.applications).toHaveLength(0);
  expect(result.final.evaluationScores).toHaveLength(0);
});

test('native JEV-first screen carries an accounting-company software role into Luna on the same run', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('screen-relevant', info);
  expect(result.screenRefusal).toBe('');
  expect(result.providerEvents[0].kind).toBe('screen');
  expect(result.providerEvents[0].request.model).toBe('jev-latest');
  expect(
    result.providerEvents.some((event) => event.kind === 'extraction'),
  ).toBe(true);
  expect(['potentially_relevant', 'uncertain']).toContain(
    result.screenReceipt?.outcome,
  );
  expect(result.screenReceipt).toMatchObject({
    screen: {
      plausiblyRelevant: true,
      mismatches: [],
      holdReasons: [],
      evidence: [
        expect.objectContaining({
          dimension: 'role_relevant',
          witness: expect.objectContaining({
            text: expect.stringMatching(/TypeScript|API integrations/u),
          }),
        }),
      ],
    },
  });
  const screenRequest = result.final.requests.find(
    (row) => row.feature === 'opportunity-screening',
  );
  const extractionRequest = result.final.requests.find(
    (row) => row.feature === 'opportunity-extraction-chunk-1',
  );
  expect(screenRequest).toMatchObject({
    request_id: result.screenReceipt?.requestId,
    status: 'succeeded',
    accounting_basis: 'actual',
  });
  expect(extractionRequest).toMatchObject({
    status: 'succeeded',
    accounting_basis: 'actual',
    agent_run_id: screenRequest?.agent_run_id,
  });
  expect(
    result.final.requests.filter((row) => Number(row.actual_total_tokens) > 0)
      .length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    new Set(result.final.requests.map((row) => row.agent_run_id)).size,
  ).toBe(1);
  expect(
    result.final.requests.reduce(
      (sum, row) =>
        sum +
        Number(row.reserved_input_tokens) +
        Number(row.requested_max_output_tokens),
      0,
    ),
  ).toBeLessThanOrEqual(80_000);
  expect(
    result.final.requests.reduce(
      (sum, row) => sum + Number(row.reserved_spend_micros),
      0,
    ),
  ).toBeLessThanOrEqual(100_000);
  expect(
    result.final.agentRuns.filter(
      (row) => Number(row.intelligence_actual_calls) > 0,
    ),
  ).toHaveLength(1);
});

test('native JEV-first screen holds invalid typed candidate material before provider transport', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('screen-invalid-material', info);
  expect(result.providerEvents).toHaveLength(0);
  expect(result.final.requests).toHaveLength(0);
  expect(result.final.receipts).toHaveLength(0);
  expect(result.final.assessments).toHaveLength(0);
  expect(result.final.tasks).toHaveLength(0);
  expect(result.final.applications).toHaveLength(0);
  expect(result.final.evaluationScores).toHaveLength(0);
  expect(result.final.jobs).toHaveLength(1);
  expect(result.final.jobs[0].method).toBe('prepareAssessmentCoverage');
  expect(result.screenReceipt).toBeUndefined();
});

test('native source stages retain a governed unverified checkpoint when exact audit is oversized; detail stays safely unavailable and actionable', async ({
  page,
  baseURL,
}, info) => {
  const result = await nativeStage('oversize', info);
  actualCheckpoint(result);
  expect(result.exact?.preflight.fits).toBe(false);
  expect(result.exact?.preflight.requestBytes).toBeGreaterThan(64 * 1024);
  expect(result.providerEvents.map((row) => row.kind)).toEqual(['extraction']);
  expect(result.final.requests).toEqual(result.afterExtraction.requests);
  expect(result.final.receipts).toEqual(result.afterExtraction.receipts);
  expect(result.final.record.preparedPostingJson).toEqual(
    result.afterExtraction.record.preparedPostingJson,
  );
  expect(result.final.jobs).toHaveLength(2);
  expect(result.final.jobs[1]).toMatchObject({
    method: 'prepareAssessmentCoverage',
    status: 'failed',
    attempts: 1,
  });
  expect(result.final.jobs[1].last_error).toMatch(
    /checkpoint retained.*lifecycle ceiling/i,
  );
  expect(result.verified?.complete).toBe(false);
  noPrivateWrites(result);
  if (!baseURL) throw new Error('Isolated E2E origin missing');
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  await page.goto('/admin/opportunities/' + result.id + '/');
  const assessment = page.getByRole('region', {
    name: 'Your opportunity assessment',
  });
  await expect(assessment).toContainText('Unknown');
  await expect(assessment).toContainText('Match assessment unavailable');
  await expect(assessment).not.toContainText('Match score:');
  await expect(
    page.getByRole('button', { name: 'Assess', exact: true }),
  ).toBeEnabled();
  await assessment.scrollIntoViewIfNeeded();
  await assessment.screenshot({
    path: info.outputPath('staged-audit-denied-safe-assessment.png'),
  });
  await page.screenshot({
    path: info.outputPath('staged-audit-denied-safe-detail.png'),
    fullPage: true,
  });
});

test('native selected actual extraction receipt resumes exact v6 audit with zero new Luna, one JEV and original lifecycle accounting', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('fitting', info);
  actualCheckpoint(result);
  expect(result.refusal).toBe('');
  expect(result.exact?.preflight.fits).toBe(true);
  expect(result.providerEvents.map((row) => row.kind)).toEqual([
    'extraction',
    'audit',
  ]);
  const event = result.providerEvents[1];
  expect(event.request.model).toBe('jev-latest');
  expect(event.job).toMatchObject({
    id: result.final.jobs[1].id,
    method: 'prepareAssessmentCoverage',
    status: 'running',
  });
  expect(event.request.state).toEqual(result.exact?.request.state);
  const questions = Object.fromEntries(
    Object.entries(result.exact!.request.questions).map(([key, value]) => {
      expect(value.type).toBe('predicate');
      return [key, { ...value, type: 'noul' }];
    }),
  );
  expect(event.request.questions).toEqual(questions);
  expect(result.final.jobs[1]).toMatchObject({
    status: 'completed',
    attempts: 1,
  });
  expect(parsed(result.final.jobs[1].args).sourceCoverageStage).toMatchObject({
    stage: 'audit_completed_extraction',
    extractionRequestId: result.selectedRequestId,
  });
  expect(
    result.final.requests.filter((row) =>
      String(row.feature).startsWith('opportunity-extraction'),
    ),
  ).toHaveLength(1);
  expect(result.final.requests).toHaveLength(2);
  expect(
    new Set(result.final.requests.map((row) => row.agent_run_id)).size,
  ).toBe(1);
  expect(
    result.final.agentRuns.filter(
      (row) => Number(row.intelligence_actual_calls) > 0,
    ),
  ).toHaveLength(1);
  expect(
    result.final.requests.reduce(
      (sum, row) =>
        sum +
        Number(row.reserved_input_tokens) +
        Number(row.requested_max_output_tokens),
      0,
    ),
  ).toBe(10096 + result.exact!.preflight.reservedTokens);
  expect(result.final.requests.length).toBeLessThanOrEqual(4);
  expect(
    result.final.requests.reduce(
      (sum, row) =>
        sum +
        Number(row.reserved_input_tokens) +
        Number(row.requested_max_output_tokens),
      0,
    ),
  ).toBeLessThanOrEqual(80_000);
  expect(
    result.final.requests.reduce(
      (sum, row) => sum + Number(row.reserved_spend_micros),
      0,
    ),
  ).toBeLessThanOrEqual(100_000);
  const auditId =
    result.final.record.preparedPostingJson.requirementCoverage?.audit
      ?.requestId;
  expect(auditId).toEqual(expect.any(String));
  expect(auditId).not.toBe(result.selectedRequestId);
  expect(
    result.final.receipts.find((row) => row.owner_request_id === auditId),
  ).toMatchObject({
    feature: 'opportunity-source-requirement-coverage',
    status: 'completed',
    model: 'jev-latest',
    output_schema_version: 'requirement-coverage-audit/v6-direct-literal',
  });
  expect(result.verified?.complete).toBe(true);
  expect(
    result.final.record.preparedPostingJson.requirementCoverage?.requirements,
  ).toEqual(
    result.afterExtraction.record.preparedPostingJson.requirementCoverage
      ?.requirements,
  );
  noPrivateWrites(result);
});

for (const scenario of [
  'orphan',
  'foreign',
  'conservative',
  'stale',
  'changed-contract',
  'budget-history',
]) {
  test(
    'native staged audit denies ' +
      scenario +
      ' identity before provider and retains checkpoint',
    async ({ baseURL: _baseURL }, info) => {
      const result = await nativeStage(scenario, info);
      actualCheckpoint(result);
      expect(result.providerEvents.slice(result.retryEventStart)).toHaveLength(
        0,
      );
      expect(result.final.record.preparedPostingJson).toEqual(
        result.afterExtraction.record.preparedPostingJson,
      );
      expect(result.final.requests).toHaveLength(1);
      expect(result.verified?.complete).toBe(false);
      if (['stale', 'changed-contract', 'budget-history'].includes(scenario)) {
        expect(result.final.jobs).toHaveLength(2);
        expect(result.final.jobs[1]).toMatchObject({
          status: 'failed',
          attempts: 1,
        });
        expect(result.final.jobs[1].last_error).toMatch(
          scenario === 'stale'
            ? /source.*not current/i
            : scenario === 'changed-contract'
              ? /explicit native operator intent/i
              : /checkpoint retained.*lifecycle ceiling/i,
        );
      } else {
        expect(result.refusal).toMatch(
          /receipt|unattested|accounting|contract/i,
        );
        expect(result.final.jobs).toHaveLength(1);
      }
      // The foreign receipt is deliberately adversarial; the remaining native
      // checkpoint/provider payload must still contain no candidate identities.
      expect(result.final.assessments).toHaveLength(0);
      expect(result.final.applications).toHaveLength(0);
    },
  );
}

test('native failed extraction identity cannot obtain a fresh paid retry or reset run', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('failed-retry', info);
  expect(result.providerEvents).toHaveLength(1);
  expect(result.providerEvents[0]).toMatchObject({
    kind: 'extraction',
    failed: true,
  });
  expect(result.final.requests).toHaveLength(1);
  expect(result.final.requests[0].status).not.toBe('succeeded');
  expect(result.refusal).toMatch(
    /prior|terminal|recorded|review|retry|identity/i,
  );
  expect(result.final.jobs).toHaveLength(1);
  expect(result.final.jobs[0]).toMatchObject({
    method: 'prepareAssessmentCoverage',
    status: 'failed',
    attempts: 1,
  });
  expect(
    result.final.agentRuns.filter(
      (row) => Number(row.intelligence_actual_calls) > 0,
    ),
  ).toHaveLength(1);
  noPrivateWrites(result);
});

test('native completed extraction resumes one decomposed evidence request on the original lifecycle and retains partial support', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('evidence-fitting', info);
  actualCheckpoint(result);
  expect(result.refusal).toBe('');
  expect(result.exact?.preflight.fits).toBe(true);
  expect(result.providerEvents.map((row) => row.kind)).toEqual([
    'extraction',
    'audit',
  ]);
  const decision = result.providerEvents[1];
  expect(decision.request).toMatchObject({ model: 'jev-latest', state: {} });
  expect(decision.job).toMatchObject({
    id: result.final.jobs[1].id,
    method: 'prepareAssessmentCoverage',
    status: 'running',
  });
  expect(decision.request.state).toEqual(result.exact?.request.state);
  expect(decision.request.questions).toEqual(
    Object.fromEntries(
      Object.entries(result.exact!.request.questions).map(([key, value]) => [
        key,
        { ...value, type: 'noul' },
      ]),
    ),
  );
  expect(result.final.jobs[1]).toMatchObject({
    status: 'completed',
    attempts: 1,
  });
  expect(parsed(result.final.jobs[1].args).sourceCoverageStage).toMatchObject({
    contract: 'native-source-coverage-stage/v1',
    stage: 'evidence_completed_extraction',
    auditContract: 'requirement-evidence-audit/v1-decomposed',
    extractionRequestId: result.selectedRequestId,
  });
  expect(result.final.requests).toHaveLength(2);
  expect(result.final.requests[1]).toMatchObject({
    feature: 'opportunity-source-requirement-evidence',
    status: 'succeeded',
    accounting_basis: 'actual',
  });
  expect(
    new Set(result.final.requests.map((row) => row.agent_run_id)).size,
  ).toBe(1);
  expect(
    result.final.agentRuns.filter(
      (row) => Number(row.intelligence_actual_calls) > 0,
    ),
  ).toHaveLength(1);
  const reservation = result.final.requests.reduce(
    (sum, row) =>
      sum +
      Number(row.reserved_input_tokens) +
      Number(row.requested_max_output_tokens),
    0,
  );
  expect(reservation).toBe(result.exact!.preflight.reservedTokens);
  expect(reservation).toBeLessThanOrEqual(80_000);
  expect(
    result.final.requests.reduce(
      (sum, row) => sum + Number(row.reserved_spend_micros),
      0,
    ),
  ).toBeLessThanOrEqual(100_000);
  const audit =
    result.final.record.preparedPostingJson.requirementCoverageEvidenceAudit;
  expect(audit).toMatchObject({
    version: 'requirement-evidence-audit/v1-decomposed',
    requestId: result.final.requests[1].request_id,
    fullCoverage: false,
  });
  expect(
    result.final.receipts.find(
      (row) => row.owner_request_id === audit?.requestId,
    ),
  ).toMatchObject({
    feature: 'opportunity-source-requirement-evidence',
    status: 'completed',
    model: 'jev-latest',
    output_schema_version: 'requirement-evidence-audit/v1-decomposed',
  });
  expect(
    result.final.record.preparedPostingJson.requirementCoverage?.audit,
  ).toBeUndefined();
  expect(
    result.final.record.preparedPostingJson.requirementCoverage?.requirements,
  ).toEqual(
    result.afterExtraction.record.preparedPostingJson.requirementCoverage
      ?.requirements,
  );
  expect(result.final.partial).toMatchObject({ mode: 'partial' });
  expect(result.final.partial?.acceptedRequirements).toHaveLength(1);
  expect(result.final.partial?.unresolvedClauses).toHaveLength(1);
  expect(result.final.partial?.audit.requestId).toBe(audit?.requestId);
  expect(result.verified?.complete).toBe(false);
  noPrivateWrites(result);
});

test('native V3 eligibility resumes the completed GLOBAL extraction on its original lifecycle', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('eligibility-fitting', info);
  actualCheckpoint(result);
  if (!result.exact) throw new Error('V3 exact request missing');
  expect(result.refusal).toBe('');
  expect(result.exact.preflight.fits).toBe(true);
  expect(result.providerEvents.map((row) => row.kind)).toEqual([
    'extraction',
    'audit',
  ]);
  const decision = result.providerEvents[1];
  expect(decision.request.model).toBe('jev-latest');
  expect(decision.job).toMatchObject({
    id: result.final.jobs[1].id,
    method: 'prepareAssessmentCoverage',
    status: 'running',
  });
  expect(decision.request.state).toEqual(result.exact.request.state);
  expect(decision.request.questions).toEqual(
    Object.fromEntries(
      Object.entries(result.exact.request.questions).map(([key, value]) => [
        key,
        value.type === 'predicate' ? { ...value, type: 'noul' } : value,
      ]),
    ),
  );
  expect(Object.keys(result.exact.request.questions)).toContain(
    'source_eligibility__coverage__authorization',
  );
  expect(result.final.jobs[1]).toMatchObject({
    status: 'completed',
    attempts: 1,
  });
  expect(parsed(result.final.jobs[1].args).sourceCoverageStage).toMatchObject({
    stage: 'evidence_completed_extraction',
    auditContract: 'requirement-evidence-audit/v3-source-eligibility',
    extractionRequestId: result.selectedRequestId,
  });
  expect(result.final.requests).toHaveLength(2);
  expect(result.final.requests[1]).toMatchObject({
    feature: 'opportunity-source-requirement-evidence',
    status: 'succeeded',
    accounting_basis: 'actual',
  });
  expect(
    new Set(result.final.requests.map((row) => row.agent_run_id)).size,
  ).toBe(1);
  expect(
    result.final.agentRuns.filter(
      (row) => Number(row.intelligence_actual_calls) > 0,
    ),
  ).toHaveLength(1);
  expect(
    result.final.requests.reduce(
      (sum, row) =>
        sum +
        Number(row.reserved_input_tokens) +
        Number(row.requested_max_output_tokens),
      0,
    ),
  ).toBe(result.exact.preflight.reservedTokens);
  expect(
    result.final.requests.reduce(
      (sum, row) =>
        sum +
        Number(row.reserved_input_tokens) +
        Number(row.requested_max_output_tokens),
      0,
    ),
  ).toBeLessThanOrEqual(80_000);
  expect(
    result.final.requests.reduce(
      (sum, row) => sum + Number(row.reserved_spend_micros),
      0,
    ),
  ).toBeLessThanOrEqual(100_000);
  const audit =
    result.final.record.preparedPostingJson.requirementCoverageEvidenceAudit;
  expect(audit).toMatchObject({
    version: 'requirement-evidence-audit/v3-source-eligibility',
    requestId: result.final.requests[1].request_id,
    inputFingerprint: result.exact.inputFingerprint,
  });
  expect(
    result.final.receipts.find(
      (row) => row.owner_request_id === audit?.requestId,
    ),
  ).toMatchObject({
    feature: 'opportunity-source-requirement-evidence',
    status: 'completed',
    model: 'jev-latest',
    output_schema_version: 'requirement-evidence-audit/v3-source-eligibility',
  });
  expect(result.final.eligibility).toMatchObject({
    evidence: {
      version: 'source-eligibility-facts/v1',
      requestId: audit?.requestId,
      aggregateFingerprint: result.exact.inputFingerprint,
      sourceContentFingerprint: result.final.record.sourceContentFingerprint,
      sourceContentVersion: result.final.record.sourceContentVersion,
      coverage: { authorization: true, geography: true, workArrangement: true },
    },
    sourceContext: {
      sourceContentFingerprint: result.final.record.sourceContentFingerprint,
      sourceContentVersion: result.final.record.sourceContentVersion,
    },
  });
  expect(String(result.final.eligibility?.sourceContext.sourceText)).toContain(
    'Remote role.',
  );
  expect(result.final.eligibility?.evidence.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'remote_available',
        citations: expect.arrayContaining([
          expect.objectContaining({
            clauseId: expect.any(String),
            hash: expect.any(String),
          }),
        ]),
      }),
    ]),
  );
  expect(
    result.final.record.preparedPostingJson.requirementCoverage?.audit,
  ).toBeUndefined();
  expect(
    result.final.record.preparedPostingJson.requirementCoverage?.requirements,
  ).toEqual(
    result.afterExtraction.record.preparedPostingJson.requirementCoverage
      ?.requirements,
  );
  expect(result.verified?.complete).toBe(false);
  noPrivateWrites(result);
});

test('native V4 captured-source recovery audits one completed extraction and exposes Canada remote fields absent from the body', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('captured-fitting', info);
  actualCheckpoint(result);
  if (!result.exact) throw new Error('V4 exact request missing');
  const source = parsed(
    String(result.afterExtraction.record.sourceContentJson),
  );
  expect(source.descriptionRaw).not.toMatch(/Canada|remote/i);
  expect(source).toMatchObject({
    locationNotes: 'Remote in Canada',
    workMode: 'remote',
  });
  const extracted =
    result.afterExtraction.record.preparedPostingJson.requirementCoverage;
  expect(extracted?.requirements.length).toBeGreaterThan(0);
  expect((extracted as Json).clauses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'Role Summary', kind: 'body' }),
    ]),
  );
  expect((extracted as Json).dispositions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'nonrequirement',
        exclusionRule: 'section_heading',
      }),
    ]),
  );
  expect(result.refusal).toBe('');
  expect(result.exact.preflight.fits).toBe(true);
  expect(result.providerEvents.map((row) => row.kind)).toEqual([
    'extraction',
    'audit',
  ]);
  const decision = result.providerEvents[1];
  expect(decision.request.model).toBe('jev-latest');
  expect(decision.job).toMatchObject({
    id: result.final.jobs[1].id,
    method: 'prepareAssessmentCoverage',
    status: 'running',
  });
  expect(decision.request.state).toEqual(result.exact.request.state);
  expect(decision.request.state.sourceEligibilityCapturedFields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'source-field:locationNotes',
        path: 'sourceContentJson.locationNotes',
        text: 'Remote in Canada',
      }),
      expect.objectContaining({
        id: 'source-field:workMode',
        path: 'sourceContentJson.workMode',
        text: 'remote',
      }),
    ]),
  );
  expect(Object.keys(result.exact.request.questions)).toContain(
    'source_eligibility__work_country_allowed__CA',
  );
  expect(result.final.jobs[1]).toMatchObject({
    status: 'completed',
    attempts: 1,
  });
  expect(parsed(result.final.jobs[1].args).sourceCoverageStage).toMatchObject({
    stage: 'evidence_completed_extraction',
    auditContract: 'requirement-evidence-audit/v4-captured-source-recovery',
    extractionRequestId: result.selectedRequestId,
  });
  expect(result.final.requests).toHaveLength(2);
  expect(result.final.requests[1]).toMatchObject({
    feature: 'opportunity-source-requirement-evidence',
    status: 'succeeded',
    accounting_basis: 'actual',
  });
  expect(
    new Set(result.final.requests.map((row) => row.agent_run_id)).size,
  ).toBe(1);
  expect(
    result.final.agentRuns.filter(
      (row) => Number(row.intelligence_actual_calls) > 0,
    ),
  ).toHaveLength(1);
  const reservation = result.final.requests.reduce(
    (sum, row) =>
      sum +
      Number(row.reserved_input_tokens) +
      Number(row.requested_max_output_tokens),
    0,
  );
  expect(reservation).toBe(result.exact.preflight.reservedTokens);
  expect(reservation).toBeLessThanOrEqual(80_000);
  expect(
    result.final.requests.reduce(
      (sum, row) => sum + Number(row.reserved_spend_micros),
      0,
    ),
  ).toBeLessThanOrEqual(100_000);
  const audit =
    result.final.record.preparedPostingJson.requirementCoverageEvidenceAudit;
  expect(audit).toMatchObject({
    version: 'requirement-evidence-audit/v4-captured-source-recovery',
    requestId: result.final.requests[1].request_id,
    inputFingerprint: result.exact.inputFingerprint,
    fullCoverage: false,
    capturedSource: { extractionRequestId: result.selectedRequestId },
    recovery: { extractionRequestId: result.selectedRequestId },
  });
  expect((audit?.recovery as Json | undefined)?.unresolvedClauses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: 'unsupported_nonrequirement_exclusion',
      }),
    ]),
  );
  expect(
    result.final.receipts.find(
      (row) => row.owner_request_id === audit?.requestId,
    ),
  ).toMatchObject({
    feature: 'opportunity-source-requirement-evidence',
    status: 'completed',
    model: 'jev-latest',
    output_schema_version:
      'requirement-evidence-audit/v4-captured-source-recovery',
  });
  expect(result.final.eligibility).toMatchObject({
    evidence: {
      requestId: audit?.requestId,
      aggregateFingerprint: result.exact.inputFingerprint,
      sourceContentFingerprint: result.final.record.sourceContentFingerprint,
      sourceContentVersion: result.final.record.sourceContentVersion,
      capturedFieldsFingerprint: expect.any(String),
    },
    sourceContext: {
      sourceContentFingerprint: result.final.record.sourceContentFingerprint,
      sourceContentVersion: result.final.record.sourceContentVersion,
      capturedFieldsFingerprint: expect.any(String),
    },
  });
  expect(result.final.eligibility?.evidence.capturedFieldsFingerprint).toBe(
    result.final.eligibility?.sourceContext.capturedFieldsFingerprint,
  );
  expect(result.final.eligibility?.evidence.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'work_country_allowed',
        citations: expect.arrayContaining([
          expect.objectContaining({
            source: 'captured_field',
            path: 'sourceContentJson.locationNotes',
            text: 'Remote in Canada',
          }),
        ]),
      }),
      expect.objectContaining({
        kind: 'remote_available',
        citations: expect.arrayContaining([
          expect.objectContaining({
            source: 'captured_field',
            path: 'sourceContentJson.workMode',
            text: 'remote',
          }),
        ]),
      }),
    ]),
  );
  expect(result.sourceEligibilityProjection).toMatchObject({
    sourceStatus: 'current',
    sourceContentFingerprint: result.final.record.sourceContentFingerprint,
    sourceContentVersion: result.final.record.sourceContentVersion,
  });
  expect(
    result.final.record.preparedPostingJson.requirementCoverage?.audit,
  ).toBeUndefined();
  expect(
    result.final.record.preparedPostingJson.requirementCoverage?.requirements,
  ).toEqual(extracted?.requirements);
  expect(result.verified?.complete).toBe(false);
  noPrivateWrites(result);
});

for (const variant of ['stale', 'foreign']) {
  test(`native V3 eligibility denies ${variant} source authority before provider transport`, async ({
    baseURL: _baseURL,
  }, info) => {
    const result = await nativeStage(`eligibility-${variant}`, info);
    actualCheckpoint(result);
    expect(result.providerEvents.slice(result.retryEventStart)).toHaveLength(0);
    expect(result.final.requests).toHaveLength(1);
    expect(result.final.eligibility).toBeUndefined();
    expect(
      result.final.record.preparedPostingJson.requirementCoverageEvidenceAudit,
    ).toBeUndefined();
    if (variant === 'stale') {
      expect(result.final.jobs[1]).toMatchObject({
        status: 'failed',
        attempts: 1,
      });
      expect(result.final.jobs[1].last_error).toMatch(/source.*not current/i);
    } else {
      expect(result.refusal).toMatch(/receipt|unattested|accounting|contract/i);
      expect(result.final.jobs).toHaveLength(1);
    }
    expect(result.verified?.complete).toBe(false);
    expect(result.final.assessments).toHaveLength(0);
  });
}

for (const variant of [
  'oversize',
  'orphan',
  'foreign',
  'conservative',
  'stale',
  'changed-contract',
  'budget-history',
]) {
  test(`native evidence stage rejects ${variant} before a second provider call`, async ({
    baseURL: _baseURL,
  }, info) => {
    const result = await nativeStage(`evidence-${variant}`, info);
    actualCheckpoint(result);
    expect(result.providerEvents.slice(result.retryEventStart)).toHaveLength(0);
    expect(result.final.requests).toHaveLength(1);
    expect(result.final.record.preparedPostingJson).toEqual(
      result.afterExtraction.record.preparedPostingJson,
    );
    expect(result.final.partial).toBeUndefined();
    expect(
      result.final.record.preparedPostingJson.requirementCoverageEvidenceAudit,
    ).toBeUndefined();
    expect(result.verified?.complete).toBe(false);
    if (['orphan', 'foreign', 'conservative'].includes(variant)) {
      expect(result.refusal).toMatch(/receipt|unattested|accounting|contract/i);
      expect(result.final.jobs).toHaveLength(1);
    } else {
      expect(result.final.jobs).toHaveLength(2);
      expect(result.final.jobs[1]).toMatchObject({
        status: 'failed',
        attempts: 1,
      });
      expect(result.final.jobs[1].last_error).toMatch(
        variant === 'stale'
          ? /source.*not current/i
          : variant === 'changed-contract'
            ? /explicit native operator intent/i
            : /checkpoint retained.*lifecycle ceiling/i,
      );
    }
    expect(result.final.assessments).toHaveLength(0);
    expect(result.final.applications).toHaveLength(0);
  });
}

test('native private partial job saves owned supported or uncertain evidence from the current GLOBAL source receipt', async ({
  baseURL: _baseURL,
}, info) => {
  const result = await nativeStage('private-fitting', info);
  actualCheckpoint(result);
  expect(result.refusal).toBe('');
  expect(result.privateRefusal).toBe('');
  expect(result.afterEvidence?.partial).toMatchObject({ mode: 'partial' });
  expect(result.afterEvidence?.partial?.acceptedRequirements).toHaveLength(1);
  expect(
    result.candidateBefore?.sources.some(
      (row) => row.kind === 'skill' && row.text === 'API integrations',
    ),
  ).toBe(true);
  expect(
    result.candidateBefore?.sources.some(
      (row) =>
        row.kind === 'candidate_profile' &&
        String(row.text).includes('maintained tested API integrations'),
    ),
  ).toBe(true);
  expect(result.privateEnqueue).toMatchObject({
    stage: 'private_assessment',
    sourceStatus: 'partial',
  });
  expect(result.providerEvents.map((row) => row.kind)).toEqual([
    'extraction',
    'audit',
    'private',
  ]);
  const privateEvent = result.providerEvents[2];
  expect(privateEvent.request.model).toBe('jev-latest');
  expect(privateEvent.request.state).toMatchObject({
    candidates: expect.any(Object),
  });
  expect(privateEvent.job).toMatchObject({
    id: result.privateEnqueue?.jobId,
    method: 'processIntelligence',
    status: 'running',
  });
  expect(result.final.jobs).toHaveLength(3);
  expect(result.final.jobs[2]).toMatchObject({
    id: result.privateEnqueue?.jobId,
    method: 'processIntelligence',
    status: 'completed',
    attempts: 1,
    tenant_id: result.owner.tenantId,
  });
  expect(parsed(result.final.jobs[2].args)).toMatchObject({
    modes: 'assessment',
    partialAssessmentEvidence: true,
  });
  expect(result.final.requests).toHaveLength(3);
  expect(result.final.requests[2]).toMatchObject({
    feature: 'opportunity-assessment-partial',
    status: 'succeeded',
    model: 'jev-latest',
    tenant_id: result.owner.tenantId,
    owner_user_id: result.owner.userId,
    candidate_profile_id: result.owner.profileId,
  });
  expect(result.final.requests[2].agent_run_id).not.toBe(
    result.final.requests[0].agent_run_id,
  );
  const privateReceipt = result.final.receipts.find(
    (row) => row.owner_request_id === result.final.requests[2].request_id,
  );
  expect(privateReceipt).toMatchObject({
    feature: 'opportunity-assessment-partial',
    status: 'completed',
    output_schema_version: 'opportunity-assessment-partial/v1',
    tenant_id: result.owner.tenantId,
    owner_user_id: result.owner.userId,
    candidate_profile_id: result.owner.profileId,
  });
  for (const publicReceipt of result.final.receipts.filter(
    (row) => row.feature !== 'opportunity-assessment-partial',
  )) {
    expect(publicReceipt).toMatchObject({
      tenant_id: '',
      owner_user_id: '',
      candidate_profile_id: '',
    });
    expect(String(publicReceipt.output_json)).not.toContain(
      'maintained tested API integrations',
    );
  }
  expect(result.final.assessments).toHaveLength(1);
  const assessment = result.final.assessments[0];
  expect(assessment).toMatchObject({
    tenant_id: result.owner.tenantId,
    owner_user_id: result.owner.userId,
    candidate_profile_id: result.owner.profileId,
    status: 'partial',
    match_readiness: 'needs_evidence',
    agent_run_id: result.final.requests[2].agent_run_id,
  });
  const privateResult = parsed(assessment.assessment_json as string);
  expect(privateResult).toMatchObject({
    mode: 'partial',
    matchReadiness: 'needs_evidence',
    requestId: result.final.requests[2].request_id,
    evidenceFingerprint: result.afterEvidence?.partial?.fingerprint,
  });
  expect((privateResult.requirements as Json[]).length).toBeGreaterThan(0);
  for (const row of privateResult.requirements as Json[])
    expect(['supported', 'uncertain']).toContain(row.support);
  expect(privateResult).not.toHaveProperty('overallScore');
  expect(privateResult).not.toHaveProperty('fitScore');
  expect(parsed(assessment.projection_json as string)).toEqual({
    mode: 'partial',
    matchReadiness: 'needs_evidence',
  });
  expect(result.privateProjection).toMatchObject({
    version: 'opportunity-assessment-partial-projection/v1',
    mode: 'partial',
    sourceStatus: 'current',
    criterionCount: 1,
    unresolvedSourceClauseCount: 1,
  });
  expect(result.privateProjectionReload).toEqual(result.privateProjection);
  const projectedRequirements = result.privateProjection?.requirements;
  expect(Array.isArray(projectedRequirements)).toBe(true);
  expect((projectedRequirements as Json[])[0]).toMatchObject({
    postingCitations: [
      expect.objectContaining({ excerpt: expect.any(String) }),
    ],
    candidateCitations: expect.arrayContaining([
      expect.objectContaining({ excerpt: expect.any(String) }),
    ]),
  });
  expect(result.privateProjection).not.toHaveProperty('fitScore');
  expect(result.privateProjection).not.toHaveProperty('eligibilityBucket');
  expect(result.privateProjectionAfterForgeAttempted).toBe(true);
  expect(result.privateProjectionAfterForge).toBeUndefined();
  expect(result.final.evaluationScores).toHaveLength(0);
  expect(result.final.tasks).toHaveLength(0);
  expect(result.final.applications).toHaveLength(0);
});

for (const variant of ['stale-source', 'stale-candidate', 'foreign-proof']) {
  test(`native private partial job denies ${variant} before private transport`, async ({
    baseURL: _baseURL,
  }, info) => {
    const result = await nativeStage(`private-${variant}`, info);
    actualCheckpoint(result);
    expect(result.afterEvidence?.partial?.acceptedRequirements).toHaveLength(1);
    expect(result.privateEnqueue).toMatchObject({
      stage: 'private_assessment',
      sourceStatus: 'partial',
    });
    expect(result.providerEvents.slice(result.privateEventStart)).toHaveLength(
      0,
    );
    expect(result.final.requests).toHaveLength(2);
    expect(result.final.assessments).toHaveLength(0);
    expect(result.final.evaluationScores).toHaveLength(0);
    expect(result.final.tasks).toHaveLength(0);
    expect(result.final.applications).toHaveLength(0);
    expect(result.privateProjection).toBeUndefined();
    expect(result.privateProjectionReload).toBeUndefined();
  });
}
