import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, type TestInfo, test } from '@playwright/test';

type Json = Record<string, unknown>;
interface RepairResult {
  scenario: string;
  repairJobId: string;
  replayJobId: string;
  replayEventStart: number;
  beforeReplay: {
    preparedPostingJson: {
      requirementCoverage: { audit: Json; requirements: Json[] };
    };
    receipts: Json[];
  };
  exactReplay: {
    request: { state: Json; questions: Json };
    expectedAudit: Json;
    repairRequestId: string;
    auditRequestId: string;
  };
  refusal: string;
  bootstrapEventCount: number;
  owner: { tenantId: string; userId: string; profileId: string };
  jobs: Array<{
    id: string;
    method: string;
    status: string;
    tenant_id: string;
    args: string | Json;
    last_error: string | null;
  }>;
  providerEvents: Array<{
    kind: string;
    request: Json;
    nativeRepairIntent?: { id: string; status: string; args: string | Json };
  }>;
  receipts: Json[];
  requests: Json[];
  assessments: Json[];
  beforePreparedJson: { requirementCoverage: { requirements: Json[] } };
  current: {
    preparedPostingJson: {
      requirementCoverage: { requirements: Json[]; audit?: Json };
    };
  };
  verified: { complete: boolean };
}
async function nativeRepair(
  scenario: string,
  info: TestInfo,
): Promise<RepairResult> {
  const path = process.env.IOLAUS_E2E_RUNTIME_ENVIRONMENT;
  if (!path)
    throw new Error('Native repair requires isolated runtime environment');
  let stdout = '';
  try {
    ({ stdout } = await promisify(execFile)(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('e2e/source-repair-runtime.ts'),
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
    await info.attach('native-repair-bootstrap-failure', {
      body: Buffer.from((failure.stdout ?? '') + '\n' + (failure.stderr ?? '')),
      contentType: 'text/plain',
    });
    throw error;
  }
  const line = stdout
    .split('\n')
    .find((value) => value.startsWith('IOLAUS_REPAIR_RESULT:'));
  if (!line) throw new Error('Native repair result missing');
  const result = JSON.parse(
    line.slice('IOLAUS_REPAIR_RESULT:'.length),
  ) as RepairResult;
  const target = info.outputPath(scenario + '-native-before-assertions.json');
  writeFileSync(target, JSON.stringify(result, null, 2), { mode: 0o600 });
  chmodSync(info.outputDir, 0o700);
  chmodSync(target, 0o600);
  await info.attach('native-repair-before-assertions', {
    path: target,
    contentType: 'application/json',
  });
  return result;
}
function parsed(value: string | Json): Json {
  return typeof value === 'string' ? (JSON.parse(value) as Json) : value;
}

test('native TaskRunner source-only repair attests real governed historical receipts and persists independently audited source', async ({
  baseURL: _baseURL,
}, info) => {
  test.skip(
    process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1',
    'Explicit fictional loopback provider required',
  );
  test.setTimeout(180_000);
  const result = await nativeRepair('positive', info);
  expect(result.refusal).toBe('');
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]).toMatchObject({
    id: result.repairJobId,
    method: 'prepareAssessmentCoverage',
    status: 'completed',
    tenant_id: result.owner.tenantId,
  });
  expect(result.assessments).toHaveLength(0);
  expect(result.providerEvents.map((row) => row.kind)).toEqual([
    'base',
    'historical_feedback',
    'repair',
    'current_audit',
  ]);
  const repairEvent = result.providerEvents.find(
    (row) => row.kind === 'repair',
  );
  expect(repairEvent?.nativeRepairIntent).toMatchObject({
    id: result.repairJobId,
    status: 'running',
  });
  const intent = parsed(repairEvent!.nativeRepairIntent!.args);
  expect(intent.sourcePreparationAgentRunId).toEqual(expect.any(String));
  expect(String(intent.sourcePreparationAgentRunId)).not.toBe('');
  expect(intent.repairInputFingerprint).toEqual(expect.any(String));
  expect(parsed(result.jobs[0].args).repairInputFingerprint).toBe(
    intent.repairInputFingerprint,
  );
  expect(result.verified.complete).toBe(true);
  expect(
    result.current.preparedPostingJson.requirementCoverage.audit,
  ).toBeTruthy();
  const paid = result.beforePreparedJson.requirementCoverage.requirements;
  for (const row of paid)
    expect(
      result.current.preparedPostingJson.requirementCoverage.requirements,
    ).toContainEqual(row);
  expect(
    result.current.preparedPostingJson.requirementCoverage.requirements.length,
  ).toBeGreaterThan(paid.length);
  expect(result.receipts.map((row) => row.feature)).toEqual(
    expect.arrayContaining([
      'opportunity-extraction-chunk-1',
      'opportunity-source-requirement-repair',
      'opportunity-source-requirement-coverage',
    ]),
  );
  for (const receipt of result.receipts) {
    expect(receipt.status).toBe('completed');
    expect(receipt.tenant_id ?? '').toBe('');
    expect(receipt.owner_user_id ?? '').toBe('');
    expect(receipt.candidate_profile_id ?? '').toBe('');
  }
  const publicPayload = JSON.stringify({
    requests: result.providerEvents.map((row) => row.request),
    cache: result.current.preparedPostingJson,
  });
  for (const identity of [
    result.owner.tenantId,
    result.owner.userId,
    result.owner.profileId,
  ])
    expect(publicPayload).not.toContain(identity);
});

for (const scenario of ['stale', 'forged', 'revoked']) {
  test(
    'native TaskRunner repair refuses ' +
      scenario +
      ' source or operator intent before provider',
    async ({ baseURL: _baseURL }, info) => {
      test.skip(
        process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1',
        'Explicit fictional loopback provider required',
      );
      test.setTimeout(180_000);
      const result = await nativeRepair(scenario, info);
      expect(result.bootstrapEventCount).toBe(2);
      expect(result.providerEvents).toHaveLength(2);
      expect(result.assessments).toHaveLength(0);
      expect(result.current.preparedPostingJson).toEqual(
        result.beforePreparedJson,
      );
      if (scenario === 'forged') {
        expect(result.refusal).toMatch(
          /exact completed GLOBAL native receipts/,
        );
        expect(result.jobs).toHaveLength(0);
      } else {
        expect(result.jobs).toHaveLength(1);
        expect(result.jobs[0].method).toBe('prepareAssessmentCoverage');
        expect(result.jobs[0].status).toBe('failed');
        expect(result.jobs[0].last_error).toMatch(
          scenario === 'stale'
            ? /source is not current/
            : /inactive|active|suspend/i,
        );
      }
    },
  );
}

for (const scenario of ['positive', 'stale', 'forged']) {
  test(`native TaskRunner audit-only replay ${scenario} uses actual completed repair receipt`, async ({
    baseURL: _baseURL,
  }, info) => {
    test.skip(
      process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1',
      'Explicit fictional loopback provider required',
    );
    test.setTimeout(180_000);
    const result = await nativeRepair(`audit-${scenario}`, info);
    expect(result.replayEventStart).toBe(3);
    expect(
      result.providerEvents
        .slice(0, result.replayEventStart)
        .map((row) => row.kind),
    ).toEqual(['base', 'historical_feedback', 'repair']);
    expect(result.assessments).toHaveLength(0);
    for (const receipt of result.receipts) {
      expect(receipt.tenant_id ?? '').toBe('');
      expect(receipt.owner_user_id ?? '').toBe('');
      expect(receipt.candidate_profile_id ?? '').toBe('');
    }
    const replayEvents = result.providerEvents.slice(result.replayEventStart);
    if (scenario === 'positive') {
      expect(result.refusal).toBe('');
      expect(replayEvents.map((row) => row.kind)).toEqual(['audit_replay']);
      expect(replayEvents[0].request.model).toBe('jev-latest');
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]).toMatchObject({
        id: result.replayJobId,
        method: 'prepareAssessmentCoverage',
        status: 'completed',
        tenant_id: result.owner.tenantId,
      });
      const intent = parsed(result.jobs[0].args);
      expect(intent.sourceCoverageRepair).toMatchObject({
        stage: 'audit_completed_repair',
        repairRequestId: result.exactReplay.repairRequestId,
      });
      expect(replayEvents[0].nativeRepairIntent).toMatchObject({
        id: result.replayJobId,
        status: 'running',
      });
      expect(replayEvents[0].request.state).toEqual(
        result.exactReplay.request.state,
      );
      // The actual TypeSafe SDK converts its public predicate primitive to
      // the vendor noul wire type; keys and literal instructions stay exact.
      const wireQuestions = Object.fromEntries(
        Object.entries(result.exactReplay.request.questions).map(
          ([key, value]) => {
            const question = value as Json;
            expect(question.type).toBe('predicate');
            return [key, { ...question, type: 'noul' }];
          },
        ),
      );
      expect(replayEvents[0].request.questions).toEqual(wireQuestions);
      // Five dynamic direct-literal questions over the fictional three-clause
      // ledger; this is protocol proof, not the real daily 84-question dataset.
      expect(Object.keys(result.exactReplay.request.questions)).toHaveLength(5);
      expect(
        result.current.preparedPostingJson.requirementCoverage.audit,
      ).toEqual(result.exactReplay.expectedAudit);
      expect(result.exactReplay.auditRequestId).not.toBe(
        result.beforeReplay.preparedPostingJson.requirementCoverage.audit
          ?.requestId,
      );
      expect(result.verified.complete).toBe(true);
      for (const row of result.beforeReplay.preparedPostingJson
        .requirementCoverage.requirements)
        expect(
          result.current.preparedPostingJson.requirementCoverage.requirements,
        ).toContainEqual(row);
      expect(
        result.current.preparedPostingJson.requirementCoverage.requirements,
      ).toHaveLength(3);
      const newReceipts = result.receipts.filter(
        (row) =>
          !result.beforeReplay.receipts.some(
            (before) => before.owner_request_id === row.owner_request_id,
          ),
      );
      expect(newReceipts).toHaveLength(1);
      expect(newReceipts[0]).toMatchObject({
        owner_request_id: result.exactReplay.auditRequestId,
        feature: 'opportunity-source-requirement-coverage',
        status: 'completed',
        model: 'jev-latest',
        output_schema_version: 'requirement-coverage-audit/v6-direct-literal',
      });
      expect(
        result.requests.filter(
          (row) => row.feature === 'opportunity-source-requirement-repair',
        ),
      ).toHaveLength(1);
      const sourceOnly = JSON.stringify({
        request: replayEvents[0].request,
        cache: result.current.preparedPostingJson,
      });
      for (const identity of [
        result.owner.tenantId,
        result.owner.userId,
        result.owner.profileId,
      ])
        expect(sourceOnly).not.toContain(identity);
    } else {
      expect(replayEvents).toHaveLength(0);
      expect(result.receipts).toHaveLength(result.beforeReplay.receipts.length);
      expect(result.current.preparedPostingJson).toEqual(
        result.beforeReplay.preparedPostingJson,
      );
      if (scenario === 'forged') {
        expect(result.refusal).toMatch(
          /distinct completed native repair receipt/,
        );
        expect(result.replayJobId).toBe('');
        expect(result.jobs).toHaveLength(0);
      } else {
        expect(result.jobs).toHaveLength(1);
        expect(result.jobs[0]).toMatchObject({
          id: result.replayJobId,
          status: 'failed',
        });
        expect(result.jobs[0].last_error).toMatch(/source is not current/);
      }
    }
  });
}
