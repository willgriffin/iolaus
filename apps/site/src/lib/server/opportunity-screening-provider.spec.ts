import type { DecisionResult } from '@happyvertical/ai';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OpportunityIntelligenceGovernanceStore,
  OpportunityIntelligenceReservation,
  OpportunityIntelligenceReserveResult,
  OpportunityIntelligenceTerminalResult,
} from './opportunity-intelligence-governance.js';
import {
  OPPORTUNITY_SCREENING_VERSION,
  type PreparedOpportunityScreening,
} from './opportunity-screening.js';
import {
  assertOpportunityAssessmentScreenNotAttempted,
  evaluateOpportunityAssessmentScreen,
  OPPORTUNITY_SCREENING_FEATURE,
  OPPORTUNITY_SCREENING_PROFILE,
  type OpportunityScreeningProviderDependencies,
  prepareCurrentOpportunityAssessmentScreen,
  readCurrentOpportunityAssessmentScreen,
} from './opportunity-screening-provider.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  getAI: vi.fn(),
  getCollection: vi.fn(),
}));
vi.mock('@happyvertical/ai', () => ({ getAI: mocks.getAI }));
vi.mock('./smrt.js', () => ({ getCollection: mocks.getCollection }));
vi.mock('./change-feed.js', () => ({
  bumpOpportunityTableChangeFeed: vi.fn(),
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));
const subject = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  profileId: 'profile-1',
};
const run: PrincipalRun = {
  context: {} as PrincipalRun['context'],
  permissions: [],
  allowedTools: [],
  isToolAllowed: () => false,
  assertToolAllowed: () => {
    throw new Error('No tool grant.');
  },
  assertOperation: vi.fn(async () => undefined as never),
};
function decision(
  prepared: PreparedOpportunityScreening,
  mismatch = false,
): DecisionResult {
  const witness = prepared.witnesses.find(
    (row) => row.path === 'sourceContentJson.descriptionRaw',
  )!;
  return {
    model: 'jev-test',
    provenance: { model: 'jev-test', provider: 'typesafe' },
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    answers: Object.fromEntries(
      Object.entries(prepared.request.questions).map(([key, question]) => {
        const dimension = key.replace(/__evidence$/u, '');
        const yes = mismatch
          ? dimension === 'role_mismatch'
          : dimension === 'role_relevant';
        return [
          key,
          question.type === 'choice'
            ? {
                type: 'choice',
                choice: yes ? witness.id : 'none',
                confidence: 0.9,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria).map((offered) => [
                    offered,
                    offered === (yes ? witness.id : 'none')
                      ? 0.9
                      : 0.1 / (Object.keys(question.criteria).length - 1),
                  ]),
                ),
              }
            : { type: 'predicate', probability: yes ? 0.99 : 0.01 },
        ];
      }),
    ),
  };
}
function fixture() {
  const source = {
    title: 'Software engineer',
    descriptionRaw: 'Build reliable software.',
    locationNotes: 'Canada',
    workMode: 'Remote',
  };
  const opportunity: Record<string, unknown> = {
    id: 'opportunity-1',
    sourceContentJson: JSON.stringify(source),
    sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
    sourceContentVersion: 1,
    preparedPostingJson: JSON.stringify({
      forgedScreen: 'cache-is-not-authority',
    }),
  };
  const profile: Record<string, unknown> = {
    id: subject.profileId,
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
    active: true,
    name: 'never-send-contact',
    email: 'never-send-contact@example.test',
    preferencesJson: JSON.stringify({
      targetRoles: ['Software engineering'],
      workModes: ['Remote'],
    }),
    targetWorkCountryJson: JSON.stringify({ code: 'CA', label: 'Canada' }),
    authorizedWorkCountriesJson: JSON.stringify([
      { country: { code: 'CA', label: 'Canada' }, scope: 'country' },
    ]),
    sponsorshipRequired: false,
  };
  let row: Record<string, unknown> | undefined;
  let lastReservation: OpportunityIntelligenceReservation | undefined;
  const reserveSpy = vi.fn();
  const completeSpy = vi.fn();
  const freshSpy = vi.fn();
  const store: OpportunityIntelligenceGovernanceStore = {
    async reserve<T>(
      reservation: OpportunityIntelligenceReservation,
    ): Promise<OpportunityIntelligenceReserveResult<T>> {
      reserveSpy(reservation);
      if (
        row &&
        lastReservation?.idempotencyKey === reservation.idempotencyKey
      ) {
        if (row.result_status === 'completed')
          return {
            kind: 'reused',
            requestId: String(row.request_id),
            output: JSON.parse(String(row.output_json)) as T,
          };
        return {
          kind: 'blocked',
          code: 'prior_attempt_failed',
          message: 'Prior terminal identity failed.',
        };
      }
      lastReservation = reservation;
      return { kind: 'owner', reservation };
    },
    async complete<T>(
      reservation: OpportunityIntelligenceReservation,
      terminal: OpportunityIntelligenceTerminalResult<T> & {
        actualSpendMicros: number;
      },
    ): Promise<void> {
      completeSpy(reservation, terminal);
      row = {
        owner_request_id: reservation.requestId,
        result_request_id: reservation.requestId,
        request_id: reservation.requestId,
        result_key: reservation.idempotencyKey,
        request_key: reservation.idempotencyKey,
        output_json: JSON.stringify(terminal.output),
        agent_run_id: reservation.agentRunId,
        opportunity_id: reservation.opportunityId,
        content_fingerprint: reservation.contentFingerprint,
        input_fingerprint: reservation.inputFingerprint,
        feature: reservation.feature,
        profile: reservation.profile,
        model: reservation.model,
        prompt_version: reservation.promptVersion,
        output_schema_version: reservation.outputSchemaVersion,
        prepared_payload_version: reservation.preparedPayloadVersion,
        result_status: terminal.status === 'succeeded' ? 'completed' : 'failed',
        request_status: terminal.status,
        accounting_basis: terminal.accountingBasis,
        actual_total_tokens: terminal.usage?.totalTokens,
        reserved_input_tokens: reservation.reservedInputTokens,
        requested_max_output_tokens: reservation.maxOutputTokens,
        reserved_spend_micros: reservation.reservedSpendMicros,
        tenant_id: subject.tenantId,
        owner_user_id: subject.userId,
        candidate_profile_id: subject.profileId,
        request_tenant_id: subject.tenantId,
        request_owner_user_id: subject.userId,
        request_candidate_profile_id: subject.profileId,
        run_opportunity_id: reservation.opportunityId,
        run_tenant_id: subject.tenantId,
        run_owner_user_id: subject.userId,
        run_candidate_profile_id: subject.profileId,
        run_calls: 0,
        run_tokens: 0,
        run_spend: 0,
        run_actual_calls: 1,
        run_actual_tokens: terminal.usage?.promptTokens ?? 0,
        run_actual_output_tokens: terminal.usage?.completionTokens ?? 0,
        run_actual_spend: terminal.actualSpendMicros,
        run_call_limit: 4,
        run_token_limit: 80000,
        run_spend_limit: 100000,
      };
    },
    openCircuit: vi.fn(async () => {}),
  };
  const runFresh: NonNullable<
    OpportunityScreeningProviderDependencies['runFresh']
  > = async <T>(
    current: typeof subject,
    capability: Parameters<
      NonNullable<OpportunityScreeningProviderDependencies['runFresh']>
    >[1],
    work: (subject: typeof current, run: PrincipalRun) => Promise<T>,
  ) => {
    freshSpy(current, capability);
    return await work(current, run);
  };
  const database = {
    query: vi.fn(async (sql: string, _params: unknown[]) => ({
      rows: sql.includes('SELECT request_id FROM')
        ? row
          ? [{ request_id: row.request_id }]
          : []
        : row
          ? [row]
          : [],
    })),
  };
  const deps: OpportunityScreeningProviderDependencies = {
    getOpportunity: vi.fn(async () => opportunity),
    getProfile: vi.fn(async () => profile),
    runFresh,
    database,
  };
  return {
    opportunity,
    profile,
    store,
    deps,
    database,
    reserveSpy,
    completeSpy,
    freshSpy,
    get row() {
      return row;
    },
    set row(next: Record<string, unknown> | undefined) {
      row = next;
    },
    get reservation() {
      return lastReservation;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_ENABLED', 'true');
  vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED', 'true');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT', '4');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT', '80000');
  vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS', '100000');
  vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-test');
  vi.stubEnv(
    'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
    '1000',
  );
  vi.stubEnv(
    'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
    '1000',
  );
  vi.stubEnv('TYPESAFE_API_KEY', 'fixture-key');
  mocks.getAI.mockResolvedValue({
    getCapabilities: async () => ({ decisions: true }),
    decide: mocks.decide,
  });
});
afterEach(() => vi.unstubAllEnvs());
async function execute(f: ReturnType<typeof fixture>, mismatch = false) {
  const prepared = await prepareCurrentOpportunityAssessmentScreen(
    'opportunity-1',
    subject,
    f.deps,
  );
  mocks.decide.mockResolvedValue(decision(prepared, mismatch));
  const receipt = await evaluateOpportunityAssessmentScreen(
    prepared,
    {
      agentRunId: 'original-run',
      opportunityId: 'opportunity-1',
      contentFingerprint: String(f.opportunity.sourceContentFingerprint),
      workspaceSubject: subject,
      store: f.store,
    },
    f.deps,
  );
  return { prepared, receipt };
}
describe('PRIVATE JEV-first governed native screening', () => {
  it('records authentic PRIVATE authority and replays the same native original run without another provider', async () => {
    const f = fixture();
    const { prepared, receipt } = await execute(f);
    expect(receipt).toMatchObject({
      outcome: 'potentially_relevant',
      agentRunId: 'original-run',
      requestId: f.reservation?.requestId,
      reservation: {
        calls: 1,
        reservedTokens: prepared.requestBytes + prepared.maxOutputTokens,
      },
    });
    expect(f.reservation).toMatchObject({
      workspaceSubject: subject,
      feature: OPPORTUNITY_SCREENING_FEATURE,
      profile: OPPORTUNITY_SCREENING_PROFILE,
      preparedPayloadVersion: OPPORTUNITY_SCREENING_VERSION,
      maxOutputTokens: prepared.maxOutputTokens,
    });
    expect(receipt.screen.requestId).toBe(f.reservation?.requestId);
    expect(f.completeSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        accountingBasis: 'actual',
        actualSpendMicros: 1,
        status: 'succeeded',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      }),
    );
    expect(JSON.stringify(prepared.request)).not.toContain(
      'never-send-contact',
    );
    expect(receipt.inputFingerprint).not.toBe(prepared.inputFingerprint);
    const replay = await readCurrentOpportunityAssessmentScreen(
      { opportunityId: 'opportunity-1', subject },
      f.deps,
    );
    expect(replay).toEqual(receipt);
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(f.database.query).toHaveBeenCalledWith(
      expect.stringContaining('q.actual_total_tokens > 0'),
      expect.arrayContaining([
        subject.tenantId,
        subject.userId,
        subject.profileId,
      ]),
    );
  });
  it('returns a screened mismatch using only the coarse Typesafe request', async () => {
    const f = fixture();
    const { receipt } = await execute(f, true);
    expect(receipt.outcome).toBe('clear_mismatch');
    expect(mocks.getAI).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'typesafe', defaultModel: 'jev-test' }),
    );
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(Object.keys(mocks.decide.mock.calls[0][0].questions)).toHaveLength(
      14,
    );
  });
  it.each([
    0.1, 0.9,
  ])('requires independent V4 source support for an affirmative mismatch (support=%s)', async (support) => {
    const f = fixture();
    f.profile.preferencesJson = JSON.stringify({
      targetRoles: ['Accounting'],
      workModes: ['Remote'],
    });
    const prepared = await prepareCurrentOpportunityAssessmentScreen(
      'opportunity-1',
      subject,
      f.deps,
    );
    expect(
      Object.values(prepared.request.questions).every(
        (q) => q.type === 'predicate',
      ),
    ).toBe(true);
    const output = decision(prepared, true);
    output.answers.role_mismatch__evidence = {
      type: 'predicate',
      probability: support,
    };
    mocks.decide.mockResolvedValue(output);
    const receipt = await evaluateOpportunityAssessmentScreen(
      prepared,
      {
        agentRunId: 'original-run',
        opportunityId: 'opportunity-1',
        contentFingerprint: String(f.opportunity.sourceContentFingerprint),
        workspaceSubject: subject,
        store: f.store,
      },
      f.deps,
    );
    expect(receipt.outcome).toBe(
      support >= 0.85 ? 'clear_mismatch' : 'uncertain',
    );
    if (support >= 0.85) {
      expect(receipt.screen.evidence).toMatchObject([
        {
          dimension: 'role_mismatch',
          probability: 0.99,
          confidence: support,
          evidenceScope: 'captured_source_context',
          witness: {
            id: 'source:context',
            path: 'sourceContentJson.descriptionRaw',
            text: 'Build reliable software.',
            spanStart: 0,
            spanEnd: 'Build reliable software.'.length,
          },
          contextWitnesses: expect.arrayContaining([
            expect.objectContaining({
              path: 'sourceContentJson.title',
              text: 'Software engineer',
            }),
            expect.objectContaining({
              path: 'sourceContentJson.locationNotes',
              text: 'Canada',
            }),
            expect.objectContaining({
              path: 'sourceContentJson.workMode',
              text: 'Remote',
            }),
          ]),
        },
      ]);
    } else {
      expect(receipt.screen.mismatches).toEqual([]);
      expect(receipt.screen.evidence).toEqual([]);
      expect(receipt.screen.holdReasons).toContain('uncited_role_mismatch');
    }
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(f.completeSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        accountingBasis: 'actual',
        status: 'succeeded',
      }),
    );
  });
  it.each([
    'malformed',
    'legacy-choice-in-v4',
    'post-provider-profile',
    'post-provider-source',
  ])('accounts actual returned usage for %s failure and does not publish a successful receipt', async (caseName) => {
    const f = fixture();
    const prepared = await prepareCurrentOpportunityAssessmentScreen(
      'opportunity-1',
      subject,
      f.deps,
    );
    mocks.decide.mockImplementation(async () => {
      const result = decision(prepared);
      if (caseName === 'malformed') delete result.answers.role_relevant;
      if (caseName === 'legacy-choice-in-v4') {
        const selected = prepared.witnesses[0]!.id;
        const offered = [...prepared.witnesses.map((w) => w.id), 'none'];
        result.answers.role_relevant__evidence = {
          type: 'choice',
          choice: selected,
          confidence: 0.9,
          probabilities: Object.fromEntries(
            offered.map((key) => [
              key,
              key === selected ? 0.9 : 0.1 / (offered.length - 1),
            ]),
          ),
        };
      }
      if (caseName === 'post-provider-profile')
        f.profile.preferencesJson = JSON.stringify({
          targetRoles: ['Accounting'],
          workModes: ['Remote'],
        });
      if (caseName === 'post-provider-source')
        f.opportunity.sourceContentVersion = 2;
      return result;
    });
    await expect(
      evaluateOpportunityAssessmentScreen(
        prepared,
        {
          agentRunId: 'original-run',
          opportunityId: 'opportunity-1',
          contentFingerprint: String(f.opportunity.sourceContentFingerprint),
          workspaceSubject: subject,
          store: f.store,
        },
        f.deps,
      ),
    ).rejects.toThrow();
    expect(f.completeSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        accountingBasis: 'actual',
        actualSpendMicros: 1,
        status: 'failed',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      }),
    );
    expect(f.row?.result_status).toBe('failed');
    if (caseName === 'malformed' || caseName === 'legacy-choice-in-v4') {
      await expect(
        assertOpportunityAssessmentScreenNotAttempted(
          prepared,
          { opportunityId: 'opportunity-1', workspaceSubject: subject },
          f.deps,
        ),
      ).rejects.toThrow('already attempted');
      await expect(
        evaluateOpportunityAssessmentScreen(
          prepared,
          {
            agentRunId: 'new-run-must-not-reset',
            opportunityId: 'opportunity-1',
            contentFingerprint: String(f.opportunity.sourceContentFingerprint),
            workspaceSubject: subject,
            store: f.store,
          },
          f.deps,
        ),
      ).rejects.toThrow('Prior terminal identity failed');
      expect(mocks.decide).toHaveBeenCalledOnce();
    }
  });
  it.each([
    'tenant_id',
    'request_owner_user_id',
    'run_candidate_profile_id',
    'input_fingerprint',
    'result_request_id',
    'request_key',
    'output_schema_version',
    'accounting_basis',
    'actual_total_tokens',
    'run_tokens',
  ])('rejects foreign/orphan/conservative/unbounded native %s despite materialized JSON', async (field) => {
    const f = fixture();
    await execute(f);
    if (!f.row) throw new Error('Expected governed fixture receipt.');
    f.row[field] =
      field === 'actual_total_tokens'
        ? 0
        : field === 'run_tokens'
          ? 80001
          : 'foreign-or-conservative';
    expect(
      await readCurrentOpportunityAssessmentScreen(
        { opportunityId: 'opportunity-1', subject },
        f.deps,
      ),
    ).toBeUndefined();
    expect(mocks.decide).toHaveBeenCalledOnce();
  });
  it('does not reserve or transport while private assessment decisions are disabled', async () => {
    const f = fixture();
    const prepared = await prepareCurrentOpportunityAssessmentScreen(
      'opportunity-1',
      subject,
      f.deps,
    );
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED', 'false');
    await expect(
      evaluateOpportunityAssessmentScreen(
        prepared,
        {
          agentRunId: 'original-run',
          opportunityId: 'opportunity-1',
          contentFingerprint: String(f.opportunity.sourceContentFingerprint),
          workspaceSubject: subject,
          store: f.store,
        },
        f.deps,
      ),
    ).rejects.toThrow('screening is disabled');
    expect(f.reserveSpy).not.toHaveBeenCalled();
    expect(mocks.getAI).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('denies zero-priced screening before reservation or transport and preserves the pricing circuit policy', async () => {
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION', '0');
    vi.stubEnv(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
      '0',
    );
    const f = fixture();
    await expect(execute(f)).rejects.toThrow(
      'spend reservation must be positive',
    );
    expect(f.store.openCircuit).toHaveBeenCalledWith('pricing_missing');
    expect(f.reserveSpy).not.toHaveBeenCalled();
    expect(f.completeSpy).not.toHaveBeenCalled();
    expect(mocks.getAI).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('rejects explicit zero native limits and impossible zero-spend receipts despite actual usage', async () => {
    const f = fixture();
    const { receipt } = await execute(f);
    expect(receipt.reservation.spendMicros).toBeGreaterThan(0);
    if (!f.row) throw new Error('Expected governed fixture receipt.');
    for (const field of [
      'run_call_limit',
      'run_token_limit',
      'run_spend_limit',
      'reserved_spend_micros',
    ]) {
      const previous = f.row[field];
      f.row[field] = 0;
      expect(
        await readCurrentOpportunityAssessmentScreen(
          { opportunityId: 'opportunity-1', subject },
          f.deps,
        ),
      ).toBeUndefined();
      f.row[field] = previous;
    }
    expect(mocks.decide).toHaveBeenCalledOnce();
  });
  it('replays settled actual counters plus bounded outstanding reservations while preserving sunk request reservation', async () => {
    const f = fixture();
    const { prepared, receipt } = await execute(f);
    expect(f.row).toMatchObject({
      run_calls: 0,
      run_tokens: 0,
      run_spend: 0,
      run_actual_calls: 1,
      run_actual_tokens: 20,
      run_actual_output_tokens: 10,
      run_actual_spend: 1,
    });
    if (!f.row) throw new Error('Expected governed fixture receipt.');
    Object.assign(f.row, { run_calls: 1, run_tokens: 500, run_spend: 50 });
    expect(
      await readCurrentOpportunityAssessmentScreen(
        { opportunityId: 'opportunity-1', subject },
        f.deps,
      ),
    ).toEqual(receipt);
    expect(receipt.reservation.reservedTokens).toBe(
      prepared.requestBytes + prepared.maxOutputTokens,
    );
    expect(receipt.reservation.spendMicros).toBe(
      f.reservation?.reservedSpendMicros,
    );
    expect(mocks.decide).toHaveBeenCalledOnce();
  });
  it.each([
    ['run_calls', -1],
    ['run_tokens', null],
    ['run_spend', true],
    ['run_actual_calls', 0],
    ['run_actual_tokens', undefined],
    ['run_actual_output_tokens', NaN],
    ['run_actual_spend', -1],
    ['run_actual_tokens', 'malformed'],
    ['run_actual_spend', Infinity],
    ['run_calls', 4],
    ['run_tokens', 80000],
    ['run_spend', 100000],
    ['run_actual_calls', 5],
    ['run_actual_tokens', 80001],
    ['run_actual_spend', 100001],
    ['run_tokens', Number.MAX_SAFE_INTEGER],
  ] as const)('denies malformed or overbudget settled/outstanding %s=%s before any further provider transport', async (field, value) => {
    const f = fixture();
    await execute(f);
    if (!f.row) throw new Error('Expected governed fixture receipt.');
    f.row[field] = value;
    expect(
      await readCurrentOpportunityAssessmentScreen(
        { opportunityId: 'opportunity-1', subject },
        f.deps,
      ),
    ).toBeUndefined();
    expect(mocks.decide).toHaveBeenCalledOnce();
  });
  it('attests the exact prepared output reservation rather than the hard output cap', async () => {
    const f = fixture();
    const { prepared } = await execute(f);
    expect(prepared.maxOutputTokens).toBeLessThan(4096);
    if (!f.row) throw new Error('Expected governed fixture receipt.');
    f.row.requested_max_output_tokens = 4096;
    expect(
      await readCurrentOpportunityAssessmentScreen(
        { opportunityId: 'opportunity-1', subject },
        f.deps,
      ),
    ).toBeUndefined();
    expect(mocks.decide).toHaveBeenCalledOnce();
  });
  it('requires fresh selected profile ownership before any governor or provider call', async () => {
    const f = fixture();
    f.profile.ownerUserId = 'foreign-owner';
    await expect(
      prepareCurrentOpportunityAssessmentScreen(
        'opportunity-1',
        subject,
        f.deps,
      ),
    ).rejects.toThrow('not active and owned');
    expect(f.reserveSpy).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('loads both source and profile uncached through native collections', async () => {
    const f = fixture();
    const getOpportunity = vi.fn(async () => ({ toJSON: () => f.opportunity }));
    const getProfile = vi.fn(async () => ({ toJSON: () => f.profile }));
    mocks.getCollection.mockImplementation(async (name: string) => ({
      get: name === 'Opportunity' ? getOpportunity : getProfile,
    }));
    await prepareCurrentOpportunityAssessmentScreen('opportunity-1', subject, {
      runFresh: f.deps.runFresh,
    });
    expect(getOpportunity).toHaveBeenCalledWith(
      { id: 'opportunity-1' },
      { cache: false },
    );
    expect(getProfile).toHaveBeenCalledWith(
      { id: subject.profileId },
      { cache: false },
    );
  });
});
