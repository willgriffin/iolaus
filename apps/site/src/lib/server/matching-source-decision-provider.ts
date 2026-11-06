import {
  AIError,
  type DecisionRequest,
  type DecisionResult,
  getAI,
  type TokenUsage,
} from '@happyvertical/ai';

type DecisionProviderConfig = {
  model: string;
  revision: string;
  timeoutMs: number;
  transport: 'direct' | 'bifrost';
} & (
  | { provider: 'laya'; baseUrl: string; apiKey?: string; maxLen: number }
  | { provider: 'typesafe'; baseUrl?: string; apiKey: string }
);

type FailureStatus =
  | 'oversized'
  | 'truncated'
  | 'failed'
  | 'timeout'
  | 'invalid';

export type MatchingSourceDecisionOutcome =
  | { status: 'ok'; result: DecisionResult }
  | { status: FailureStatus };

export type MatchingSourceDecisionProvider = {
  provenance: {
    provider: 'laya' | 'typesafe' | 'fixture';
    transport: 'direct' | 'bifrost' | 'fixture';
    model: string;
    revision: string;
    maxInputBytes: number;
  };
  decide(request: DecisionRequest): Promise<MatchingSourceDecisionOutcome>;
};

export type MatchingSourceDecisionAttempt = {
  status: MatchingSourceDecisionOutcome['status'];
  calls: 0 | 1;
  retries: 0;
  elapsedMs: number;
  usage: TokenUsage | null;
  observedModel: string | null;
};

function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/u.test(value) || number < min || number > max)
    throw new Error(`Configure ${name} between ${min} and ${max}.`);
  return number;
}

function serverUrl(env: NodeJS.ProcessEnv, name: string): URL {
  const value = env[name]?.trim();
  const url = value && URL.canParse(value) ? new URL(value) : null;
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`Configure ${name} as an HTTP(S) server URL.`);
  return url;
}

function bifrostRoute(env: NodeJS.ProcessEnv, model: string) {
  const gateway = serverUrl(env, 'IOLAUS_SOURCE_DECISION_BIFROST_BASE_URL');
  const path = gateway.pathname.replace(/\/+$/u, '');
  if (/\/(?:openai|v1|typesafe|systemone)$/iu.test(path))
    throw new Error('Configure the Bifrost root before any API route.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9]/u.test(model))
    throw new Error('A Bifrost decision model must be provider/model.');
  const apiKey = env.IOLAUS_SOURCE_DECISION_BIFROST_API_KEY?.trim();
  if (!apiKey)
    throw new Error('Configure IOLAUS_SOURCE_DECISION_BIFROST_API_KEY.');
  // Native TypeSafe ingress preserves provider-specific usage metadata.
  gateway.pathname = `${path}/typesafe`;
  return { baseUrl: gateway.href, apiKey };
}

export function resolveMatchingSourceDecisionConfig(
  env: NodeJS.ProcessEnv = process.env,
): DecisionProviderConfig {
  const provider = env.IOLAUS_SOURCE_DECISION_PROVIDER;
  if (provider !== 'laya' && provider !== 'typesafe')
    throw new Error(
      'Select laya or typesafe in IOLAUS_SOURCE_DECISION_PROVIDER.',
    );
  const model = env.IOLAUS_SOURCE_DECISION_MODEL?.trim();
  const revision = env.IOLAUS_SOURCE_DECISION_REVISION?.trim();
  const identity = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
  if (!model || !revision || !identity.test(model) || !identity.test(revision))
    throw new Error(
      'Configure a decision model and deployment revision identifier.',
    );
  const timeoutMs = boundedInteger(
    'IOLAUS_SOURCE_DECISION_TIMEOUT_MS',
    env.IOLAUS_SOURCE_DECISION_TIMEOUT_MS,
    15_000,
    1,
    60_000,
  );
  const transport = env.IOLAUS_SOURCE_DECISION_TRANSPORT ?? 'direct';
  if (transport !== 'direct' && transport !== 'bifrost')
    throw new Error('Select direct or bifrost for the decision transport.');
  const route = transport === 'bifrost' ? bifrostRoute(env, model) : undefined;
  if (provider === 'typesafe') {
    const apiKey = route?.apiKey ?? env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) throw new Error('Configure TYPESAFE_API_KEY.');
    return {
      provider,
      transport,
      model,
      revision,
      timeoutMs,
      apiKey,
      baseUrl: route && `${route.baseUrl}/v1`,
    };
  }

  const checkpoint = route ? model.slice(model.indexOf('/') + 1) : model;
  const baseUrl = route?.baseUrl ?? serverUrl(env, 'LAYA_BASE_URL').href;
  const apiKey = route?.apiKey ?? (env.LAYA_API_KEY?.trim() || undefined);
  return {
    provider,
    transport,
    model,
    revision,
    timeoutMs,
    baseUrl,
    apiKey,
    maxLen: boundedInteger(
      'IOLAUS_SOURCE_DECISION_MAX_LEN',
      env.IOLAUS_SOURCE_DECISION_MAX_LEN,
      checkpoint === 'english' ? 512 : 1024,
      256,
      8192,
    ),
  };
}

function fits(request: DecisionRequest, maxInputBytes: number) {
  const questions = Object.values(request.questions);
  if (!questions.length || questions.length > 64) return false;
  let options = 0;
  for (const question of questions) {
    if (question.type === 'choice') {
      const count = Object.keys(question.criteria).length;
      if (count > 100) return false;
      options += count;
    } else if (question.type === 'score') {
      if (question.criteria.length > 10) return false;
      options += question.criteria.length;
    } else {
      options += 2;
    }
  }
  return (
    options <= 512 &&
    Buffer.byteLength(JSON.stringify(request), 'utf8') <= maxInputBytes
  );
}

function layaCompleteness(
  result: DecisionResult,
): 'ok' | 'truncated' | 'invalid' {
  const details = result.provenance.details;
  if (
    details?.truncated === true ||
    (typeof details?.stateTokensDropped === 'number' &&
      details.stateTokensDropped > 0) ||
    (Array.isArray(details?.truncatedQuestions) &&
      details.truncatedQuestions.length)
  )
    return 'truncated';
  return details?.truncated === false ? 'ok' : 'invalid';
}

/** Explicit SDK adapter selection. Only the caller decides whether to use inference. */
export async function createMatchingSourceDecisionProvider(
  config: DecisionProviderConfig,
  options: {
    onAttempt?: (attempt: MatchingSourceDecisionAttempt) => void;
  } = {},
): Promise<MatchingSourceDecisionProvider> {
  const { provider, transport, model, revision, apiKey, timeoutMs } = config;
  const common = { apiKey, defaultModel: model, timeout: timeoutMs };
  const client = await getAI(
    provider === 'laya'
      ? {
          ...common,
          type: 'laya',
          baseUrl: config.baseUrl,
          maxLen: config.maxLen,
        }
      : { ...common, type: 'typesafe', baseUrl: config.baseUrl },
  );
  if (!(await client.getCapabilities()).decisions || !client.decide)
    throw new Error('Configured provider does not support typed decisions.');
  const decide = client.decide.bind(client);
  // UTF-8 bytes bound the text and question payload independently of tokenization.
  // Server-side window metadata remains authoritative for accepting a Laya answer.
  const maxInputBytes = provider === 'laya' ? config.maxLen : 8_192;

  return {
    provenance: { provider, transport, model, revision, maxInputBytes },
    async decide(request) {
      const startedAt = performance.now();
      const report = (
        status: MatchingSourceDecisionAttempt['status'],
        calls: 0 | 1,
        result?: DecisionResult,
      ) =>
        options.onAttempt?.({
          status,
          calls,
          retries: 0,
          elapsedMs: performance.now() - startedAt,
          usage: result?.usage ?? null,
          observedModel: result?.model ?? null,
        });
      if (!fits(request, maxInputBytes)) {
        report('oversized', 0);
        return { status: 'oversized' };
      }

      let result: DecisionResult;
      try {
        result = await decide(request, { model });
      } catch (error) {
        const code = error instanceof AIError ? error.code : null;
        const status =
          code === 'REQUEST_TIMEOUT'
            ? 'timeout'
            : code === 'INVALID_RESPONSE'
              ? 'invalid'
              : 'failed';
        report(status, 1);
        return { status };
      }
      const status = provider === 'laya' ? layaCompleteness(result) : 'ok';
      report(status, 1, result);
      return status === 'ok' ? { status, result } : { status };
    },
  };
}
