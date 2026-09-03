import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV,
  OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_HARD_MAX,
  OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_HARD_MAX,
  opportunityIntelligenceEnabled,
  reservedRequestSpendMicros,
  resolveOpportunityIntelligenceBudgetConfig,
  resolveOpportunityIntelligenceEnqueueCap,
  resolveOpportunityScoringConfig,
} from './opportunity-intelligence-config';

const originalValue = process.env[OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV];

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalValue === undefined) {
    delete process.env[OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV];
  } else {
    process.env[OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV] = originalValue;
  }
});

describe('opportunity intelligence enqueue config', () => {
  it('fails closed for missing, malformed, or negative limits', () => {
    delete process.env[OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV];
    expect(resolveOpportunityIntelligenceEnqueueCap()).toBe(0);

    process.env[OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV] = 'many';
    expect(resolveOpportunityIntelligenceEnqueueCap()).toBe(0);
    expect(resolveOpportunityIntelligenceEnqueueCap(-1)).toBe(0);
  });

  it('honors zero as the kill switch and clamps configured limits', () => {
    process.env[OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV] = '0';
    expect(resolveOpportunityIntelligenceEnqueueCap()).toBe(0);
    expect(
      resolveOpportunityIntelligenceEnqueueCap(
        OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_HARD_MAX + 1,
      ),
    ).toBe(OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_HARD_MAX);
  });

  it('fails closed when governance budgets, pricing, or enablement are missing', () => {
    const config = resolveOpportunityIntelligenceBudgetConfig();
    expect(config).toMatchObject({
      circuit: { inputTokenThreshold: 0, requestThreshold: 0 },
      crawl: { calls: 0, inputTokens: 0, spendMicros: 0 },
      enabled: false,
      pricing: { configured: false },
      run: { calls: 0, inputTokens: 0, spendMicros: 0 },
    });
    expect(opportunityIntelligenceEnabled()).toBe(false);
    expect(
      reservedRequestSpendMicros({
        inputTokens: 1_000,
        maxOutputTokens: 2_048,
        pricing: config.pricing,
      }),
    ).toBe(0);
  });

  it('preserves lower crawl-derived circuit defaults when thresholds are unset', () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT', '5');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_INPUT_TOKEN_LIMIT', '20000');

    expect(resolveOpportunityIntelligenceBudgetConfig().circuit).toEqual({
      inputTokenThreshold: 20_000,
      requestThreshold: 5,
    });
  });

  it('allows operators to disable only the cumulative volume thresholds', () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CIRCUIT_REQUEST_THRESHOLD', '0');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CIRCUIT_INPUT_TOKEN_THRESHOLD', '0');

    expect(resolveOpportunityIntelligenceBudgetConfig().circuit).toEqual({
      inputTokenThreshold: 0,
      requestThreshold: 0,
    });
  });

  it('falls back safely for malformed circuit thresholds and clamps large values', () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT', '5');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CIRCUIT_REQUEST_THRESHOLD', 'many');
    vi.stubEnv(
      'OPPORTUNITY_INTELLIGENCE_CIRCUIT_INPUT_TOKEN_THRESHOLD',
      '999999999',
    );

    expect(resolveOpportunityIntelligenceBudgetConfig().circuit).toEqual({
      inputTokenThreshold: 1_000_000,
      requestThreshold: 5,
    });
  });

  it('calculates a conservative microdollar reservation from configured rates', () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_ENABLED', 'true');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT', '5');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_INPUT_TOKEN_LIMIT', '20000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CRAWL_SPEND_LIMIT_MICROS', '500000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT', '4');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT', '10000');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS', '250000');
    vi.stubEnv(
      'OPPORTUNITY_INTELLIGENCE_INPUT_COST_MICROS_PER_MILLION',
      '100000',
    );
    vi.stubEnv(
      'OPPORTUNITY_INTELLIGENCE_OUTPUT_COST_MICROS_PER_MILLION',
      '400000',
    );

    const config = resolveOpportunityIntelligenceBudgetConfig();
    expect(config.enabled).toBe(true);
    expect(config.pricing.configured).toBe(true);
    expect(
      reservedRequestSpendMicros({
        inputTokens: 6_000,
        maxOutputTokens: 2_000,
        pricing: config.pricing,
      }),
    ).toBe(1_400);
  });

  it('keeps optional model scoring independently disabled and hard-clamps scoring policy', () => {
    expect(resolveOpportunityScoringConfig()).toMatchObject({
      clearAcceptMinRequired: 0,
      clearRejectMinGaps: 0,
      inputTokenCeiling: 3_000,
      modelEnabled: false,
    });

    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_MODEL_SCORING_ENABLED', 'true');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CLEAR_ACCEPT_MIN_REQUIRED', '999');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_CLEAR_REJECT_MIN_GAPS', '2');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_SCORING_MAX_INPUT_TOKENS', '999999');
    expect(resolveOpportunityScoringConfig()).toMatchObject({
      clearAcceptMinRequired: 20,
      clearRejectMinGaps: 2,
      inputTokenCeiling: OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_HARD_MAX,
      modelEnabled: true,
    });
  });
});
