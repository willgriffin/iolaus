import type { MatchingSourceDecisionAttempt } from './matching-source-decision-provider.js';

export const jevInputTokenCeiling = 65_536;

export function jevBudget(
  model: string,
  maxCostMicros: number | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (!/^jev-1\.(?:13|14)\.0$/u.test(model))
    throw new Error('Jev evaluation requires a supported pinned checkpoint.');
  const rate = env.IOLAUS_SOURCE_DECISION_JEV_INPUT_COST_MICROS_PER_MILLION;
  if (
    !rate ||
    !/^[1-9]\d{0,8}$/u.test(rate) ||
    maxCostMicros === undefined ||
    !Number.isSafeInteger(maxCostMicros) ||
    maxCostMicros < 1 ||
    maxCostMicros > 999_999_999
  )
    throw new Error('Jev evaluation requires a positive rate and spend cap.');
  const inputMicrosPerMillion = Number(rate);
  const maxPerCallMicros = Math.ceil(
    (jevInputTokenCeiling * inputMicrosPerMillion) / 1_000_000,
  );
  return {
    maxCostMicros,
    maxPerCallMicros,
    inputMicrosPerMillion,
    reportedCostMicros: 0,
    settledCalls: 0,
    unsettledReservedMicros: 0,
    stopReason: null as 'cost-cap' | 'unverified-usage' | null,
  };
}

export function settleJevAttempt(
  budget: ReturnType<typeof jevBudget>,
  attempt: MatchingSourceDecisionAttempt | undefined,
): boolean {
  if (attempt?.calls === 0) {
    budget.unsettledReservedMicros = 0;
    return true;
  }
  const usage = attempt?.usage;
  if (
    attempt?.status !== 'ok' ||
    !usage ||
    [usage.promptTokens, usage.completionTokens, usage.totalTokens].some(
      (tokens) => !Number.isSafeInteger(tokens) || tokens < 0,
    ) ||
    usage.totalTokens !== usage.promptTokens + usage.completionTokens ||
    usage.promptTokens > jevInputTokenCeiling
  ) {
    budget.stopReason = 'unverified-usage';
    return false;
  }
  budget.reportedCostMicros += Math.ceil(
    (usage.promptTokens * budget.inputMicrosPerMillion) / 1_000_000,
  );
  budget.settledCalls++;
  budget.unsettledReservedMicros = 0;
  return true;
}

export function reserveJevAttempt(
  budget: ReturnType<typeof jevBudget>,
): boolean {
  if (budget.stopReason || budget.unsettledReservedMicros) return false;
  if (
    budget.reportedCostMicros + budget.maxPerCallMicros >
    budget.maxCostMicros
  ) {
    budget.stopReason = 'cost-cap';
    return false;
  }
  budget.unsettledReservedMicros = budget.maxPerCallMicros;
  return true;
}
