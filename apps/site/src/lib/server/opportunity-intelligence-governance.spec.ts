import { describe, expect, it, vi } from 'vitest';
import {
  attachOpportunityIntelligenceInvocationMetadata,
  DatabaseOpportunityIntelligenceGovernanceStore,
  executeGovernedOpportunityIntelligenceRequest,
  getOpportunityIntelligenceControlStatus,
  normalizeOpportunityIntelligenceCircuitThreshold,
  type OpportunityIntelligenceGovernanceError,
  type OpportunityIntelligenceGovernanceStore,
  type OpportunityIntelligenceReservation,
  type OpportunityIntelligenceReserveResult,
  type OpportunityIntelligenceTerminalResult,
  opportunityIntelligenceIdempotencyKey,
  reconcileOpportunityIntelligenceStatuses,
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
  feature: 'opportunity-extraction',
  model: 'openai/gpt-5.6-luna',
  opportunityId: 'opportunity-1',
  outputSchemaVersion: 'schema/v1',
  preparedPayloadVersion: 'prepared/v1',
  profile: 'opportunity-intelligence-fallback',
  promptVersion: 'prompt/v1',
  sourceCrawlId: 'crawl-1',
  sourceCrawlItemId: 'item-1',
};

interface StoredResult {
  output?: unknown;
  reservation: OpportunityIntelligenceReservation;
  status: 'completed' | 'failed' | 'started';
}

class MemoryStore implements OpportunityIntelligenceGovernanceStore {
  circuitOpen = false;
  maxCalls = 10;
  results = new Map<string, StoredResult>();
  terminal: Array<
    OpportunityIntelligenceTerminalResult<unknown> & {
      actualSpendMicros: number;
    }
  > = [];

  async reserve<T>(
    reservation: OpportunityIntelligenceReservation,
  ): Promise<OpportunityIntelligenceReserveResult<T>> {
    if (this.circuitOpen) {
      return {
        code: 'circuit_open',
        kind: 'blocked',
        message: 'Circuit is open.',
      };
    }
    const existing = this.results.get(reservation.idempotencyKey);
    if (existing?.status === 'completed') {
      return {
        kind: 'reused',
        output: existing.output as T,
        requestId: existing.reservation.requestId,
      };
    }
    if (existing) {
      return {
        code:
          existing.status === 'failed'
            ? 'prior_attempt_failed'
            : 'duplicate_in_progress',
        kind: 'blocked',
        message: 'Duplicate suppressed.',
      };
    }
    if (this.results.size >= this.maxCalls) {
      return {
        code: 'budget_exhausted',
        kind: 'blocked',
        message: 'Budget exhausted.',
      };
    }
    this.results.set(reservation.idempotencyKey, {
      reservation,
      status: 'started',
    });
    return { kind: 'owner', reservation };
  }

  async complete<T>(
    reservation: OpportunityIntelligenceReservation,
    terminal: OpportunityIntelligenceTerminalResult<T> & {
      actualSpendMicros: number;
    },
  ): Promise<void> {
    this.terminal.push(terminal);
    this.results.set(reservation.idempotencyKey, {
      output: terminal.output,
      reservation,
      status: terminal.status === 'succeeded' ? 'completed' : 'failed',
    });
    if (terminal.accountingBasis === 'missing') this.circuitOpen = true;
  }

  async openCircuit(): Promise<void> {
    this.circuitOpen = true;
  }
}

function execute(
  store: MemoryStore,
  invoke: Parameters<
    typeof executeGovernedOpportunityIntelligenceRequest<
      Record<string, unknown>
    >
  >[0]['invoke'],
) {
  return executeGovernedOpportunityIntelligenceRequest({
    config,
    estimatedInputTokens: 900,
    identity,
    inputTokenCeiling: 1_000,
    invoke,
    maxOutputTokens: 2_048,
    store,
  });
}

describe('opportunity intelligence governance', () => {
  it('accepts only explicit non-negative circuit thresholds', () => {
    expect(
      normalizeOpportunityIntelligenceCircuitThreshold(undefined, 20, 100),
    ).toBe(20);
    expect(normalizeOpportunityIntelligenceCircuitThreshold(0, 20, 100)).toBe(
      0,
    );
    expect(normalizeOpportunityIntelligenceCircuitThreshold(999, 20, 100)).toBe(
      100,
    );
    expect(() =>
      normalizeOpportunityIntelligenceCircuitThreshold(-1, 20, 100),
    ).toThrow('must be non-negative integers');
    expect(() =>
      normalizeOpportunityIntelligenceCircuitThreshold(Number.NaN, 20, 100),
    ).toThrow('must be non-negative integers');
    expect(() =>
      normalizeOpportunityIntelligenceCircuitThreshold(undefined, null, 100),
    ).toThrow('must be non-negative integers');
  });

  it('builds a composite key from all paid-work provenance', () => {
    const baseline = opportunityIntelligenceIdempotencyKey(identity);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(
      opportunityIntelligenceIdempotencyKey({
        ...identity,
        promptVersion: 'prompt/v2',
      }),
    ).not.toBe(baseline);
    expect(
      opportunityIntelligenceIdempotencyKey({
        ...identity,
        model: 'zai/glm-4.7-flashx',
      }),
    ).not.toBe(baseline);
    expect(
      opportunityIntelligenceIdempotencyKey({
        ...identity,
        inputFingerprint: 'bounded-score-input-v2',
      }),
    ).not.toBe(baseline);
  });

  it('suppresses concurrent duplicate delivery before a second paid call', async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async () => {
      await held;
      return {
        output: { title: 'Engineer' },
        usage: { completionTokens: 20, promptTokens: 900, totalTokens: 920 },
      };
    });

    const first = execute(store, invoke);
    await Promise.resolve();
    await expect(execute(store, invoke)).rejects.toMatchObject({
      code: 'duplicate_in_progress',
    });
    release();
    await expect(first).resolves.toMatchObject({ reused: false });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('reuses a completed result after restart without invoking transport', async () => {
    const store = new MemoryStore();
    await execute(store, async () => ({
      output: { workMode: 'remote' },
      usage: { completionTokens: 10, promptTokens: 800, totalTokens: 810 },
    }));
    const secondTransport = vi.fn();

    await expect(execute(store, secondTransport)).resolves.toMatchObject({
      output: { workMode: 'remote' },
      reused: true,
    });
    expect(secondTransport).not.toHaveBeenCalled();
    expect(store.results.values().next().value?.reservation).toMatchObject({
      reservedInputTokens: 1_000,
      reservedSpendMicros: 920,
    });
  });

  it('fails closed after missing required usage accounting', async () => {
    const store = new MemoryStore();
    await expect(
      execute(store, async () => ({ output: { title: 'Engineer' } })),
    ).rejects.toMatchObject({ code: 'accounting_required' });
    expect(store.circuitOpen).toBe(true);
    expect(store.terminal.at(-1)).toMatchObject({
      actualSpendMicros: expect.any(Number),
      status: 'failed',
    });

    await expect(
      execute(store, async () => ({
        output: {},
        usage: { completionTokens: 0, promptTokens: 1, totalTokens: 1 },
      })),
    ).rejects.toMatchObject({ code: 'circuit_open' });
  });

  it('persists returned usage when response parsing fails', async () => {
    const store = new MemoryStore();
    const parseError = new Error('invalid provider JSON');

    await expect(
      execute(store, async () => {
        throw attachOpportunityIntelligenceInvocationMetadata(parseError, {
          providerRequestId: 'provider-request-1',
          usage: {
            completionTokens: 20,
            promptTokens: 800,
            totalTokens: 820,
          },
        });
      }),
    ).rejects.toThrow('invalid provider JSON');
    expect(store.terminal.at(-1)).toMatchObject({
      actualSpendMicros: 88,
      providerRequestId: 'provider-request-1',
      status: 'failed',
      usage: { completionTokens: 20, promptTokens: 800, totalTokens: 820 },
    });
    expect(store.circuitOpen).toBe(false);
  });

  it('conservatively accounts a provider failure without reporting missing usage', async () => {
    const store = new MemoryStore();

    await expect(
      execute(store, async () => {
        throw Object.assign(new Error('provider unavailable'), {
          code: 'PROVIDER_UNAVAILABLE',
        });
      }),
    ).rejects.toThrow('provider unavailable');

    expect(store.circuitOpen).toBe(false);
    expect(store.terminal.at(-1)).toMatchObject({
      accountingBasis: 'conservative',
      actualSpendMicros: 920,
      errorCode: 'PROVIDER_UNAVAILABLE',
      status: 'failed',
      usage: undefined,
    });
  });

  it('atomically settles missing failure usage at the full reservation', async () => {
    let requestSettlement: unknown[] = [];
    let runSettlement: unknown[] = [];
    let controlSettlement: unknown[] = [];
    const transactionDb = {
      query: vi.fn(async (sql: string, parameters: unknown[] = []) => {
        if (sql.includes('UPDATE opportunity_intelligence_requests')) {
          requestSettlement = parameters;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('UPDATE opportunity_intelligence_results')) {
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('UPDATE agent_runs')) {
          runSettlement = parameters;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('FROM opportunity_intelligence_controls')) {
          return {
            rowCount: 1,
            rows: [
              {
                abort_threshold: 3,
                consecutive_aborts: 0,
                consecutive_failures: 0,
                failure_threshold: 3,
                id: 'control-1',
                latency_threshold_ms: 100_000,
              },
            ],
          };
        }
        if (sql.includes('UPDATE opportunity_intelligence_controls')) {
          controlSettlement = parameters;
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected transactional query: ${sql}`);
      }),
    };
    const database = {
      query: vi.fn(),
      transaction: vi.fn(
        async (callback: (db: unknown) => Promise<unknown>) =>
          await callback(transactionDb),
      ),
    };
    const store = new DatabaseOpportunityIntelligenceGovernanceStore(
      database as never,
    );
    const reservation: OpportunityIntelligenceReservation = {
      ...identity,
      estimatedInputTokens: 900,
      idempotencyKey: opportunityIntelligenceIdempotencyKey(identity),
      inputTokenCeiling: 1_000,
      maxOutputTokens: 2_048,
      requestId: 'request-1',
      reservedInputTokens: 1_000,
      reservedSpendMicros: 2_000,
      sourceCrawlId: '',
    };

    await store.complete(reservation, {
      accountingBasis: 'conservative',
      actualSpendMicros: 2_000,
      durationMs: 25,
      errorCode: 'PROVIDER_UNAVAILABLE',
      status: 'failed',
    });

    expect(requestSettlement).toEqual([
      'request-1',
      'failed',
      1_000,
      2_048,
      3_048,
      2_000,
      'conservative',
      25,
      'PROVIDER_UNAVAILABLE',
      'request-1',
    ]);
    expect(runSettlement).toEqual([1_000, 2_000, 1_000, 2_048, 2_000, 'run-1']);
    expect(controlSettlement).toEqual([0, 1, '', '', '', '', 'control-1']);
  });

  it('opens the independent circuit when successful usage cannot be persisted', async () => {
    class FailingAccountingStore extends MemoryStore {
      override async complete(): Promise<void> {
        throw new Error('database unavailable');
      }
    }
    const store = new FailingAccountingStore();

    await expect(
      execute(store, async () => ({
        output: { title: 'Engineer' },
        usage: { completionTokens: 20, promptTokens: 900, totalTokens: 920 },
      })),
    ).rejects.toMatchObject({ code: 'accounting_required' });
    expect(store.circuitOpen).toBe(true);
  });

  it('reports the failing step, accounting basis, affected statuses, and recovery action', async () => {
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM opportunity_intelligence_controls')) {
          return {
            rows: [
              {
                circuit_reason: 'usage_accounting_missing',
                circuit_state: 'open',
                consecutive_aborts: 0,
                consecutive_failures: 1,
                enabled: true,
                input_token_threshold: 0,
                request_threshold: 0,
                window_input_tokens: 6_000,
                window_request_count: 1,
              },
            ],
          };
        }
        if (sql.includes('FROM opportunity_intelligence_requests')) {
          return {
            rows: [
              {
                accounting_basis: 'missing',
                error_code: 'usage_accounting_missing',
                feature: 'opportunity-extraction-chunk-1',
                finished_at: '2026-08-26T06:32:10.000Z',
                status: 'failed',
              },
            ],
          };
        }
        if (sql.includes('FROM opportunities')) {
          return {
            rows: [
              {
                cap_exhausted: 7,
                failed: 3,
                queued_without_active_job: 5,
              },
            ],
          };
        }
        if (sql.includes("queue = 'opportunity-intelligence'")) {
          return { rows: [{ count: 2, status: 'pending' }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    await expect(
      getOpportunityIntelligenceControlStatus(database as never),
    ).resolves.toMatchObject({
      affectedOpportunities: {
        capExhausted: 7,
        failed: 3,
        queuedWithoutActiveJob: 5,
      },
      latestFailure: {
        accountingBasis: 'missing',
        errorCode: 'usage_accounting_missing',
        feature: 'opportunity-extraction-chunk-1',
      },
      pendingJobs: 2,
      recoveryAction: expect.stringContaining('reconcile-status'),
    });
  });

  it('reconciles only terminal queued statuses without active fingerprint work', async () => {
    const database = {
      query: vi.fn(async () => ({ rowCount: 12, rows: [] })),
    };

    await expect(
      reconcileOpportunityIntelligenceStatuses(database as never),
    ).resolves.toEqual({ markedFailed: 12 });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("source_intelligence_status = 'failed'"),
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("job.status IN ('pending', 'running')"),
    );
  });

  it('rolls back a run reservation when the crawl budget is missing', async () => {
    const state = {
      circuitReason: '',
      runReservations: 0,
    };
    let transactionalRunReservations = state.runReservations;
    const transactionDb = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO opportunity_intelligence_results')) {
          return { rowCount: 1, rows: [{ id: 'result-1' }] };
        }
        if (sql.includes('FROM opportunity_intelligence_controls')) {
          return {
            rowCount: 1,
            rows: [
              {
                circuit_state: 'closed',
                enabled: true,
                id: 'control-1',
                input_token_threshold: 100_000,
                request_threshold: 20,
                window_input_tokens: 0,
                window_request_count: 0,
              },
            ],
          };
        }
        if (sql.includes('FROM agent_runs')) {
          return {
            rowCount: 1,
            rows: [
              {
                intelligence_actual_calls: 0,
                intelligence_actual_input_tokens: 0,
                intelligence_actual_spend_micros: 0,
                intelligence_call_limit: 4,
                intelligence_input_token_limit: 20_000,
                intelligence_reserved_calls: 0,
                intelligence_reserved_input_tokens: 0,
                intelligence_reserved_spend_micros: 0,
                intelligence_spend_limit_micros: 100_000,
              },
            ],
          };
        }
        if (sql.includes('UPDATE agent_runs')) {
          transactionalRunReservations += 1;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('FROM source_crawls')) {
          return { rowCount: 0, rows: [] };
        }
        throw new Error(`Unexpected transactional query: ${sql}`);
      }),
    };
    const database = {
      query: vi.fn(async (_sql: string, parameters: unknown[]) => {
        state.circuitReason = String(parameters[0]);
        return { rowCount: 1, rows: [] };
      }),
      transaction: vi.fn(
        async (callback: (db: unknown) => Promise<unknown>) => {
          transactionalRunReservations = state.runReservations;
          try {
            const result = await callback(transactionDb);
            state.runReservations = transactionalRunReservations;
            return result;
          } catch (error) {
            transactionalRunReservations = state.runReservations;
            throw error;
          }
        },
      ),
    };
    const store = new DatabaseOpportunityIntelligenceGovernanceStore(
      database as never,
    );
    const reservation: OpportunityIntelligenceReservation = {
      ...identity,
      estimatedInputTokens: 900,
      idempotencyKey: opportunityIntelligenceIdempotencyKey(identity),
      inputTokenCeiling: 1_000,
      maxOutputTokens: 2_048,
      requestId: 'request-1',
      reservedInputTokens: 1_000,
      reservedSpendMicros: 2_000,
    };

    await expect(store.reserve(reservation)).resolves.toMatchObject({
      code: 'budget_missing',
      kind: 'blocked',
    });
    expect(state.runReservations).toBe(0);
    expect(state.circuitReason).toBe('crawl_budget_missing');
  });

  it('retains cumulative telemetry when both volume thresholds are disabled', async () => {
    let persistedWindow: unknown[] = [];
    const transactionDb = {
      query: vi.fn(async (sql: string, parameters: unknown[] = []) => {
        if (sql.includes('INSERT INTO opportunity_intelligence_results')) {
          return { rowCount: 1, rows: [{ id: 'result-1' }] };
        }
        if (sql.includes('FROM opportunity_intelligence_controls')) {
          return {
            rowCount: 1,
            rows: [
              {
                circuit_state: 'closed',
                enabled: true,
                id: 'control-1',
                input_token_threshold: 0,
                request_threshold: 0,
                window_input_tokens: 250_000,
                window_request_count: 250,
              },
            ],
          };
        }
        if (sql.includes('FROM agent_runs')) {
          return {
            rowCount: 1,
            rows: [
              {
                intelligence_actual_calls: 0,
                intelligence_actual_input_tokens: 0,
                intelligence_actual_spend_micros: 0,
                intelligence_call_limit: 4,
                intelligence_input_token_limit: 20_000,
                intelligence_reserved_calls: 0,
                intelligence_reserved_input_tokens: 0,
                intelligence_reserved_spend_micros: 0,
                intelligence_spend_limit_micros: 100_000,
              },
            ],
          };
        }
        if (
          sql.includes('UPDATE agent_runs') ||
          sql.includes('INSERT INTO opportunity_intelligence_requests')
        ) {
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('UPDATE opportunity_intelligence_controls')) {
          persistedWindow = parameters;
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected transactional query: ${sql}`);
      }),
    };
    const database = {
      query: vi.fn(),
      transaction: vi.fn(
        async (callback: (db: unknown) => Promise<unknown>) =>
          await callback(transactionDb),
      ),
    };
    const store = new DatabaseOpportunityIntelligenceGovernanceStore(
      database as never,
    );
    const reservation: OpportunityIntelligenceReservation = {
      ...identity,
      estimatedInputTokens: 900,
      idempotencyKey: opportunityIntelligenceIdempotencyKey(identity),
      inputTokenCeiling: 1_000,
      maxOutputTokens: 2_048,
      requestId: 'request-1',
      reservedInputTokens: 1_000,
      reservedSpendMicros: 2_000,
      sourceCrawlId: '',
    };

    await expect(store.reserve(reservation)).resolves.toMatchObject({
      kind: 'owner',
    });
    expect(persistedWindow).toEqual([251, 251_000, 'control-1']);
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each([
    {
      inputTokenThreshold: 0,
      reason: 'request_volume_threshold_invalid',
      requestThreshold: null,
    },
    {
      inputTokenThreshold: 'invalid',
      reason: 'input_token_threshold_invalid',
      requestThreshold: 0,
    },
    {
      inputTokenThreshold: 0,
      reason: 'request_volume_threshold_invalid',
      requestThreshold: 101,
    },
    {
      inputTokenThreshold: 1_000_001,
      reason: 'input_token_threshold_invalid',
      requestThreshold: 0,
    },
  ])('fails closed for malformed persisted circuit thresholds ($reason)', async ({
    inputTokenThreshold,
    reason,
    requestThreshold,
  }) => {
    const transactionDb = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO opportunity_intelligence_results')) {
          return { rowCount: 1, rows: [{ id: 'result-1' }] };
        }
        if (sql.includes('FROM opportunity_intelligence_controls')) {
          return {
            rowCount: 1,
            rows: [
              {
                circuit_state: 'closed',
                enabled: true,
                id: 'control-1',
                input_token_threshold: inputTokenThreshold,
                request_threshold: requestThreshold,
                window_input_tokens: 0,
                window_request_count: 0,
              },
            ],
          };
        }
        throw new Error(`Unexpected transactional query: ${sql}`);
      }),
    };
    const database = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
      transaction: vi.fn(
        async (callback: (db: unknown) => Promise<unknown>) =>
          await callback(transactionDb),
      ),
    };
    const store = new DatabaseOpportunityIntelligenceGovernanceStore(
      database as never,
    );
    const reservation: OpportunityIntelligenceReservation = {
      ...identity,
      estimatedInputTokens: 900,
      idempotencyKey: opportunityIntelligenceIdempotencyKey(identity),
      inputTokenCeiling: 1_000,
      maxOutputTokens: 2_048,
      requestId: 'request-1',
      reservedInputTokens: 1_000,
      reservedSpendMicros: 2_000,
      sourceCrawlId: '',
    };

    await expect(store.reserve(reservation)).resolves.toMatchObject({
      code: 'budget_missing',
      kind: 'blocked',
    });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE opportunity_intelligence_controls'),
      [reason, 'opportunity-intelligence'],
    );
  });

  it('keeps failed and exhausted keys fail-closed across redelivery', async () => {
    const failedStore = new MemoryStore();
    await expect(
      execute(failedStore, async () => {
        throw new Error('provider unavailable');
      }),
    ).rejects.toThrow('provider unavailable');
    await expect(
      execute(failedStore, async () => ({
        output: {},
        usage: { completionTokens: 0, promptTokens: 1, totalTokens: 1 },
      })),
    ).rejects.toMatchObject({ code: 'prior_attempt_failed' });

    const exhaustedStore = new MemoryStore();
    exhaustedStore.maxCalls = 0;
    await expect(
      execute(exhaustedStore, async () => ({
        output: {},
        usage: { completionTokens: 0, promptTokens: 1, totalTokens: 1 },
      })),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });
  });

  it('rejects before reservation when the hard input ceiling is exceeded', async () => {
    const store = new MemoryStore();
    await expect(
      executeGovernedOpportunityIntelligenceRequest({
        config,
        estimatedInputTokens: 1_001,
        identity,
        inputTokenCeiling: 1_000,
        invoke: vi.fn(),
        maxOutputTokens: 2_048,
        store,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<OpportunityIntelligenceGovernanceError>>({
        code: 'input_ceiling_exceeded',
      }),
    );
    expect(store.results.size).toBe(0);
    expect(store.circuitOpen).toBe(true);
  });

  it('fails closed when transactional governance is unavailable', async () => {
    const store = new DatabaseOpportunityIntelligenceGovernanceStore({
      query: vi.fn(),
    } as never);
    const reservation: OpportunityIntelligenceReservation = {
      ...identity,
      estimatedInputTokens: 900,
      idempotencyKey: opportunityIntelligenceIdempotencyKey(identity),
      inputTokenCeiling: 1_000,
      maxOutputTokens: 2_048,
      requestId: 'request-1',
      reservedInputTokens: 1_000,
      reservedSpendMicros: 2_000,
    };

    await expect(store.reserve(reservation)).resolves.toMatchObject({
      code: 'budget_missing',
      kind: 'blocked',
    });
  });
});
