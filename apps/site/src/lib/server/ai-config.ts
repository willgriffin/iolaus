import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AICapabilities,
  AIInterface,
  BifrostOptions,
  GetAIOptions,
} from '@happyvertical/ai';
import { getAI } from '@happyvertical/ai';
import {
  getConfig,
  getPackageConfig,
  loadConfig,
} from '@happyvertical/smrt-config';
import { assertAiEnabled } from './ai-usage-guard.js';
import { getAppConfig } from './app-config.js';

export type AiProfileName = 'cheap' | 'good' | (string & {});

export type OpportunityIntelligenceProfileSelection = 'openai' | 'zai';

export const OPPORTUNITY_INTELLIGENCE_PROFILE_ENV =
  'OPPORTUNITY_INTELLIGENCE_PROFILE';
/** Existing configured Bifrost chat ceiling; planners must reserve this limit. */
export const AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS = 4_096;
/** Per-call cap for explicitly scoped long-form extraction only. */
export const AI_PROFILE_MAX_OUTPUT_TOKENS = 16_384;
export const OPPORTUNITY_INTELLIGENCE_PROFILES = {
  openai: {
    apiKeyEnv: 'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
    model: 'openai/gpt-5.6-luna',
    modelEnv: 'BIFROST_OPPORTUNITY_INTELLIGENCE_FALLBACK_MODEL',
    profile: 'opportunity-intelligence-fallback',
  },
  zai: {
    apiKeyEnv: 'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
    model: 'zai/glm-4.7-flashx',
    modelEnv: 'BIFROST_OPPORTUNITY_INTELLIGENCE_ZAI_MODEL',
    profile: 'opportunity-intelligence-zai',
  },
} as const;

/** Pinned, non-interchangeable models for the paid intelligence paths. */
export const OPPORTUNITY_INTELLIGENCE_GPT6_PROFILES = {
  extraction: {
    apiKeyEnv: 'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
    model: 'openai/gpt-6-luna',
    modelEnv: 'BIFROST_OPPORTUNITY_INTELLIGENCE_EXTRACTION_MODEL',
    profile: 'opportunity-intelligence-extraction',
  },
  scoring: {
    apiKeyEnv: 'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
    model: 'openai/gpt-6.1-sol',
    modelEnv: 'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL',
    profile: 'opportunity-intelligence-scoring',
  },
} as const;

export const MATCHING_CANDIDATE_AI_FEATURE =
  'matching-candidate-interpretation';
export const MATCHING_CANDIDATE_AI_MODEL = 'openai/gpt-6-luna';
export const MATCHING_CANDIDATE_VERIFICATION_AI_MODEL = 'openai/gpt-6.1-sol';

/**
 * Providers a local installation may bring itself. Hosted profiles keep the
 * reviewed Bifrost route only.
 */
export const LOCAL_BYO_AI_PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'ollama',
] as const;
export type LocalByoAiProvider = (typeof LOCAL_BYO_AI_PROVIDERS)[number];
export type AiProviderName = 'bifrost' | LocalByoAiProvider;

/**
 * Per-provider defaults for the two quality tiers. They apply only when the
 * user sets no model; any model setting wins. Ollama has no default because
 * the installed models are the user's choice.
 */
export const LOCAL_BYO_AI_MODEL_DEFAULTS: Record<
  LocalByoAiProvider,
  Partial<Record<AiProfileTier, string>>
> = {
  anthropic: { cheap: 'claude-haiku-4-5', good: 'claude-sonnet-4-5' },
  gemini: { cheap: 'gemini-2.5-flash', good: 'gemini-2.5-pro' },
  ollama: {},
  openai: { cheap: 'gpt-4o-mini', good: 'gpt-4o' },
};

export type AiProfileTier = 'cheap' | 'good';

export class AiProviderConfigurationError extends Error {
  readonly code: 'ai_provider_invalid' | 'ai_capability_missing';

  constructor(
    code: 'ai_provider_invalid' | 'ai_capability_missing',
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderConfigurationError';
    this.code = code;
  }
}

export type AiRequiredCapability = keyof Pick<
  AICapabilities,
  'chat' | 'embeddings' | 'functions' | 'streaming' | 'vision'
>;

export interface AiProfileClient {
  aiClient: Pick<AIInterface, 'chat'> &
    Partial<Pick<AIInterface, 'countTokens'>>;
  model: string;
  profile: string;
  provider: AiProviderName;
  maxOutputTokens?: number;
  timeout?: number;
}

export interface AiProfileClientOptions {
  aiClient?: Pick<AIInterface, 'chat'> &
    Partial<Pick<AIInterface, 'countTokens'>>;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxOutputTokens?: number;
  timeout?: number;
  usageTags?: Record<string, string>;
  requireProfileApiKey?: boolean;
  suppressContentLogging?: boolean;
  /**
   * Capabilities the caller needs from a bring-your-own provider; checked
   * before any inference. Defaults to chat. Hosted Bifrost is unaffected.
   */
  requiredCapabilities?: AiRequiredCapability[];
}

function boundedMaxOutputTokens(value: number | undefined) {
  const maxOutputTokens = value ?? AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS;
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > AI_PROFILE_MAX_OUTPUT_TOKENS
  )
    throw new Error(
      `maxOutputTokens must be an integer from 1 to ${AI_PROFILE_MAX_OUTPUT_TOKENS}.`,
    );
  return maxOutputTokens;
}

interface AiProfileConfig extends Record<string, unknown> {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
  timeout?: number;
  usageTags?: Record<string, string>;
}

interface AiPackageConfig extends Record<string, unknown> {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  defaultProfile?: string;
  defaultProvider?: string;
  profiles?: Record<string, AiProfileConfig>;
  timeout?: number;
  usageTags?: Record<string, string>;
}

const defaultAiPackageConfig: AiPackageConfig = {
  baseUrl: 'https://models.example.invalid',
  defaultProfile: 'cheap',
  defaultProvider: 'bifrost',
  profiles: {
    cheap: {
      model: 'openai/gpt-5.6-luna',
      provider: 'bifrost',
      timeout: 105_000,
    },
    good: {
      model: 'openai/gpt-5.6-terra',
      provider: 'bifrost',
      timeout: 105_000,
    },
    'opportunity-intelligence-fallback': {
      model: 'openai/gpt-5.6-luna',
      provider: 'bifrost',
      timeout: 105_000,
    },
    'opportunity-intelligence-zai': {
      model: 'zai/glm-4.7-flashx',
      provider: 'bifrost',
      timeout: 105_000,
    },
    'opportunity-intelligence-extraction': {
      model: 'openai/gpt-6-luna',
      provider: 'bifrost',
      timeout: 105_000,
    },
    'opportunity-intelligence-scoring': {
      model: 'openai/gpt-6.1-sol',
      provider: 'bifrost',
      timeout: 105_000,
    },
  },
};

const MAX_AI_REQUEST_TIMEOUT_MS = 105_000;
const AI_USAGE_TAG_KEYS = ['app', 'environment', 'profile', 'feature'] as const;
export const OPPORTUNITY_INTELLIGENCE_ALLOWED_MODELS = [
  'openai/gpt-5.6-luna',
  'zai/glm-4.7-flashx',
  'openai/gpt-6-luna',
  'openai/gpt-6.1-sol',
] as const;

export function resolveOpportunityIntelligenceProfile(
  override?: string,
): (typeof OPPORTUNITY_INTELLIGENCE_PROFILES)[OpportunityIntelligenceProfileSelection] & {
  selection: OpportunityIntelligenceProfileSelection;
} {
  const configured = stringValue(
    override ||
      envValue(OPPORTUNITY_INTELLIGENCE_PROFILE_ENV) ||
      (envValue('NODE_ENV') === 'test' ? 'openai' : ''),
  ).toLowerCase();
  const selection = (Object.entries(OPPORTUNITY_INTELLIGENCE_PROFILES).find(
    ([name, profile]) =>
      configured === name || configured === profile.profile.toLowerCase(),
  )?.[0] ?? '') as OpportunityIntelligenceProfileSelection | '';
  if (!selection) {
    throw new Error(
      configured
        ? `Invalid ${OPPORTUNITY_INTELLIGENCE_PROFILE_ENV} value "${configured}"; choose zai or openai.`
        : `${OPPORTUNITY_INTELLIGENCE_PROFILE_ENV} must explicitly select zai or openai.`,
    );
  }
  return { ...OPPORTUNITY_INTELLIGENCE_PROFILES[selection], selection };
}

let smrtConfigLoadPromise: Promise<void> | null = null;

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function envValue(name: string): string {
  return stringValue(process.env[name]);
}

function configString(
  explicit: unknown,
  names: string[],
  fallback = '',
): string {
  const explicitValue = stringValue(explicit);
  if (explicitValue) return explicitValue;
  for (const name of names) {
    const value = envValue(name);
    if (value) return value;
  }
  return fallback;
}

function numberValue(value: unknown): number | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function configNumber(
  explicit: unknown,
  names: string[],
  fallback?: unknown,
): number | undefined {
  const explicitValue = numberValue(explicit);
  if (explicitValue) return explicitValue;
  for (const name of names) {
    const value = numberValue(envValue(name));
    if (value) return value;
  }
  return numberValue(fallback);
}

function profileEnvName(
  prefix: 'BIFROST' | 'HAVE_AI' | 'IOLAUS_LOCAL_AI',
  profile: string,
  suffix: string,
): string {
  const normalizedProfile = profile
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `${prefix}_${normalizedProfile}_${suffix}`;
}

function smrtConfigPathCandidates(): string[] {
  return [
    resolve(process.cwd(), 'smrt.config.js'),
    resolve(process.cwd(), 'apps/site/smrt.config.js'),
  ];
}

async function ensureSmrtConfigLoaded(): Promise<void> {
  if (getConfig()) return;
  smrtConfigLoadPromise ??= (async () => {
    const configPath = smrtConfigPathCandidates().find((candidate) =>
      existsSync(candidate),
    );
    await loadConfig(configPath ? { configPath } : undefined);
  })();
  await smrtConfigLoadPromise;
}

function usageTagsForProfile(
  packageConfig: AiPackageConfig,
  profileConfig: AiProfileConfig,
  profile: string,
  usageTags: Record<string, string> | undefined,
): Record<(typeof AI_USAGE_TAG_KEYS)[number], string> {
  const merged = {
    ...packageConfig.usageTags,
    ...profileConfig.usageTags,
    ...usageTags,
  };
  const sanitize = (value: unknown): string =>
    stringValue(value)
      .replace(/[^a-zA-Z0-9._:/-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  const environment =
    sanitize(merged.environment) ||
    sanitize(
      envValue('HAVE_ENVIRONMENT') ||
        envValue('DEPLOYMENT_ENVIRONMENT') ||
        envValue('NODE_ENV'),
    ) ||
    'development';
  const values: Record<(typeof AI_USAGE_TAG_KEYS)[number], string> = {
    app: getAppConfig().appId,
    environment,
    feature: sanitize(merged.feature) || 'unspecified',
    profile: sanitize(profile) || 'unknown',
  };
  return Object.fromEntries(
    AI_USAGE_TAG_KEYS.map((key) => [key, values[key]]),
  ) as Record<(typeof AI_USAGE_TAG_KEYS)[number], string>;
}

function profileTier(profile: string): AiProfileTier {
  return profile === 'good' ? 'good' : 'cheap';
}

/**
 * Bring-your-own settings use their own `IOLAUS_LOCAL_AI_` namespace, read
 * from the profile, then the tier, then the whole installation. Neither
 * Bifrost nor `HAVE_AI_` names are consulted, so a gateway credential cannot
 * be sent to another provider. `through` limits the walk to the level that
 * selected the provider and the levels more specific than it, so a key or URL
 * set for one provider is not applied to a different provider chosen for a
 * single profile or tier.
 */
const BYO_ENV_LEVELS = ['profile', 'tier', 'installation'] as const;
type ByoEnvLevel = (typeof BYO_ENV_LEVELS)[number];

function byoEnvName(
  profile: string,
  suffix: string,
  level: ByoEnvLevel,
): string {
  if (level === 'profile')
    return profileEnvName('IOLAUS_LOCAL_AI', profile, suffix);
  if (level === 'tier')
    return profileEnvName('IOLAUS_LOCAL_AI', profileTier(profile), suffix);
  return `IOLAUS_LOCAL_AI_${suffix}`;
}

function byoEnvNames(
  profile: string,
  suffix: string,
  through: ByoEnvLevel = 'installation',
): string[] {
  return [
    ...new Set(
      BYO_ENV_LEVELS.slice(0, BYO_ENV_LEVELS.indexOf(through) + 1).map(
        (level) => byoEnvName(profile, suffix, level),
      ),
    ),
  ];
}

function byoProviderEnv(profile: string): {
  level: ByoEnvLevel;
  provider: string;
} {
  for (const level of BYO_ENV_LEVELS) {
    const provider = envValue(byoEnvName(profile, 'PROVIDER', level));
    if (provider) return { level, provider: provider.toLowerCase() };
  }
  return { level: 'installation', provider: '' };
}

/** Fails closed to hosted when the runtime profile cannot be resolved. */
function isLocalRuntime(): boolean {
  try {
    return getAppConfig().runtimeProfile === 'local';
  } catch {
    return false;
  }
}

function isLocalByoProvider(value: string): value is LocalByoAiProvider {
  return (LOCAL_BYO_AI_PROVIDERS as readonly string[]).includes(value);
}

interface ResolvedProfileProvider {
  /** Deepest environment level that chose the provider; settings never come from a broader one. */
  byoLevel: ByoEnvLevel;
  effectiveProfileName: string;
  local: boolean;
  packageConfig: AiPackageConfig;
  profileConfig: AiProfileConfig;
  provider: string;
}

async function resolveProfileProvider(
  profileName: AiProfileName,
  pinnedCredential = false,
): Promise<ResolvedProfileProvider> {
  await ensureSmrtConfigLoaded();
  const packageConfig = getPackageConfig<AiPackageConfig>(
    'ai',
    defaultAiPackageConfig,
  );
  const effectiveProfileName =
    stringValue(profileName) ||
    stringValue(packageConfig.defaultProfile) ||
    'cheap';
  const profileConfig = {
    ...(defaultAiPackageConfig.profiles?.[effectiveProfileName] ?? {}),
    ...(packageConfig.profiles?.[effectiveProfileName] ?? {}),
  };
  // Only a local installation may choose its own provider from the
  // environment; hosted profiles ignore it and keep the configured route. A
  // call that requires the profile's own dedicated credential (the owned
  // review and assistant routes) is a reviewed Bifrost route and never
  // takes the bring-your-own provider.
  const envProvider = byoProviderEnv(effectiveProfileName);
  const local = isLocalRuntime();
  const provider =
    (local && !pinnedCredential ? envProvider.provider : '') ||
    stringValue(
      profileConfig.provider ?? packageConfig.defaultProvider ?? 'bifrost',
    );
  return {
    byoLevel: envProvider.provider ? envProvider.level : 'installation',
    effectiveProfileName,
    local,
    packageConfig,
    profileConfig,
    provider,
  };
}

function invalidProvider(profile: string, reason: string): never {
  throw new AiProviderConfigurationError(
    'ai_provider_invalid',
    `Invalid AI settings for profile "${profile}": ${reason}`,
  );
}

const BYO_MODEL_PATTERN = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function validatedByoBaseUrl(
  profile: string,
  baseUrl: string,
  hasApiKey: boolean,
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return invalidProvider(profile, 'the base URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return invalidProvider(profile, 'the base URL must be http or https.');
  if (url.username || url.password)
    return invalidProvider(
      profile,
      'the base URL must not embed credentials; set the API key separately.',
    );
  if (
    url.protocol === 'http:' &&
    hasApiKey &&
    !LOOPBACK_HOSTS.has(url.hostname)
  )
    return invalidProvider(
      profile,
      'an API key is never sent over plain http to a non-loopback host; use https.',
    );
  return baseUrl.replace(/\/+$/, '');
}

async function assertByoCapabilities(
  client: AIInterface,
  profile: string,
  provider: LocalByoAiProvider,
  required: readonly AiRequiredCapability[],
): Promise<void> {
  const capabilities =
    typeof client.getCapabilities === 'function'
      ? await client.getCapabilities()
      : undefined;
  const missing = required.filter((name) => capabilities?.[name] !== true);
  if (missing.length)
    throw new AiProviderConfigurationError(
      'ai_capability_missing',
      `The ${provider} provider for profile "${profile}" does not support: ${missing.join(', ')}.`,
    );
}

/**
 * Bring-your-own provider route for local installations. Never falls back to
 * another provider, never uses Bifrost settings, and never reports a key.
 * Request-supplied `apiKey` and `baseUrl` are ignored: they belong to hosted
 * callers and must not be forwarded to a user-chosen endpoint.
 */
async function resolveLocalByoProfileClient(
  resolved: ResolvedProfileProvider,
  provider: LocalByoAiProvider,
  options: AiProfileClientOptions,
): Promise<AiProfileClient | null> {
  const { effectiveProfileName: profile, packageConfig } = resolved;
  const configured = [
    resolved.profileConfig.provider === provider
      ? resolved.profileConfig
      : undefined,
    packageConfig.defaultProvider === provider ? packageConfig : undefined,
  ].filter((value): value is AiProfileConfig | AiPackageConfig => !!value);
  const fromConfig = (
    read: (value: AiProfileConfig & AiPackageConfig) => unknown,
  ) =>
    configured
      .map((value) =>
        stringValue(read(value as AiProfileConfig & AiPackageConfig)),
      )
      .find(Boolean) ?? '';

  const apiKey = configString(
    undefined,
    byoEnvNames(profile, 'API_KEY', resolved.byoLevel),
    fromConfig((value) => value.apiKey),
  );
  const rawBaseUrl = configString(
    undefined,
    byoEnvNames(profile, 'BASE_URL', resolved.byoLevel),
    fromConfig((value) => value.baseUrl),
  );
  const baseUrl = rawBaseUrl
    ? validatedByoBaseUrl(profile, rawBaseUrl, !!apiKey)
    : '';
  const model =
    configString(
      options.model,
      byoEnvNames(profile, 'MODEL', resolved.byoLevel),
      '',
    ) ||
    fromConfig((value) => value.model ?? value.defaultModel) ||
    LOCAL_BYO_AI_MODEL_DEFAULTS[provider][profileTier(profile)] ||
    '';
  if (!model)
    return invalidProvider(
      profile,
      `the ${provider} provider needs a model; set IOLAUS_LOCAL_AI_${profileTier(profile).toUpperCase()}_MODEL or IOLAUS_LOCAL_AI_MODEL.`,
    );
  if (!BYO_MODEL_PATTERN.test(model))
    return invalidProvider(profile, 'the model name is not valid.');
  const requiredCapabilities = options.requiredCapabilities ?? ['chat'];
  const timeout = Math.min(
    configNumber(
      options.timeout,
      byoEnvNames(profile, 'TIMEOUT', resolved.byoLevel),
      fromConfig((value) => value.timeout),
    ) ?? MAX_AI_REQUEST_TIMEOUT_MS,
    MAX_AI_REQUEST_TIMEOUT_MS,
  );
  const maxOutputTokens = boundedMaxOutputTokens(options.maxOutputTokens);

  let aiClient = options.aiClient;
  if (!aiClient) {
    // A keyed provider without a credential is simply not configured: AI
    // stays off rather than failing the page.
    if (provider !== 'ollama' && !apiKey) return null;
    const aiOptions = {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      defaultModel: model,
      generationLimits: {
        maxImagesPerRequest: 1,
        maxOutputTokens,
        maxReasoningTokens: 1_024,
        onExceeded: 'error',
      },
      maxRetries: 0,
      rateLimit: { maxAttempts: 1 },
      timeout,
      type: provider,
      usageTags: usageTagsForProfile(
        packageConfig,
        resolved.profileConfig,
        profile,
        options.usageTags,
      ),
    } as GetAIOptions;
    const client = await getAI(aiOptions);
    await assertByoCapabilities(
      client,
      profile,
      provider,
      requiredCapabilities,
    );
    aiClient = client;
  }

  return { aiClient, model, profile, provider, maxOutputTokens, timeout };
}

export async function resolveAiProfileClient(
  profileName: AiProfileName,
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  // Global kill switch: no provider client is ever constructed while engaged.
  assertAiEnabled();
  const resolved = await resolveProfileProvider(
    profileName,
    options.requireProfileApiKey === true,
  );
  const { effectiveProfileName, packageConfig, profileConfig, provider } =
    resolved;
  if (provider !== 'bifrost') {
    if (
      resolved.local &&
      options.requireProfileApiKey !== true &&
      isLocalByoProvider(provider)
    )
      return await resolveLocalByoProfileClient(resolved, provider, options);
    throw new Error(`Unsupported AI provider for profile "${profileName}".`);
  }

  const apiKeyNames = [
    profileEnvName('BIFROST', effectiveProfileName, 'API_KEY'),
    profileEnvName('HAVE_AI', effectiveProfileName, 'API_KEY'),
    ...(options.requireProfileApiKey
      ? []
      : ['BIFROST_API_KEY', 'HAVE_AI_API_KEY']),
  ];
  const apiKey = configString(
    options.apiKey,
    apiKeyNames,
    stringValue(
      profileConfig.apiKey ??
        (options.requireProfileApiKey ? undefined : packageConfig.apiKey),
    ),
  );
  if (!apiKey && !options.aiClient) return null;

  const baseUrl = configString(
    options.baseUrl,
    [
      profileEnvName('BIFROST', effectiveProfileName, 'BASE_URL'),
      profileEnvName('HAVE_AI', effectiveProfileName, 'BASE_URL'),
      'BIFROST_BASE_URL',
      'HAVE_AI_BASE_URL',
    ],
    stringValue(profileConfig.baseUrl ?? packageConfig.baseUrl),
  ).replace(/\/+$/, '');

  const model =
    configString(
      options.model,
      [
        profileEnvName('BIFROST', effectiveProfileName, 'MODEL'),
        profileEnvName('HAVE_AI', effectiveProfileName, 'MODEL'),
      ],
      stringValue(profileConfig.model ?? packageConfig.defaultModel),
    ) ||
    configString(undefined, [
      'BIFROST_MODEL',
      'HAVE_AI_MODEL',
      'HAVE_AI_DEFAULT_MODEL',
    ]);

  const timeout = Math.min(
    configNumber(
      options.timeout,
      [
        profileEnvName('BIFROST', effectiveProfileName, 'TIMEOUT'),
        profileEnvName('HAVE_AI', effectiveProfileName, 'TIMEOUT'),
        'BIFROST_TIMEOUT',
        'HAVE_AI_TIMEOUT',
      ],
      profileConfig.timeout ?? packageConfig.timeout,
    ) ?? MAX_AI_REQUEST_TIMEOUT_MS,
    MAX_AI_REQUEST_TIMEOUT_MS,
  );
  const maxOutputTokens = boundedMaxOutputTokens(options.maxOutputTokens);

  let aiClient = options.aiClient;
  if (!aiClient) {
    const aiOptions: BifrostOptions = {
      apiKey,
      baseUrl,
      generationLimits: {
        maxImagesPerRequest: 1,
        maxOutputTokens,
        maxReasoningTokens: 1_024,
        onExceeded: 'error',
      },
      maxRetries: 0,
      rateLimit: { maxAttempts: 1 },
      type: 'bifrost',
    };
    if (options.suppressContentLogging)
      aiOptions.headers = { 'x-bf-disable-content-logging': 'true' };
    if (model) aiOptions.defaultModel = model;
    if (timeout) aiOptions.timeout = timeout;

    const usageTags = usageTagsForProfile(
      packageConfig,
      profileConfig,
      effectiveProfileName,
      options.usageTags,
    );
    aiOptions.usageTags = usageTags;

    const adminApiKey = configString(undefined, [
      profileEnvName('BIFROST', effectiveProfileName, 'ADMIN_API_KEY'),
      'BIFROST_ADMIN_API_KEY',
    ]);
    if (adminApiKey) aiOptions.adminApiKey = adminApiKey;
    const adminPassword = configString(undefined, [
      profileEnvName('BIFROST', effectiveProfileName, 'ADMIN_PASSWORD'),
      'BIFROST_ADMIN_PASSWORD',
    ]);
    if (adminPassword) aiOptions.adminPassword = adminPassword;
    const adminUrl = configString(undefined, [
      profileEnvName('BIFROST', effectiveProfileName, 'ADMIN_URL'),
      'BIFROST_ADMIN_URL',
    ]);
    if (adminUrl) aiOptions.adminUrl = adminUrl;
    const adminUser = configString(undefined, [
      profileEnvName('BIFROST', effectiveProfileName, 'ADMIN_USER'),
      'BIFROST_ADMIN_USER',
    ]);
    if (adminUser) aiOptions.adminUser = adminUser;

    aiClient = await getAI(aiOptions);
  }

  return {
    aiClient,
    model,
    profile: effectiveProfileName,
    provider: 'bifrost',
    maxOutputTokens,
    timeout,
  };
}

export async function resolveExtractionAiProfileClient(
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  return await resolveAiProfileClient('cheap', options);
}

export async function resolveWritingAiProfileClient(
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  return await resolveAiProfileClient('good', options);
}

async function resolveDedicatedOpportunityIntelligenceAiProfileClient(
  selected: ReturnType<typeof resolveOpportunityIntelligenceProfile>,
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  if (options.aiClient && envValue('NODE_ENV') !== 'test') {
    throw new Error(
      'Injected opportunity-intelligence clients are test-only; production must use the dedicated Bifrost profile.',
    );
  }
  const configuredModel = envValue(selected.modelEnv) || selected.model;
  if (configuredModel !== selected.model) {
    throw new Error(
      `Opportunity intelligence ${selected.selection} model "${configuredModel}" is not the pinned ${selected.model}.`,
    );
  }
  const {
    apiKey: _ignoredApiKey,
    baseUrl: _ignoredBaseUrl,
    model: _ignoredModel,
    timeout: _ignoredTimeout,
    ...profileOptions
  } = options;
  const resolved = await resolveAiProfileClient(selected.profile, {
    ...profileOptions,
    apiKey: envValue(selected.apiKeyEnv),
    requireProfileApiKey: true,
  });
  if (resolved && resolved.model !== selected.model) {
    throw new Error(
      `Opportunity intelligence ${selected.selection} model "${resolved.model}" is not the pinned ${selected.model}.`,
    );
  }
  return resolved;
}

export async function resolveOpportunityIntelligenceAiProfileClient(
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  return await resolveDedicatedOpportunityIntelligenceAiProfileClient(
    resolveOpportunityIntelligenceProfile(),
    options,
  );
}

async function resolvePinnedGpt6OpportunityIntelligenceProfile(
  selected: (typeof OPPORTUNITY_INTELLIGENCE_GPT6_PROFILES)[keyof typeof OPPORTUNITY_INTELLIGENCE_GPT6_PROFILES],
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  if (options.aiClient && envValue('NODE_ENV') !== 'test') {
    throw new Error(
      'Injected opportunity-intelligence clients are test-only; production must use the dedicated Bifrost profile.',
    );
  }
  const configuredModel = envValue(selected.modelEnv) || selected.model;
  if (configuredModel !== selected.model) {
    throw new Error(
      `Opportunity intelligence model "${configuredModel}" is not the pinned ${selected.model}.`,
    );
  }
  const {
    apiKey: _apiKey,
    baseUrl: _baseUrl,
    model: _model,
    timeout: _timeout,
    ...profileOptions
  } = options;
  const resolved = await resolveAiProfileClient(selected.profile, {
    ...profileOptions,
    apiKey: envValue(selected.apiKeyEnv),
    requireProfileApiKey: true,
  });
  if (resolved && resolved.model !== selected.model) {
    throw new Error(
      `Opportunity intelligence model "${resolved.model}" is not the pinned ${selected.model}.`,
    );
  }
  return resolved;
}

export async function resolveOpportunityIntelligenceExtractionAiProfileClient(
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  return await resolvePinnedGpt6OpportunityIntelligenceProfile(
    OPPORTUNITY_INTELLIGENCE_GPT6_PROFILES.extraction,
    options,
  );
}

export async function resolveOpportunityIntelligenceScoringAiProfileClient(
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  return await resolvePinnedGpt6OpportunityIntelligenceProfile(
    OPPORTUNITY_INTELLIGENCE_GPT6_PROFILES.scoring,
    options,
  );
}

/** Reuse the owned résumé route with a separate private usage purpose. */
export async function resolveMatchingCandidateAiProfileClient(
  maxOutputTokens: number,
  model:
    | typeof MATCHING_CANDIDATE_AI_MODEL
    | typeof MATCHING_CANDIDATE_VERIFICATION_AI_MODEL = MATCHING_CANDIDATE_AI_MODEL,
): Promise<AiProfileClient | null> {
  return await resolveOpportunityResumeFitReviewAiProfileClient({
    model,
    maxOutputTokens,
    suppressContentLogging: true,
    usageTags: { feature: MATCHING_CANDIDATE_AI_FEATURE },
  });
}

export const OPPORTUNITY_RESUME_FIT_REVIEW_MODELS = [
  'openai/gpt-6-luna',
  'openai/gpt-6.1-sol',
] as const;
export type OpportunityResumeFitReviewModel =
  (typeof OPPORTUNITY_RESUME_FIT_REVIEW_MODELS)[number];
export function resolveOpportunityResumeFitReviewModel(
  model?: string,
): OpportunityResumeFitReviewModel {
  const selected =
    model ??
    (envValue('BIFROST_OPPORTUNITY_RESUME_FIT_REVIEW_MODEL') ||
      envValue('BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL') ||
      OPPORTUNITY_INTELLIGENCE_GPT6_PROFILES.scoring.model);
  if (
    !OPPORTUNITY_RESUME_FIT_REVIEW_MODELS.some(
      (allowed) => allowed === selected,
    )
  )
    throw new Error(
      'Owned resume review requires an exact registered Luna or Sol model.',
    );
  return selected as OpportunityResumeFitReviewModel;
}
/** Owned advisory review only. Legacy scoring remains pinned to Sol. */
export async function resolveOpportunityResumeFitReviewAiProfileClient(
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  if (options.aiClient && envValue('NODE_ENV') !== 'test')
    throw new Error(
      'Injected opportunity-intelligence clients are test-only; production must use the dedicated Bifrost profile.',
    );
  const model = resolveOpportunityResumeFitReviewModel(options.model);
  const {
    apiKey: _apiKey,
    baseUrl: _baseUrl,
    timeout: _timeout,
    model: _model,
    ...profileOptions
  } = options;
  const resolved = await resolveAiProfileClient(
    OPPORTUNITY_INTELLIGENCE_GPT6_PROFILES.scoring.profile,
    {
      ...profileOptions,
      model,
      apiKey: envValue(
        OPPORTUNITY_INTELLIGENCE_GPT6_PROFILES.scoring.apiKeyEnv,
      ),
      requireProfileApiKey: true,
    },
  );
  if (resolved && resolved.model !== model)
    throw new Error(
      'Owned resume review client does not match its selected model.',
    );
  return resolved;
}

export async function resolveOpenAiOpportunityIntelligenceCanaryClient(
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  return await resolveDedicatedOpportunityIntelligenceAiProfileClient(
    resolveOpportunityIntelligenceProfile('openai'),
    options,
  );
}
