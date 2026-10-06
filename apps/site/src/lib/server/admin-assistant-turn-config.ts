import { type AiProfileClient, resolveAiProfileClient } from './ai-config.js';

export const ADMIN_ASSISTANT_AI_PROFILE = 'admin-assistant';
export const ADMIN_ASSISTANT_MAX_INPUT_TOKENS = 4_096;
export const ADMIN_ASSISTANT_MAX_OUTPUT_TOKENS = 512;
const MAX_ASSISTANT_SESSION_SPEND_MICROS = 10_000_000;
const MAX_ASSISTANT_TURN_SPEND_MICROS = 2_000_000;

export type AdminAssistantTurnConfig = {
  inputMicrosPerMillion: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  model: string;
  outputMicrosPerMillion: number;
  sessionSpendLimitMicros: number;
  turnSpendLimitMicros: number;
};

function boundedPositiveInteger(
  environment: Record<string, string | undefined>,
  name: string,
  maximum: number,
): number | null {
  const value = environment[name]?.trim() ?? '';
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : null;
}

/**
 * Assistant turns are deliberately not enabled by a generic Bifrost key or
 * profile. The profile model, both prices, and both spend ceilings must all be
 * explicit so a deployment cannot silently inherit a different product's AI
 * budget.
 */
export function resolveAdminAssistantTurnConfig(
  environment: Record<string, string | undefined> = process.env,
): AdminAssistantTurnConfig | null {
  const model = environment.BIFROST_ADMIN_ASSISTANT_MODEL?.trim() ?? '';
  const inputMicrosPerMillion = boundedPositiveInteger(
    environment,
    'IOLAUS_ADMIN_ASSISTANT_INPUT_COST_MICROS_PER_MILLION',
    1_000_000_000,
  );
  const outputMicrosPerMillion = boundedPositiveInteger(
    environment,
    'IOLAUS_ADMIN_ASSISTANT_OUTPUT_COST_MICROS_PER_MILLION',
    1_000_000_000,
  );
  const turnSpendLimitMicros = boundedPositiveInteger(
    environment,
    'IOLAUS_ADMIN_ASSISTANT_TURN_SPEND_LIMIT_MICROS',
    MAX_ASSISTANT_TURN_SPEND_MICROS,
  );
  const sessionSpendLimitMicros = boundedPositiveInteger(
    environment,
    'IOLAUS_ADMIN_ASSISTANT_SESSION_SPEND_LIMIT_MICROS',
    MAX_ASSISTANT_SESSION_SPEND_MICROS,
  );
  if (
    !model ||
    !inputMicrosPerMillion ||
    !outputMicrosPerMillion ||
    !turnSpendLimitMicros ||
    !sessionSpendLimitMicros
  ) {
    return null;
  }
  return {
    inputMicrosPerMillion,
    maxInputTokens: ADMIN_ASSISTANT_MAX_INPUT_TOKENS,
    maxOutputTokens: ADMIN_ASSISTANT_MAX_OUTPUT_TOKENS,
    model,
    outputMicrosPerMillion,
    sessionSpendLimitMicros,
    turnSpendLimitMicros,
  };
}

export async function resolveAdminAssistantAiClient(
  config: AdminAssistantTurnConfig,
  environment: Record<string, string | undefined> = process.env,
): Promise<AiProfileClient | null> {
  // A deployment may reuse its already-authorized Bifrost credential, but
  // never its model or spending policy. The explicit assistant profile and
  // feature tag keep assistant accounting distinct from every other caller.
  const apiKey =
    environment.BIFROST_ADMIN_ASSISTANT_API_KEY?.trim() ||
    environment.BIFROST_API_KEY?.trim() ||
    '';
  if (!apiKey) return null;
  const client = await resolveAiProfileClient(ADMIN_ASSISTANT_AI_PROFILE, {
    apiKey,
    model: config.model,
    requireProfileApiKey: true,
    usageTags: { feature: 'admin-assistant' },
  });
  return client?.model === config.model ? client : null;
}

export function estimatedAssistantSpendMicros(
  config: AdminAssistantTurnConfig,
  inputTokens: number,
): number {
  const input = Math.ceil(
    (inputTokens * config.inputMicrosPerMillion) / 1_000_000,
  );
  const output = Math.ceil(
    (config.maxOutputTokens * config.outputMicrosPerMillion) / 1_000_000,
  );
  return input + output;
}

export function actualAssistantSpendMicros(
  config: AdminAssistantTurnConfig,
  usage: { completionTokens?: unknown; promptTokens?: unknown } | undefined,
  fallback: number,
): { basis: 'actual' | 'conservative'; spendMicros: number } {
  const prompt =
    typeof usage?.promptTokens === 'number' ? usage.promptTokens : NaN;
  const completion =
    typeof usage?.completionTokens === 'number' ? usage.completionTokens : NaN;
  if (
    !Number.isSafeInteger(prompt) ||
    !Number.isSafeInteger(completion) ||
    prompt < 0 ||
    completion < 0
  ) {
    return { basis: 'conservative', spendMicros: fallback };
  }
  return {
    basis: 'actual',
    spendMicros:
      Math.ceil((prompt * config.inputMicrosPerMillion) / 1_000_000) +
      Math.ceil((completion * config.outputMicrosPerMillion) / 1_000_000),
  };
}
