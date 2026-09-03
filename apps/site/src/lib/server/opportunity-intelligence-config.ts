export const OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV =
  'OPPORTUNITY_INTELLIGENCE_MAX_ENQUEUES_PER_CRAWL';
export const OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_HARD_MAX = 100;
export const OPPORTUNITY_INTELLIGENCE_ENABLED_ENV =
  'OPPORTUNITY_INTELLIGENCE_ENABLED';
export const OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT_ENV =
  'OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT';
export const OPPORTUNITY_INTELLIGENCE_CRAWL_INPUT_TOKEN_LIMIT_ENV =
  'OPPORTUNITY_INTELLIGENCE_CRAWL_INPUT_TOKEN_LIMIT';
export const OPPORTUNITY_INTELLIGENCE_CRAWL_SPEND_LIMIT_MICROS_ENV =
  'OPPORTUNITY_INTELLIGENCE_CRAWL_SPEND_LIMIT_MICROS';
export const OPPORTUNITY_INTELLIGENCE_CIRCUIT_REQUEST_THRESHOLD_ENV =
  'OPPORTUNITY_INTELLIGENCE_CIRCUIT_REQUEST_THRESHOLD';
export const OPPORTUNITY_INTELLIGENCE_CIRCUIT_INPUT_TOKEN_THRESHOLD_ENV =
  'OPPORTUNITY_INTELLIGENCE_CIRCUIT_INPUT_TOKEN_THRESHOLD';
export const OPPORTUNITY_INTELLIGENCE_CIRCUIT_REQUEST_THRESHOLD_DEFAULT = 20;
export const OPPORTUNITY_INTELLIGENCE_CIRCUIT_INPUT_TOKEN_THRESHOLD_DEFAULT = 100_000;
export const OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT_ENV =
  'OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT';
export const OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT_ENV =
  'OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT';
export const OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS_ENV =
  'OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS';
export const OPPORTUNITY_INTELLIGENCE_INPUT_COST_MICROS_PER_MILLION_ENV =
  'OPPORTUNITY_INTELLIGENCE_INPUT_COST_MICROS_PER_MILLION';
export const OPPORTUNITY_INTELLIGENCE_OUTPUT_COST_MICROS_PER_MILLION_ENV =
  'OPPORTUNITY_INTELLIGENCE_OUTPUT_COST_MICROS_PER_MILLION';
export const OPPORTUNITY_INTELLIGENCE_MODEL_SCORING_ENABLED_ENV =
  'OPPORTUNITY_INTELLIGENCE_MODEL_SCORING_ENABLED';
export const OPPORTUNITY_INTELLIGENCE_CLEAR_ACCEPT_MIN_REQUIRED_ENV =
  'OPPORTUNITY_INTELLIGENCE_CLEAR_ACCEPT_MIN_REQUIRED';
export const OPPORTUNITY_INTELLIGENCE_CLEAR_REJECT_MIN_GAPS_ENV =
  'OPPORTUNITY_INTELLIGENCE_CLEAR_REJECT_MIN_GAPS';
export const OPPORTUNITY_INTELLIGENCE_SCORING_MAX_INPUT_TOKENS_ENV =
  'OPPORTUNITY_INTELLIGENCE_SCORING_MAX_INPUT_TOKENS';
export const OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_DEFAULT = 3_000;
export const OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_HARD_MAX = 4_000;

export interface OpportunityIntelligenceBudgetConfig {
  circuit: { inputTokenThreshold: number; requestThreshold: number };
  crawl: { calls: number; inputTokens: number; spendMicros: number };
  enabled: boolean;
  pricing: {
    configured: boolean;
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
  };
  run: { calls: number; inputTokens: number; spendMicros: number };
}

export interface OpportunityScoringConfig {
  clearAcceptMinRequired: number;
  clearRejectMinGaps: number;
  inputTokenCeiling: number;
  modelEnabled: boolean;
}

const HARD_LIMITS = {
  circuitInputTokenThreshold: 1_000_000,
  circuitRequestThreshold: 100,
  crawlCalls: 100,
  crawlInputTokens: 1_000_000,
  crawlSpendMicros: 10_000_000,
  runCalls: 8,
  runInputTokens: 100_000,
  runSpendMicros: 2_000_000,
};

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Resolve the hard per-crawl intelligence enqueue limit. Missing or invalid
 * configuration fails closed to zero so unattended crawls cannot create paid
 * work before an operator explicitly enables a bounded canary.
 */
export function resolveOpportunityIntelligenceEnqueueCap(
  override?: number,
): number {
  const configured = nonNegativeInteger(
    override ?? process.env[OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_ENV],
  );
  return Math.min(
    configured ?? 0,
    OPPORTUNITY_INTELLIGENCE_ENQUEUE_CAP_HARD_MAX,
  );
}

function boundedEnvironmentInteger(name: string, hardMaximum: number): number {
  const value = nonNegativeInteger(process.env[name]);
  return Math.min(value ?? 0, hardMaximum);
}

function optionalCircuitThreshold(
  name: string,
  fallbackValue: number,
  hardMaximum: number,
): number {
  const configured = process.env[name];
  if (configured === undefined) return fallbackValue;
  return Math.min(nonNegativeInteger(configured) ?? fallbackValue, hardMaximum);
}

function environmentBoolean(name: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '');
}

export function opportunityIntelligenceEnabled(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  return environmentBoolean(OPPORTUNITY_INTELLIGENCE_ENABLED_ENV);
}

/**
 * Resolve deterministic scoring gates and the independent model-scoring kill
 * switch. Zero disables an accept/reject gate. Invalid gate values also fail
 * closed to zero; the scoring input ceiling falls back to a conservative
 * bounded default and can never exceed the hard maximum.
 */
export function resolveOpportunityScoringConfig(
  override: Partial<OpportunityScoringConfig> = {},
): OpportunityScoringConfig {
  const configuredCeiling = nonNegativeInteger(
    process.env[OPPORTUNITY_INTELLIGENCE_SCORING_MAX_INPUT_TOKENS_ENV],
  );
  const resolved: OpportunityScoringConfig = {
    clearAcceptMinRequired: boundedEnvironmentInteger(
      OPPORTUNITY_INTELLIGENCE_CLEAR_ACCEPT_MIN_REQUIRED_ENV,
      20,
    ),
    clearRejectMinGaps: boundedEnvironmentInteger(
      OPPORTUNITY_INTELLIGENCE_CLEAR_REJECT_MIN_GAPS_ENV,
      20,
    ),
    inputTokenCeiling: Math.min(
      configuredCeiling && configuredCeiling > 0
        ? configuredCeiling
        : OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_DEFAULT,
      OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_HARD_MAX,
    ),
    modelEnabled: environmentBoolean(
      OPPORTUNITY_INTELLIGENCE_MODEL_SCORING_ENABLED_ENV,
    ),
  };
  return {
    clearAcceptMinRequired: Math.min(
      nonNegativeInteger(override.clearAcceptMinRequired) ??
        resolved.clearAcceptMinRequired,
      20,
    ),
    clearRejectMinGaps: Math.min(
      nonNegativeInteger(override.clearRejectMinGaps) ??
        resolved.clearRejectMinGaps,
      20,
    ),
    inputTokenCeiling: Math.min(
      Math.max(
        1,
        nonNegativeInteger(override.inputTokenCeiling) ??
          resolved.inputTokenCeiling,
      ),
      OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_HARD_MAX,
    ),
    modelEnabled: override.modelEnabled ?? resolved.modelEnabled,
  };
}

export function resolveOpportunityIntelligenceBudgetConfig(
  override: Partial<OpportunityIntelligenceBudgetConfig> = {},
): OpportunityIntelligenceBudgetConfig {
  const inputMicrosPerMillion = boundedEnvironmentInteger(
    OPPORTUNITY_INTELLIGENCE_INPUT_COST_MICROS_PER_MILLION_ENV,
    1_000_000_000,
  );
  const outputMicrosPerMillion = boundedEnvironmentInteger(
    OPPORTUNITY_INTELLIGENCE_OUTPUT_COST_MICROS_PER_MILLION_ENV,
    1_000_000_000,
  );
  const crawl = {
    calls: boundedEnvironmentInteger(
      OPPORTUNITY_INTELLIGENCE_CRAWL_CALL_LIMIT_ENV,
      HARD_LIMITS.crawlCalls,
    ),
    inputTokens: boundedEnvironmentInteger(
      OPPORTUNITY_INTELLIGENCE_CRAWL_INPUT_TOKEN_LIMIT_ENV,
      HARD_LIMITS.crawlInputTokens,
    ),
    spendMicros: boundedEnvironmentInteger(
      OPPORTUNITY_INTELLIGENCE_CRAWL_SPEND_LIMIT_MICROS_ENV,
      HARD_LIMITS.crawlSpendMicros,
    ),
    ...override.crawl,
  };
  const resolved: OpportunityIntelligenceBudgetConfig = {
    circuit: {
      inputTokenThreshold: optionalCircuitThreshold(
        OPPORTUNITY_INTELLIGENCE_CIRCUIT_INPUT_TOKEN_THRESHOLD_ENV,
        Math.min(
          crawl.inputTokens,
          OPPORTUNITY_INTELLIGENCE_CIRCUIT_INPUT_TOKEN_THRESHOLD_DEFAULT,
        ),
        HARD_LIMITS.circuitInputTokenThreshold,
      ),
      requestThreshold: optionalCircuitThreshold(
        OPPORTUNITY_INTELLIGENCE_CIRCUIT_REQUEST_THRESHOLD_ENV,
        Math.min(
          crawl.calls,
          OPPORTUNITY_INTELLIGENCE_CIRCUIT_REQUEST_THRESHOLD_DEFAULT,
        ),
        HARD_LIMITS.circuitRequestThreshold,
      ),
    },
    crawl,
    enabled: opportunityIntelligenceEnabled(),
    pricing: {
      configured: inputMicrosPerMillion > 0 && outputMicrosPerMillion > 0,
      inputMicrosPerMillion,
      outputMicrosPerMillion,
    },
    run: {
      calls: boundedEnvironmentInteger(
        OPPORTUNITY_INTELLIGENCE_RUN_CALL_LIMIT_ENV,
        HARD_LIMITS.runCalls,
      ),
      inputTokens: boundedEnvironmentInteger(
        OPPORTUNITY_INTELLIGENCE_RUN_INPUT_TOKEN_LIMIT_ENV,
        HARD_LIMITS.runInputTokens,
      ),
      spendMicros: boundedEnvironmentInteger(
        OPPORTUNITY_INTELLIGENCE_RUN_SPEND_LIMIT_MICROS_ENV,
        HARD_LIMITS.runSpendMicros,
      ),
    },
  };
  return {
    ...resolved,
    ...override,
    circuit: { ...resolved.circuit, ...override.circuit },
    crawl,
    pricing: { ...resolved.pricing, ...override.pricing },
    run: { ...resolved.run, ...override.run },
  };
}

export function reservedRequestSpendMicros(options: {
  inputTokens: number;
  maxOutputTokens: number;
  pricing: OpportunityIntelligenceBudgetConfig['pricing'];
}): number {
  if (!options.pricing.configured) return 0;
  return Math.ceil(
    (options.inputTokens * options.pricing.inputMicrosPerMillion +
      options.maxOutputTokens * options.pricing.outputMicrosPerMillion) /
      1_000_000,
  );
}
