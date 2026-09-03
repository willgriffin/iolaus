import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AIInterface, BifrostOptions } from '@happyvertical/ai';
import { getAI } from '@happyvertical/ai';
import {
  getConfig,
  getPackageConfig,
  loadConfig,
} from '@happyvertical/smrt-config';

export type AiProfileName = 'cheap' | 'good' | (string & {});

export type OpportunityIntelligenceProfileSelection = 'openai' | 'zai';

export const OPPORTUNITY_INTELLIGENCE_PROFILE_ENV =
  'OPPORTUNITY_INTELLIGENCE_PROFILE';
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

export interface AiProfileClient {
  aiClient: Pick<AIInterface, 'chat'> &
    Partial<Pick<AIInterface, 'countTokens'>>;
  model: string;
  profile: string;
  provider: 'bifrost';
  timeout?: number;
}

export interface AiProfileClientOptions {
  aiClient?: Pick<AIInterface, 'chat'> &
    Partial<Pick<AIInterface, 'countTokens'>>;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
  usageTags?: Record<string, string>;
  requireProfileApiKey?: boolean;
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
  },
};

const MAX_AI_REQUEST_TIMEOUT_MS = 105_000;
const AI_USAGE_TAG_KEYS = ['app', 'environment', 'profile', 'feature'] as const;
export const OPPORTUNITY_INTELLIGENCE_ALLOWED_MODELS = [
  'openai/gpt-5.6-luna',
  'zai/glm-4.7-flashx',
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
  prefix: 'BIFROST' | 'HAVE_AI',
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
    app: 'iolaus.localhost',
    environment,
    feature: sanitize(merged.feature) || 'unspecified',
    profile: sanitize(profile) || 'unknown',
  };
  return Object.fromEntries(
    AI_USAGE_TAG_KEYS.map((key) => [key, values[key]]),
  ) as Record<(typeof AI_USAGE_TAG_KEYS)[number], string>;
}

export async function resolveAiProfileClient(
  profileName: AiProfileName,
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
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
  const provider = stringValue(
    profileConfig.provider ?? packageConfig.defaultProvider ?? 'bifrost',
  );
  if (provider !== 'bifrost') {
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

  let aiClient = options.aiClient;
  if (!aiClient) {
    const aiOptions: BifrostOptions = {
      apiKey,
      baseUrl,
      generationLimits: {
        maxImagesPerRequest: 1,
        maxOutputTokens: 4_096,
        maxReasoningTokens: 1_024,
        onExceeded: 'error',
      },
      maxRetries: 0,
      rateLimit: { maxAttempts: 1 },
      type: 'bifrost',
    };
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

export async function resolveOpenAiOpportunityIntelligenceCanaryClient(
  options: AiProfileClientOptions = {},
): Promise<AiProfileClient | null> {
  return await resolveDedicatedOpportunityIntelligenceAiProfileClient(
    resolveOpportunityIntelligenceProfile('openai'),
    options,
  );
}
