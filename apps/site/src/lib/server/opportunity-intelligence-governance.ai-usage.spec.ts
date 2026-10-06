import { afterEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  reserve: vi.fn(),
  settle: vi.fn(async (_micros: number, _basis?: string) => {}),
}));

vi.mock('./ai-usage-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-usage-guard.js')>()),
  reserveAiUserSpend: guard.reserve,
}));

import { AiUsageRefusedError } from './ai-usage-guard.js';
import {
  executeGovernedOpportunityIntelligenceRequest,
  type OpportunityIntelligenceGovernanceStore,
  type OpportunityIntelligenceReserveResult,
} from './opportunity-intelligence-governance.js';

const config = {
  circuit: { inputTokenThreshold: 100_000, requestThreshold: 20 },
  crawl: { calls: 10, inputTokens: 100_000, spendMicros: 1_000_000 },
  enabled: true,
  pricing: {
    configured: true,
    inputMicrosPerMillion: 100_000,
    outputMicrosPerMillion: 400_000,
  },
  run: { calls: 4, inputTokens: 20_000, spendMicros: 100_000 },
};

const identity = {
  agentRunId: 'run-1',
  contentFingerprint: 'content-v1',
  feature: 'opportunity-resume-fit-review',
  model: 'openai/gpt-5.6-luna',
  opportunityId: 'opportunity-1',
  outputSchemaVersion: 'schema/v1',
  preparedPayloadVersion: 'prepared/v1',
  profile: 'opportunity-intelligence-fallback',
  promptVersion: 'prompt/v1',
};

const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

function fakeStore(
  reserveResult?: (
    reservation: Parameters<
      OpportunityIntelligenceGovernanceStore['reserve']
    >[0],
  ) => OpportunityIntelligenceReserveResult<unknown>,
) {
  return {
    complete: vi.fn(async () => {}),
    openCircuit: vi.fn(async () => {}),
    reserve: vi.fn(async (reservation) =>
      reserveResult
        ? reserveResult(reservation)
        : { kind: 'owner', reservation },
    ),
  } as unknown as OpportunityIntelligenceGovernanceStore & {
    complete: ReturnType<typeof vi.fn>;
    openCircuit: ReturnType<typeof vi.fn>;
    reserve: ReturnType<typeof vi.fn>;
  };
}

const run = (
  store: OpportunityIntelligenceGovernanceStore,
  invoke: () => Promise<{ output: string; usage?: object }>,
  owner: typeof subject | null = subject,
) =>
  executeGovernedOpportunityIntelligenceRequest<string>({
    config,
    estimatedInputTokens: 100,
    identity,
    inputTokenCeiling: 200,
    invoke: invoke as never,
    maxOutputTokens: 100,
    store,
    workspaceSubject: owner ?? undefined,
  });

afterEach(() => {
  vi.unstubAllEnvs();
  guard.reserve.mockReset();
  guard.settle.mockClear();
  guard.release.mockClear();
});

function grant() {
  guard.reserve.mockResolvedValue({
    release: guard.release,
    settle: guard.settle,
    snapshot: {},
  });
}

describe('governed requests and per-user AI spend', () => {
  it('bills a candidate-owned call to its owner and settles actual cost', async () => {
    grant();
    const store = fakeStore();
    const invoke = vi.fn(async () => ({
      output: 'ok',
      usage: { completionTokens: 10, promptTokens: 50 },
    }));
    await run(store, invoke);
    expect(guard.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'opportunity-resume-fit-review',
        micros: expect.any(Number),
        subject: { tenantId: 'tenant-1', userId: 'user-1' },
      }),
    );
    // Actual usage (50 in, 10 out) is below the worst-case reserve.
    expect(guard.settle).toHaveBeenCalledWith(expect.any(Number), 'actual');
    const reserved = guard.reserve.mock.calls[0][0].micros as number;
    expect(guard.settle.mock.calls[0][0]).toBeLessThan(reserved);
    expect(guard.release).not.toHaveBeenCalled();
  });

  it('refuses with no provider call and no governance ledger row when the cap is hit', async () => {
    guard.reserve.mockRejectedValue(
      new AiUsageRefusedError(
        'user_budget_exhausted',
        'You have reached your AI usage budget.',
      ),
    );
    const store = fakeStore();
    const invoke = vi.fn();
    await expect(run(store, invoke)).rejects.toMatchObject({
      code: 'user_budget_exhausted',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(store.reserve).not.toHaveBeenCalled();
    expect(store.openCircuit).not.toHaveBeenCalled();
  });

  it('does not bill the user for reused results or governance blocks', async () => {
    grant();
    await run(
      fakeStore(() => ({ kind: 'reused', output: 'cached', requestId: 'r' })),
      vi.fn(),
    );
    expect(guard.release).toHaveBeenCalledTimes(1);
    expect(guard.settle).not.toHaveBeenCalled();

    guard.release.mockClear();
    await expect(
      run(
        fakeStore(() => ({
          code: 'budget_exhausted',
          kind: 'blocked',
          message: 'run budget',
        })),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(guard.release).toHaveBeenCalledTimes(1);
    expect(guard.settle).not.toHaveBeenCalled();
  });

  it('keeps the full reservation when the provider fails without usage', async () => {
    grant();
    await expect(
      run(
        fakeStore(),
        vi.fn(async () => {
          throw new Error('provider down');
        }),
      ),
    ).rejects.toThrow('provider down');
    const reserved = guard.reserve.mock.calls[0][0].micros as number;
    expect(guard.settle).toHaveBeenCalledWith(reserved, 'conservative');
    expect(guard.release).not.toHaveBeenCalled();
  });

  it('never bills platform work that has no workspace subject', async () => {
    const store = fakeStore();
    await run(
      store,
      vi.fn(async () => ({
        output: 'ok',
        usage: { completionTokens: 1, promptTokens: 1 },
      })),
      null,
    );
    expect(guard.reserve).not.toHaveBeenCalled();
    expect(store.reserve).toHaveBeenCalledTimes(1);
  });

  it('the global kill switch refuses every call before any ledger or provider work', async () => {
    vi.stubEnv('IOLAUS_AI_DISABLED', 'true');
    for (const owner of [subject, null]) {
      const store = fakeStore();
      const invoke = vi.fn();
      await expect(run(store, invoke, owner)).rejects.toMatchObject({
        code: 'ai_disabled',
        status: 503,
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(store.reserve).not.toHaveBeenCalled();
      // The switch is not latched into the persisted circuit.
      expect(store.openCircuit).not.toHaveBeenCalled();
    }
    expect(guard.reserve).not.toHaveBeenCalled();
  });
});
