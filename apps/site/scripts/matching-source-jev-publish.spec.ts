import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { jevBudget } from '../src/lib/server/matching-source-decision-budget.js';
import { MATCHING_SOURCE_EXTRACTION_VERSION } from '../src/lib/server/matching-source-extraction-contract.js';
import {
  matchingSourceCaptureDigest,
  matchingSourceDecisionRequestId,
} from '../src/lib/server/matching-source-identity.js';
import { MATCHING_SOURCE_JEV_PREPARATION_VERSION } from '../src/lib/server/matching-source-jev.js';
import {
  type MatchingSourceDecisionProfile,
  type MatchingSourceSemanticProposal,
  matchingSourceSemanticMaterial,
  matchingSourceSemanticProposalDigest,
} from '../src/lib/server/matching-source-semantics.js';
import { MATCHING_SOURCE_DECISION_READER_REVISION } from '../src/lib/server/matching-source-units.js';
import { MATCHING_POLICY_VERSION } from '../src/lib/server/normalized-matching.js';
import { fingerprintOpportunitySourceContent } from '../src/lib/server/opportunity-source-content.js';
import {
  classifyJevQaResult,
  countJevQaStatuses,
  describeJevQaReadback,
  jevQaStop,
  matchesJevQaCapturePin,
  openJevQaReport,
  parseJevQaArguments,
  parseJevQaCapturePins,
  parseJevQaCohort,
  runLocalJevQa,
  verifiedJevQaDatabase,
} from './matching-source-jev-publish.js';

const runtime = vi.hoisted(() => ({
  resolve: vi.fn(),
  provider: vi.fn(),
  prepare: vi.fn(),
  worker: vi.fn(),
}));
vi.mock('@happyvertical/smrt-core', async (original) => ({
  ...(await original<typeof import('@happyvertical/smrt-core')>()),
  resolveDatabase: runtime.resolve,
}));
vi.mock(
  '../src/lib/server/matching-source-decision-provider.js',
  async (original) => ({
    ...(await original<
      typeof import('../src/lib/server/matching-source-decision-provider.js')
    >()),
    createMatchingSourceDecisionProvider: runtime.provider,
  }),
);
vi.mock('../src/lib/server/matching-source-extraction-worker.js', () => ({
  runMatchingSourceExtraction: runtime.worker,
}));
vi.mock('../src/lib/server/matching-source-jev.js', async (original) => ({
  ...(await original<
    typeof import('../src/lib/server/matching-source-jev.js')
  >()),
  prepareJevMatchingSource: runtime.prepare,
}));

const id = '11111111-0000-4000-8000-000000000001';

describe('local Jev publication admission', () => {
  it('accepts only the explicit isolated loopback clone', () => {
    expect(
      verifiedJevQaDatabase('postgresql://localhost:55490/iolaus_sweep_clone'),
    ).toBe('postgresql://127.0.0.1:55490/iolaus_sweep_clone');
    for (const url of [
      undefined,
      'postgresql://example.invalid:55490/iolaus_sweep_clone',
      'postgresql://localhost:5432/iolaus_sweep_clone',
      'postgresql://localhost:55490/other',
      'postgresql://localhost:55490/iolaus_sweep_clone?host=example.invalid',
    ])
      expect(() => verifiedJevQaDatabase(url)).toThrow();
  });

  it('joins capture pins by ID across reordered and subset selections', () => {
    const staff = {
      id,
      caseKey: 'staff',
      title: 'Staff Engineer',
      sourceFingerprint: 'a'.repeat(64),
      sourceDigest: 'b'.repeat(64),
    };
    const principal = {
      id: id.replace(/1$/u, '2'),
      caseKey: 'principal',
      title: 'Principal Engineer',
      sourceFingerprint: 'c'.repeat(64),
      sourceDigest: 'd'.repeat(64),
    };
    const capture = { id, title: staff.title, fingerprint: staff.sourceFingerprint, digest: staff.sourceDigest };
    const reordered = parseJevQaCapturePins([principal, staff]);
    const subset = parseJevQaCapturePins([staff]);
    expect([...reordered.keys()]).toEqual([principal.id, id]);
    expect(reordered.get(id)).toEqual(subset.get(id));
    expect(matchesJevQaCapturePin(staff, capture)).toBe(true);
    expect(matchesJevQaCapturePin(principal, capture)).toBe(false);
    expect(matchesJevQaCapturePin(staff, { ...capture, title: principal.title })).toBe(false);
    expect(matchesJevQaCapturePin(staff, { ...capture, fingerprint: principal.sourceFingerprint })).toBe(false);
    expect(matchesJevQaCapturePin(staff, { ...capture, digest: principal.sourceDigest })).toBe(false);
    expect(() => parseJevQaCapturePins([staff, { ...principal, caseKey: staff.caseKey }])).toThrow();
  });

  it('requires explicit bounded admission and distinct IDs', () => {
    expect(parseJevQaCohort([id])).toEqual([id]);
    expect(() => parseJevQaCohort([id, id])).toThrow();
    expect(() => parseJevQaCohort(['not-a-posting-id'])).toThrow();
    expect(parseJevQaArguments(['--cohort', 'fixture.json']).apply).toBe(false);
    expect(() =>
      parseJevQaArguments(['--cohort', 'fixture.json', '--apply']),
    ).toThrow();
    expect(() =>
      parseJevQaArguments([
        '--cohort',
        'fixture.json',
        '--apply',
        '--max-calls',
        '1501',
        '--max-cost-micros',
        '500000',
      ]),
    ).toThrow();
    expect(
      parseJevQaArguments([
        '--cohort',
        'fixture.json',
        '--apply',
        '--max-calls',
        '1500',
        '--max-cost-micros',
        '500000',
      ]),
    ).toMatchObject({ apply: true, maxCalls: 1500, maxCostMicros: 500000 });
  });
});

const capture = {
  title: 'Software Engineer',
  descriptionRaw: 'No formal requirements.',
  locationNotes: 'Remote (Canada)',
};
const source = {
  title: capture.title,
  description: capture.descriptionRaw,
  location: capture.locationNotes,
};
const rawCapture = JSON.stringify(capture);
const captureFingerprint = fingerprintOpportunitySourceContent(capture);
const profile: MatchingSourceDecisionProfile = {
  provider: 'typesafe',
  transport: 'bifrost',
  model: 'private-routing-namespace/jev-1.14.0',
  revision: 'private-deployment-revision',
  maxInputBytes: 8192,
  preparationVersion: 'matching-source-jev/v18',
};
const identity = matchingSourceDecisionRequestId(profile);
const legacyPayload = {
  coverage: 'partial',
  role: null,
  geography: null,
  noRequirements: null,
  required: [],
  preferred: [],
  unresolved: [],
};
const proposal: MatchingSourceSemanticProposal = {
  role: null,
  geography: null,
  ledger: matchingSourceSemanticMaterial(source).units.map(({ id }) => ({
    id,
    kind: 'context',
    groups: [],
  })),
};
const decisionPayload = {
  ...legacyPayload,
  semantic: {
    sourceDigest: matchingSourceSemanticMaterial(source).sourceDigest,
    proposal,
    verification: {
      sourceDigest: matchingSourceSemanticMaterial(source).sourceDigest,
      proposalDigest: matchingSourceSemanticProposalDigest(proposal),
      roleCorrect: false,
      geographyCorrect: false,
      units: proposal.ledger.map(({ id }) => ({
        id,
        classificationCorrect: true,
        allConditionsRepresented: true,
        logicAndQualifiersPreserved: true,
      })),
    },
    decision: { ...profile, observedModels: [profile.model] },
  },
};
const latestRow = {
  is_public: true,
  source_content_version: '10',
  source_content_fingerprint: captureFingerprint,
  source_content_json: rawCapture,
  proof_state: 'complete',
  proof_contract_version: MATCHING_SOURCE_EXTRACTION_VERSION,
  proof_source_content_version: '10',
  proof_source_fingerprint: captureFingerprint,
  proof_payload: JSON.stringify(decisionPayload),
  proof_request_id: identity,
  proof_input_digest: matchingSourceCaptureDigest(rawCapture),
  current_source_revision: '15',
  current_listing_revision: '9',
  current_vocabulary_revision: '2',
  facts_source_revision: '14',
  facts_listing_revision: '9',
  facts_vocabulary_revision: '2',
  facts_policy_version: MATCHING_POLICY_VERSION,
  facts_work_revision: '52',
  facts_json: JSON.stringify({
    sourceDecisionReaderRevision: MATCHING_SOURCE_DECISION_READER_REVISION,
    secret: 'private-facts-content',
  }),
};

describe('local Jev publication report', () => {
  it('validates a current proof and reports shared source fact currentness independently', () => {
    const latest = describeJevQaReadback(latestRow, identity);
    expect(latest).toMatchObject({
      sourceContentVersion: '10',
      proof: {
        kind: 'decision',
        state: 'complete',
        sourceContentVersion: '10',
        requested: 'latest',
        identity,
        decision: {
          model: 'jev-1.14.0',
          preparationVersion: profile.preparationVersion,
        },
      },
      sharedSourceFacts: {
        state: 'stale',
        currentSourceRevision: '15',
        sourceRevision: '14',
        workRevision: '52',
        sourceDecisionReader: 'current',
        sourceDecisionReaderRevision: MATCHING_SOURCE_DECISION_READER_REVISION,
      },
    });
    expect(JSON.stringify(latest)).not.toMatch(
      /private-routing|private-deployment|No formal requirements|Software Engineer|private-facts-content/,
    );
    expect(
      describeJevQaReadback(
        { ...latestRow, facts_source_revision: '15' },
        identity,
      ).sharedSourceFacts.state,
    ).toBe('current');
    expect(
      describeJevQaReadback(
        { ...latestRow, facts_source_revision: null },
        identity,
      ).sharedSourceFacts.state,
    ).toBe('missing');
  });

  it('distinguishes an older or absent source reader marker from current facts revisions', () => {
    const current = { ...latestRow, facts_source_revision: '15' };
    expect(
      describeJevQaReadback({ ...current, facts_json: '{}' }).sharedSourceFacts,
    ).toMatchObject({
      state: 'current',
      sourceDecisionReader: 'unknown',
      sourceDecisionReaderRevision: null,
    });
    expect(
      describeJevQaReadback({
        ...current,
        facts_json: JSON.stringify({
          sourceDecisionReaderRevision: 'matching-source-reader/v0',
        }),
      }).sharedSourceFacts,
    ).toMatchObject({
      state: 'current',
      sourceDecisionReader: 'older',
      sourceDecisionReaderRevision: 'matching-source-reader/v0',
    });
  });

  it('separates missing, stale-capture, invalid and retained legacy proofs', () => {
    expect(
      describeJevQaReadback(
        { ...latestRow, proof_source_content_version: '9' },
        identity,
      ).proof,
    ).toMatchObject({
      kind: 'missing',
      captureCurrent: false,
      sourceContentVersion: '9',
    });
    expect(
      describeJevQaReadback(
        { ...latestRow, proof_input_digest: 'wrong' },
        identity,
      ).proof,
    ).toMatchObject({
      kind: 'invalid',
      captureCurrent: false,
      identity: null,
    });
    expect(
      describeJevQaReadback(
        { ...latestRow, proof_request_id: 'wrong' },
        identity,
      ).proof.kind,
    ).toBe('invalid');
    const legacy = describeJevQaReadback(
      {
        ...latestRow,
        proof_payload: JSON.stringify(legacyPayload),
        proof_request_id: 'opaque-private-id',
      },
      identity,
    );
    expect(legacy.proof).toMatchObject({
      kind: 'legacy',
      requested: 'retained',
      identity: expect.stringMatching(/^legacy:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(legacy)).not.toContain('opaque-private-id');
  });

  it('does not call idle a cache hit without an exact validated requested proof', () => {
    const latest = describeJevQaReadback(latestRow, identity);
    const prior = describeJevQaReadback(latestRow, 'decision:new-version');
    const retry = describeJevQaReadback(
      { ...latestRow, proof_state: 'retry' },
      identity,
    );
    const missing = describeJevQaReadback({}, identity);
    expect(classifyJevQaResult('idle', latest, latest)).toBe('cached');
    expect(classifyJevQaResult('idle', missing, missing)).toBe('ineligible');
    expect(
      classifyJevQaResult('idle', prior, prior, 'PriorEvidenceRetained'),
    ).toBe('retained');
    expect(classifyJevQaResult('retry', prior, prior)).toBe('retained');
    expect(classifyJevQaResult('retry', prior, retry)).toBe('retry');
    expect(classifyJevQaResult('idle', retry, retry)).toBe('retry');
    expect(classifyJevQaResult('published', prior, latest)).toBe('published');
    expect(classifyJevQaResult('obsolete', prior, missing)).toBe('obsolete');
  });

  it('distinguishes caps from unverified metering and counts all dispositions', () => {
    const env = {
      IOLAUS_SOURCE_DECISION_JEV_INPUT_COST_MICROS_PER_MILLION: '100000',
    };
    const budget = jevBudget('jev-1.14.0', 20_000, env);
    expect(jevQaStop(budget, 1, 2)).toBeUndefined();
    expect(jevQaStop(budget, 2, 2)).toBe('call-cap');
    expect(jevQaStop({ ...budget, reportedCostMicros: 18_000 }, 1, 2)).toBe(
      'cost-cap',
    );
    expect(jevQaStop({ ...budget, stopReason: 'unverified-usage' }, 2, 2)).toBe(
      'unverified-usage',
    );
    expect(
      countJevQaStatuses([
        { status: 'cached' },
        { status: 'published' },
        { status: 'unattempted' },
        { status: 'unattempted' },
      ]),
    ).toMatchObject({
      cached: 1,
      published: 1,
      unattempted: 2,
      retained: 0,
      retry: 0,
    });
  });

  it('keeps cached and unattempted ordinals in a completed capped report', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'jev-capped-report-'));
    const cohort = join(folder, 'cohort.json');
    const report = join(folder, 'report.json');
    const ids = [1, 2, 3].map((number) => `${id.slice(0, -1)}${number}`);
    const activeProfile = {
      ...profile,
      transport: 'direct' as const,
      model: 'jev-1.14.0',
      preparationVersion: MATCHING_SOURCE_JEV_PREPARATION_VERSION,
    };
    const activeIdentity = matchingSourceDecisionRequestId(activeProfile);
    const valid = {
      ...latestRow,
      proof_payload: JSON.stringify({
        ...decisionPayload,
        semantic: {
          ...decisionPayload.semantic,
          decision: { ...activeProfile, observedModels: [activeProfile.model] },
        },
      }),
      proof_request_id: activeIdentity,
    };
    const missing = { ...latestRow, proof_state: null };
    const stored = new Map<string, typeof valid | typeof missing>([
      [ids[0], missing],
      [ids[1], valid],
      [ids[2], missing],
    ]);
    const close = vi.fn();
    runtime.resolve.mockResolvedValue({
      async query(sql: string, params: string[]) {
        expect(sql).not.toMatch(/matching_results|candidate_profiles/);
        return { rows: params.map((key) => stored.get(key)) };
      },
      close,
    });
    const decide = vi.fn();
    runtime.provider.mockImplementation((_config, { onAttempt }) => ({
      provenance: { maxInputBytes: activeProfile.maxInputBytes },
      decide: decide.mockImplementation(async () => {
        onAttempt({
          calls: 1,
          retries: 0,
          status: 'ok',
          elapsedMs: 1,
          observedModel: activeProfile.model,
          usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
        });
        return { status: 'ok' };
      }),
    }));
    runtime.prepare.mockImplementation(async (_input, bounded) => {
      await bounded.decide({ state: {}, questions: {} });
      return decisionPayload.semantic;
    });
    runtime.worker.mockImplementation(
      async (_database, _dialect, _budget, options) => {
        await options.provider(source);
        stored.set(options.opportunityId, valid);
        return 'published';
      },
    );
    try {
      await writeFile(cohort, JSON.stringify(ids), { mode: 0o600 });
      const result = await runLocalJevQa(
        parseJevQaArguments([
          '--cohort',
          cohort,
          '--report',
          report,
          '--apply',
          '--max-calls',
          '1',
          '--max-cost-micros',
          '20000',
        ]),
        {
          DATABASE_URL: 'postgresql://localhost:55490/iolaus_sweep_clone',
          IOLAUS_SOURCE_DECISION_PROVIDER: 'typesafe',
          IOLAUS_SOURCE_DECISION_MODEL: activeProfile.model,
          IOLAUS_SOURCE_DECISION_REVISION: activeProfile.revision,
          IOLAUS_SOURCE_DECISION_JEV_INPUT_COST_MICROS_PER_MILLION: '100000',
          TYPESAFE_API_KEY: 'mock-only-private-key',
        },
      );
      expect(result).toMatchObject({
        state: 'complete',
        stopReason: 'call-cap',
        selected: 3,
        counts: { published: 1, cached: 1, unattempted: 1 },
        results: [
          {
            ordinal: 1,
            status: 'published',
            calls: 1,
            current: { proof: { requested: 'latest' } },
          },
          { ordinal: 2, status: 'cached', calls: 0 },
          {
            ordinal: 3,
            status: 'unattempted',
            calls: 0,
            stopReason: 'call-cap',
          },
        ],
      });
      expect(runtime.worker).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      const storedReport = await readFile(report, 'utf8');
      expect(JSON.parse(storedReport)).toEqual(result);
      for (const value of [
        ...ids,
        capture.title,
        capture.descriptionRaw,
        'mock-only-private-key',
      ])
        expect(storedReport).not.toContain(value);
    } finally {
      vi.resetAllMocks();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('checkpoints to a private report path and refuses an existing file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'jev-publish-report-'));
    try {
      const path = join(folder, 'report.json');
      const save = await openJevQaReport(path);
      await save({ state: 'running' });
      await save({ state: 'complete' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        state: 'complete',
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(openJevQaReport(path)).rejects.toThrow();
      expect(
        parseJevQaArguments(['--cohort', 'fixture.json', '--report', path])
          .report,
      ).toBe(path);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
