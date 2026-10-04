import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV,
  OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_HARD_MAX,
  OPPORTUNITY_INTELLIGENCE_PROVIDER_WINDOW_LIMITS,
  OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_HARD_MAX,
  OPPORTUNITY_INTELLIGENCE_TYPESAFE_VOLUME_CONTRACTS,
  opportunityIntelligenceEnabled,
  opportunityIntelligenceProviderVolume,
  pricingForOpportunityIntelligenceModel,
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
  it('uses pinned model-specific GPT-6 prices and fails closed for unknown models', () => {
    expect(pricingForOpportunityIntelligenceModel('openai/gpt-6-luna')).toEqual(
      {
        configured: true,
        inputMicrosPerMillion: 100_000,
        outputMicrosPerMillion: 500_000,
      },
    );
    expect(
      pricingForOpportunityIntelligenceModel('openai/gpt-6.1-sol'),
    ).toEqual({
      configured: true,
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 10_000_000,
    });
    expect(
      pricingForOpportunityIntelligenceModel('openai/gpt-6-astra'),
    ).toMatchObject({
      configured: false,
    });
  });
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

describe('native provider volume contract classification', () => {
  it('pins JEV 10x while retaining OpenAI bounds independently', () => {
    expect(OPPORTUNITY_INTELLIGENCE_PROVIDER_WINDOW_LIMITS).toEqual({
      typesafe: { requests: 1000, inputTokens: 10000000 },
      openai: { requests: 100, inputTokens: 1000000 },
    });
  });
  it.each(
    OPPORTUNITY_INTELLIGENCE_TYPESAFE_VOLUME_CONTRACTS.flatMap((row) =>
      row.versions.map((version) => ({ ...row, version })),
    ),
  )('grants JEV only to exact configured native adapter $feature/$version', (contract) => {
    vi.stubEnv(
      'OPPORTUNITY_ASSESSMENT_DECISION_MODEL',
      'configured-assessment',
    );
    vi.stubEnv('OPPORTUNITY_SKILL_DECISION_MODEL', 'configured-skills');
    const identity = {
      feature: contract.feature,
      profile: contract.profile,
      model:
        contract.profile === 'typesafe-skills'
          ? 'configured-skills'
          : 'configured-assessment',
      promptVersion: contract.version,
      outputSchemaVersion: contract.version,
      preparedPayloadVersion: contract.version,
    };
    expect(opportunityIntelligenceProviderVolume(identity)).toBe('typesafe');
    for (const key of [
      'feature',
      'profile',
      'model',
      'promptVersion',
      'outputSchemaVersion',
      'preparedPayloadVersion',
    ] as const)
      expect(
        opportunityIntelligenceProviderVolume({
          ...identity,
          [key]: 'untrusted',
        }),
      ).toBe('openai');
  });
  it.each([
    'opportunity-screening/v1-jev-first',
    'opportunity-screening/v2-lossless-groups',
    'opportunity-screening/v3-self-contained-evidence',
    'opportunity-screening/v4-independent-source-entailment',
  ] as const)('classifies only the exact private screening adapter %s under its configured model', (version) => {
    vi.stubEnv(
      'OPPORTUNITY_ASSESSMENT_DECISION_MODEL',
      'configured-screen-model',
    );
    const identity = {
      feature: 'opportunity-screening',
      profile: 'typesafe-opportunity-screening',
      model: 'configured-screen-model',
      promptVersion: version,
      outputSchemaVersion: version,
      preparedPayloadVersion: version,
    };
    expect(opportunityIntelligenceProviderVolume(identity)).toBe('typesafe');
    const otherVersion =
      version === 'opportunity-screening/v2-lossless-groups'
        ? 'opportunity-screening/v3-self-contained-evidence'
        : 'opportunity-screening/v2-lossless-groups';
    for (const field of [
      'promptVersion',
      'outputSchemaVersion',
      'preparedPayloadVersion',
    ] as const)
      expect(
        opportunityIntelligenceProviderVolume({
          ...identity,
          [field]: otherVersion,
        }),
      ).toBe('openai');
    expect(
      opportunityIntelligenceProviderVolume({
        ...identity,
        profile: 'typesafe-opportunity-source-evidence',
      }),
    ).toBe('openai');
    expect(
      opportunityIntelligenceProviderVolume({
        ...identity,
        model: 'jev-untrusted-prefix',
      }),
    ).toBe('openai');
  });
  it('classifies the exact captured-source V4 adapter and denies the superseded reciprocal-only tuple', () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-latest');
    const version = 'requirement-evidence-audit/v4-captured-source-recovery';
    const identity = {
      feature: 'opportunity-source-requirement-evidence',
      profile: 'typesafe-opportunity-source-evidence',
      model: 'jev-latest',
      promptVersion: version,
      outputSchemaVersion: version,
      preparedPayloadVersion: version,
    };
    expect(opportunityIntelligenceProviderVolume(identity)).toBe('typesafe');
    const superseded = 'requirement-evidence-audit/v4-reciprocal-uncertainty';
    expect(
      opportunityIntelligenceProviderVolume({
        ...identity,
        promptVersion: superseded,
        outputSchemaVersion: superseded,
        preparedPayloadVersion: superseded,
      }),
    ).toBe('openai');
  });
  it('never grants JEV from a model name or supplied extra provider flag', () => {
    const identity = {
      feature: 'opportunity-extraction-chunk-1',
      profile: 'opportunity-intelligence-extraction',
      model: 'jev-latest',
      promptVersion: 'unknown',
      outputSchemaVersion: 'unknown',
      preparedPayloadVersion: 'unknown',
      provider: 'typesafe',
    };
    expect(opportunityIntelligenceProviderVolume(identity)).toBe('openai');
  });
  it('keeps historical and catalog-alias Sol review contracts on unchanged OpenAI quotas and pricing', () => {
    const historical = 'opportunity-resume-fit-review/v1-advisory';
    const current = 'opportunity-resume-fit-review/v2-catalog-aliases';
    const identity = {
      feature: 'opportunity-resume-fit-review',
      profile: 'opportunity-intelligence-scoring',
      model: 'openai/gpt-6.1-sol',
      promptVersion: current,
      outputSchemaVersion: current,
      preparedPayloadVersion: current,
    };
    expect(opportunityIntelligenceProviderVolume(identity)).toBe('openai');
    expect(
      opportunityIntelligenceProviderVolume({
        ...identity,
        promptVersion: historical,
        outputSchemaVersion: historical,
        preparedPayloadVersion: historical,
      }),
    ).toBe('openai');
    for (const key of [
      'promptVersion',
      'outputSchemaVersion',
      'preparedPayloadVersion',
    ] as const)
      expect(
        opportunityIntelligenceProviderVolume({
          ...identity,
          [key]: historical,
        }),
      ).toBe('openai');
    expect(
      opportunityIntelligenceProviderVolume({
        ...identity,
        model: 'jev-latest',
      }),
    ).toBe('openai');
    expect(pricingForOpportunityIntelligenceModel(identity.model)).toEqual({
      configured: true,
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 10_000_000,
    });
  });
  it('classifies only the exact V5 quarantine tuple and preserves paid V4 classification', () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-latest');
    const version = 'requirement-evidence-audit/v5-quarantined-source-recovery';
    const legacy = 'requirement-evidence-audit/v4-captured-source-recovery';
    const identity = {
      feature: 'opportunity-source-requirement-evidence',
      profile: 'typesafe-opportunity-source-evidence',
      model: 'jev-latest',
      promptVersion: version,
      outputSchemaVersion: version,
      preparedPayloadVersion: version,
    };
    expect(opportunityIntelligenceProviderVolume(identity)).toBe('typesafe');
    expect(
      opportunityIntelligenceProviderVolume({
        ...identity,
        promptVersion: legacy,
        outputSchemaVersion: legacy,
        preparedPayloadVersion: legacy,
      }),
    ).toBe('typesafe');
    for (const key of [
      'promptVersion',
      'outputSchemaVersion',
      'preparedPayloadVersion',
    ] as const)
      expect(
        opportunityIntelligenceProviderVolume({ ...identity, [key]: legacy }),
      ).toBe('openai');
    expect(
      opportunityIntelligenceProviderVolume({
        ...identity,
        model: 'jev-unregistered',
      }),
    ).toBe('openai');
    expect(
      opportunityIntelligenceProviderVolume({
        ...identity,
        profile: 'typesafe-unregistered',
      }),
    ).toBe('openai');
  });
});
