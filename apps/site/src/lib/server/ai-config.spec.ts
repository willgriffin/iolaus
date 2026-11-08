import { clearCache } from '@happyvertical/smrt-config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAI = vi.hoisted(() => vi.fn());

vi.mock('@happyvertical/ai', () => ({
  getAI,
}));

describe('AI config profiles', () => {
  beforeEach(() => {
    clearCache();
    vi.resetModules();
    vi.unstubAllEnvs();
    // Dev machines export BIFROST_*/HAVE_AI_* from .envrc; stub them empty so
    // these assertions only see the env each test sets explicitly.
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('BIFROST_') || name.startsWith('HAVE_AI_')) {
        vi.stubEnv(name, '');
      }
    }
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', 'openai');
    getAI.mockReset();
    getAI.mockResolvedValue({ chat: vi.fn() });
  });

  it('refuses to build any provider client while the global kill switch is on', async () => {
    vi.stubEnv('IOLAUS_AI_DISABLED', 'true');
    const { resolveAiProfileClient, resolveWritingAiProfileClient } =
      await import('./ai-config');
    await expect(
      resolveAiProfileClient('cheap', { apiKey: 'key' }),
    ).rejects.toMatchObject({ code: 'ai_disabled' });
    await expect(
      resolveWritingAiProfileClient({ aiClient: { chat: vi.fn() } }),
    ).rejects.toMatchObject({ code: 'ai_disabled' });
    expect(getAI).not.toHaveBeenCalled();
  });

  it('resolves extraction and writing profiles from smrt-config', async () => {
    const aiClient = {
      chat: vi.fn(),
    };
    const { resolveExtractionAiProfileClient, resolveWritingAiProfileClient } =
      await import('./ai-config');

    await expect(
      resolveExtractionAiProfileClient({ aiClient }),
    ).resolves.toMatchObject({
      model: 'openai/gpt-5.6-luna',
      profile: 'cheap',
      provider: 'bifrost',
    });
    await expect(
      resolveWritingAiProfileClient({ aiClient }),
    ).resolves.toMatchObject({
      model: 'openai/gpt-5.6-terra',
      profile: 'good',
      provider: 'bifrost',
    });
  });

  it('allows profile-specific model overrides from private env', async () => {
    vi.stubEnv('BIFROST_CHEAP_MODEL', 'warthog/mistral:latest');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');

    await expect(
      resolveExtractionAiProfileClient({ aiClient: { chat: vi.fn() } }),
    ).resolves.toMatchObject({
      model: 'warthog/mistral:latest',
      profile: 'cheap',
    });
  });

  it('requires the dedicated opportunity-intelligence virtual key without generic fallback', async () => {
    vi.stubEnv('BIFROST_API_KEY', 'generic-key-must-not-be-used');
    const { resolveOpportunityIntelligenceAiProfileClient } = await import(
      './ai-config'
    );

    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).resolves.toBeNull();
    await expect(
      resolveOpportunityIntelligenceAiProfileClient({
        apiKey: 'explicit-generic-key-must-not-be-used',
      }),
    ).resolves.toBeNull();
    expect(getAI).not.toHaveBeenCalled();

    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-virtual-key',
    );
    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).resolves.toMatchObject({
      model: 'openai/gpt-5.6-luna',
      profile: 'opportunity-intelligence-fallback',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'dedicated-virtual-key',
        defaultModel: 'openai/gpt-5.6-luna',
      }),
    );
  });

  it('pins routine extraction to Luna and ambiguous scoring to Sol', async () => {
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-virtual-key',
    );
    const {
      resolveOpportunityIntelligenceExtractionAiProfileClient,
      resolveOpportunityIntelligenceScoringAiProfileClient,
    } = await import('./ai-config');

    await expect(
      resolveOpportunityIntelligenceExtractionAiProfileClient(),
    ).resolves.toMatchObject({
      model: 'openai/gpt-6-luna',
      profile: 'opportunity-intelligence-extraction',
    });
    await expect(
      resolveOpportunityIntelligenceScoringAiProfileClient(),
    ).resolves.toMatchObject({
      model: 'openai/gpt-6.1-sol',
      profile: 'opportunity-intelligence-scoring',
    });
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL',
      'openai/gpt-6-astra',
    );
    await expect(
      resolveOpportunityIntelligenceScoringAiProfileClient(),
    ).rejects.toThrow('is not the pinned openai/gpt-6.1-sol');
  });

  it('uses the approved owned résumé route for the pinned candidate model and private purpose', async () => {
    vi.stubEnv('BIFROST_API_KEY', 'generic-key');
    vi.stubEnv('BIFROST_BASE_URL', 'https://generic.invalid');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_BASE_URL',
      'https://owned.invalid/openai',
    );
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_RESUME_FIT_REVIEW_MODEL',
      'openai/gpt-6.1-sol',
    );
    const { resolveMatchingCandidateAiProfileClient } = await import(
      './ai-config'
    );

    await expect(
      resolveMatchingCandidateAiProfileClient(4096),
    ).resolves.toBeNull();
    expect(getAI).not.toHaveBeenCalled();

    vi.stubEnv('BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY', 'owned-resume-key');
    await expect(
      resolveMatchingCandidateAiProfileClient(4096),
    ).resolves.toMatchObject({
      model: 'openai/gpt-6-luna',
      profile: 'opportunity-intelligence-scoring',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'owned-resume-key',
        baseUrl: 'https://owned.invalid/openai',
        defaultModel: 'openai/gpt-6-luna',
        headers: { 'x-bf-disable-content-logging': 'true' },
        maxRetries: 0,
        rateLimit: { maxAttempts: 1 },
        usageTags: expect.objectContaining({
          feature: 'matching-candidate-interpretation',
        }),
      }),
    );
  });

  it('sends the private content logging header through the native Bifrost SDK', async () => {
    vi.stubEnv('BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY', 'owned-resume-key');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_BASE_URL',
      'https://owned.invalid/openai',
    );
    const sdk =
      await vi.importActual<typeof import('@happyvertical/ai')>(
        '@happyvertical/ai',
      );
    getAI.mockImplementation(sdk.getAI);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://owned.invalid/openai/chat/completions');
      expect(request.headers.get('x-bf-disable-content-logging')).toBe('true');
      return new Response(
        JSON.stringify({
          model: 'openai/gpt-6-luna',
          choices: [
            {
              message: { role: 'assistant', content: '{}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const { resolveMatchingCandidateAiProfileClient } = await import(
        './ai-config'
      );
      const client = await resolveMatchingCandidateAiProfileClient(4096);
      expect(client).not.toBeNull();
      await expect(
        client?.aiClient.chat([{ role: 'user', content: 'Synthetic source' }]),
      ).resolves.toMatchObject({
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('selects exact registered Luna or Sol only for owned resume reviews without unpinning legacy scoring', async () => {
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-virtual-key',
    );
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_RESUME_FIT_REVIEW_MODEL',
      'openai/gpt-6-luna',
    );
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_SCORING_MODEL',
      'openai/gpt-6.1-sol',
    );
    const {
      resolveOpportunityResumeFitReviewAiProfileClient,
      resolveOpportunityResumeFitReviewModel,
      resolveOpportunityIntelligenceScoringAiProfileClient,
    } = await import('./ai-config');
    expect(resolveOpportunityResumeFitReviewModel()).toBe('openai/gpt-6-luna');
    await expect(
      resolveOpportunityResumeFitReviewAiProfileClient(),
    ).resolves.toMatchObject({
      model: 'openai/gpt-6-luna',
      profile: 'opportunity-intelligence-scoring',
    });
    expect(getAI).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultModel: 'openai/gpt-6-luna',
        apiKey: 'dedicated-virtual-key',
      }),
    );
    await expect(
      resolveOpportunityResumeFitReviewAiProfileClient({
        model: 'openai/gpt-6.1-sol',
      }),
    ).resolves.toMatchObject({ model: 'openai/gpt-6.1-sol' });
    await expect(
      resolveOpportunityIntelligenceScoringAiProfileClient(),
    ).resolves.toMatchObject({
      model: 'openai/gpt-6.1-sol',
      profile: 'opportunity-intelligence-scoring',
    });
    await expect(
      resolveOpportunityResumeFitReviewAiProfileClient({
        model: 'openai/gpt-6-astra',
      }),
    ).rejects.toThrow('exact registered');
  });
  it('rejects injected opportunity-intelligence clients outside tests', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-virtual-key',
    );
    const { resolveOpportunityIntelligenceAiProfileClient } = await import(
      './ai-config'
    );

    await expect(
      resolveOpportunityIntelligenceAiProfileClient({
        aiClient: { chat: vi.fn() },
      }),
    ).rejects.toThrow('test-only');
  });

  it('keeps dedicated opportunity-intelligence transport settings operator-owned', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-virtual-key',
    );
    const { resolveOpportunityIntelligenceAiProfileClient } = await import(
      './ai-config'
    );

    await resolveOpportunityIntelligenceAiProfileClient({
      apiKey: 'request-key-must-not-be-used',
      baseUrl: 'https://request-controlled.invalid',
      model: 'request-controlled/model',
      timeout: 1,
    });

    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'dedicated-virtual-key',
        baseUrl: 'https://models.example.invalid',
        defaultModel: 'openai/gpt-5.6-luna',
        timeout: 105_000,
      }),
    );
  });

  it('rejects opportunity-intelligence model overrides outside the application allow-list', async () => {
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-virtual-key',
    );
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_FALLBACK_MODEL',
      'openai/gpt-5.4-mini',
    );
    const { resolveOpportunityIntelligenceAiProfileClient } = await import(
      './ai-config'
    );

    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).rejects.toThrow('is not the pinned');
  });

  it('requires an explicit selector and never chooses a paid fallback implicitly', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', '');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'cloud-key-must-not-be-used',
    );
    const { resolveOpportunityIntelligenceAiProfileClient } = await import(
      './ai-config'
    );

    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).rejects.toThrow('must explicitly select zai or openai');

    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', 'cloud');
    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).rejects.toThrow('choose zai or openai');
    expect(getAI).not.toHaveBeenCalled();

    vi.stubEnv('BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY', '');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', 'zai');
    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).resolves.toBeNull();
    expect(getAI).not.toHaveBeenCalled();

    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-opportunity-key',
    );
    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).resolves.toMatchObject({
      model: 'zai/glm-4.7-flashx',
      profile: 'opportunity-intelligence-zai',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'dedicated-opportunity-key',
        defaultModel: 'zai/glm-4.7-flashx',
      }),
    );

    getAI.mockClear();
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', 'openai');
    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).resolves.toMatchObject({
      model: 'openai/gpt-5.6-luna',
      profile: 'opportunity-intelligence-fallback',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'dedicated-opportunity-key',
        defaultModel: 'openai/gpt-5.6-luna',
      }),
    );
  });

  it('pins the fixture canary to OpenAI independently of the production selector', async () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', 'zai');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-opportunity-key',
    );
    const { resolveOpenAiOpportunityIntelligenceCanaryClient } = await import(
      './ai-config'
    );

    await expect(
      resolveOpenAiOpportunityIntelligenceCanaryClient(),
    ).resolves.toMatchObject({
      model: 'openai/gpt-5.6-luna',
      profile: 'opportunity-intelligence-fallback',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'dedicated-opportunity-key',
        defaultModel: 'openai/gpt-5.6-luna',
      }),
    );
  });

  it('rejects a fallback model injected into the Z.ai profile', async () => {
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', 'zai');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'dedicated-opportunity-key',
    );
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_ZAI_MODEL',
      'openai/gpt-5.6-luna',
    );
    const { resolveOpportunityIntelligenceAiProfileClient } = await import(
      './ai-config'
    );

    await expect(
      resolveOpportunityIntelligenceAiProfileClient(),
    ).rejects.toThrow('is not the pinned zai/glm-4.7-flashx');
    expect(getAI).not.toHaveBeenCalled();
  });

  it('passes profile timeouts to the bifrost client', async () => {
    vi.stubEnv('BIFROST_API_KEY', 'test-key');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');

    await expect(resolveExtractionAiProfileClient()).resolves.toMatchObject({
      model: 'openai/gpt-5.6-luna',
      profile: 'cheap',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModel: 'openai/gpt-5.6-luna',
        generationLimits: {
          maxImagesPerRequest: 1,
          maxOutputTokens: 4_096,
          maxReasoningTokens: 1_024,
          onExceeded: 'error',
        },
        maxRetries: 0,
        rateLimit: { maxAttempts: 1 },
        timeout: 105_000,
        type: 'bifrost',
        usageTags: {
          app: 'iolaus',
          environment: 'test',
          feature: 'unspecified',
          profile: 'cheap',
        },
      }),
    );
  });

  it('permits a scoped bounded output override without changing the default', async () => {
    vi.stubEnv('BIFROST_API_KEY', 'test-key');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');

    await expect(
      resolveExtractionAiProfileClient({ maxOutputTokens: 16_384 }),
    ).resolves.toMatchObject({ maxOutputTokens: 16_384 });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        generationLimits: expect.objectContaining({ maxOutputTokens: 16_384 }),
      }),
    );
  });

  it.each([
    0, 16_385, 4.5,
  ])('rejects an output override outside the bounded integer range: %s', async (maxOutputTokens) => {
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(
      resolveExtractionAiProfileClient({
        aiClient: { chat: vi.fn() },
        maxOutputTokens,
      }),
    ).rejects.toThrow('maxOutputTokens must be an integer from 1 to 16384.');
  });

  it('allows profile-specific timeout overrides from private env', async () => {
    vi.stubEnv('BIFROST_API_KEY', 'test-key');
    vi.stubEnv('BIFROST_CHEAP_TIMEOUT', '15000');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');

    await resolveExtractionAiProfileClient();

    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 15_000,
      }),
    );
  });

  it('caps timeout overrides and sanitizes the four Bifrost dimensions', async () => {
    vi.stubEnv('BIFROST_API_KEY', 'test-key');
    vi.stubEnv('BIFROST_CHEAP_TIMEOUT', '300000');
    const { resolveAiProfileClient } = await import('./ai-config');

    await resolveAiProfileClient('cheap', {
      usageTags: {
        app: 'do-not-override',
        environment: 'prod\nsecret',
        feature: 'source crawl!!',
        ignored: 'never-forwarded',
      },
    });

    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 105_000,
        usageTags: {
          app: 'iolaus',
          environment: 'prod-secret',
          feature: 'source-crawl',
          profile: 'cheap',
        },
      }),
    );
  });
});

describe('local bring-your-own AI providers', () => {
  const capabilities = (overrides: Record<string, boolean> = {}) => ({
    chat: true,
    embeddings: false,
    functions: false,
    streaming: true,
    vision: false,
    ...overrides,
  });

  beforeEach(() => {
    clearCache();
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const name of Object.keys(process.env)) {
      if (
        name.startsWith('BIFROST_') ||
        name.startsWith('HAVE_AI_') ||
        name.startsWith('IOLAUS_LOCAL_AI_')
      ) {
        vi.stubEnv(name, '');
      }
    }
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'local');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', 'openai');
    getAI.mockReset();
    getAI.mockResolvedValue({
      chat: vi.fn(),
      getCapabilities: vi.fn(async () => capabilities()),
    });
  });

  it('stays off by default: no provider configured builds no client', async () => {
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).resolves.toBeNull();
    expect(getAI).not.toHaveBeenCalled();
  });

  it.each([
    ['openai', 'gpt-4o-mini', 'gpt-4o'],
    ['anthropic', 'claude-haiku-4-5', 'claude-sonnet-4-5'],
    ['gemini', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  ])('builds a %s client with per-tier profile defaults', async (provider, cheap, good) => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', provider);
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    const { resolveExtractionAiProfileClient, resolveWritingAiProfileClient } =
      await import('./ai-config');

    await expect(resolveExtractionAiProfileClient()).resolves.toMatchObject({
      model: cheap,
      profile: 'cheap',
      provider,
    });
    expect(getAI).toHaveBeenLastCalledWith(
      expect.objectContaining({
        apiKey: 'byo-secret-key',
        defaultModel: cheap,
        generationLimits: expect.objectContaining({ onExceeded: 'error' }),
        maxRetries: 0,
        rateLimit: { maxAttempts: 1 },
        type: provider,
        usageTags: expect.objectContaining({ profile: 'cheap' }),
      }),
    );
    await expect(resolveWritingAiProfileClient()).resolves.toMatchObject({
      model: good,
      profile: 'good',
      provider,
    });
  });

  it('forwards an explicit openai base URL and trims trailing slashes', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    vi.stubEnv('IOLAUS_LOCAL_AI_BASE_URL', 'https://llm.example.test/v1///');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await resolveExtractionAiProfileClient();
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://llm.example.test/v1' }),
    );
  });

  it('runs ollama with no key and requires a user-chosen model', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'ollama');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).rejects.toMatchObject({
      code: 'ai_provider_invalid',
      message: expect.stringContaining('needs a model'),
    });
    expect(getAI).not.toHaveBeenCalled();

    vi.stubEnv('IOLAUS_LOCAL_AI_CHEAP_MODEL', 'llama3.2:3b');
    vi.stubEnv('IOLAUS_LOCAL_AI_BASE_URL', 'http://127.0.0.1:11434');
    await expect(resolveExtractionAiProfileClient()).resolves.toMatchObject({
      model: 'llama3.2:3b',
      provider: 'ollama',
    });
    const options = getAI.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434',
      type: 'ollama',
    });
    expect(options).not.toHaveProperty('apiKey');
  });

  it('applies override precedence: call option, profile env, tier env, global env, config, default', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    const { resolveAiProfileClient } = await import('./ai-config');
    const modelOf = async (options = {}) =>
      (await resolveAiProfileClient('cheap', options))?.model;

    expect(await modelOf()).toBe('gpt-4o-mini');
    vi.stubEnv('IOLAUS_LOCAL_AI_MODEL', 'global-model');
    expect(await modelOf()).toBe('global-model');
    // 'cheap' is both the profile and the tier, so one variable serves both.
    vi.stubEnv('IOLAUS_LOCAL_AI_CHEAP_MODEL', 'cheap-model');
    expect(await modelOf()).toBe('cheap-model');
    expect(await modelOf({ model: 'call-model' })).toBe('call-model');

    vi.stubEnv('IOLAUS_LOCAL_AI_ADMIN_ASSISTANT_MODEL', 'profile-model');
    const profileModel = (await resolveAiProfileClient('admin-assistant'))
      ?.model;
    expect(profileModel).toBe('profile-model');
    vi.stubEnv('IOLAUS_LOCAL_AI_ADMIN_ASSISTANT_MODEL', '');
    expect((await resolveAiProfileClient('admin-assistant'))?.model).toBe(
      'cheap-model',
    );
  });

  it('lets a tier-specific provider override the global one without inheriting its credentials', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'openai-secret-key');
    vi.stubEnv('IOLAUS_LOCAL_AI_BASE_URL', 'https://llm.example.test/v1');
    vi.stubEnv('IOLAUS_LOCAL_AI_MODEL', 'openai-only-model');
    vi.stubEnv('IOLAUS_LOCAL_AI_GOOD_PROVIDER', 'anthropic');
    const { resolveExtractionAiProfileClient, resolveWritingAiProfileClient } =
      await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).resolves.toMatchObject({
      provider: 'openai',
    });
    getAI.mockClear();

    // The openai key, URL and model never reach the anthropic profile.
    await expect(resolveWritingAiProfileClient()).resolves.toBeNull();
    expect(getAI).not.toHaveBeenCalled();

    vi.stubEnv('IOLAUS_LOCAL_AI_GOOD_API_KEY', 'anthropic-secret-key');
    await expect(resolveWritingAiProfileClient()).resolves.toMatchObject({
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
    });
    const options = getAI.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      apiKey: 'anthropic-secret-key',
      type: 'anthropic',
    });
    expect(options).not.toHaveProperty('baseUrl');
  });

  it('does not read Bifrost or HAVE_AI credentials for a bring-your-own provider', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('HAVE_AI_API_KEY', 'gateway-fallback-key');
    vi.stubEnv('HAVE_AI_CHEAP_API_KEY', 'gateway-cheap-key');
    vi.stubEnv('HAVE_AI_BASE_URL', 'https://gateway.invalid');
    vi.stubEnv('HAVE_AI_MODEL', 'gateway/model');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).resolves.toBeNull();
    expect(getAI).not.toHaveBeenCalled();
  });

  it('keeps AI off, without throwing, when a keyed provider has no key', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'anthropic');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).resolves.toBeNull();
    expect(getAI).not.toHaveBeenCalled();
  });

  it('never forwards a Bifrost or request-supplied credential to the chosen provider', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('BIFROST_API_KEY', 'bifrost-gateway-key');
    vi.stubEnv('BIFROST_BASE_URL', 'https://gateway.invalid');
    const { resolveAiProfileClient } = await import('./ai-config');

    await expect(
      resolveAiProfileClient('cheap', {
        apiKey: 'request-key',
        baseUrl: 'https://request.invalid',
      }),
    ).resolves.toBeNull();
    expect(getAI).not.toHaveBeenCalled();

    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    await resolveAiProfileClient('cheap', {
      apiKey: 'request-key',
      baseUrl: 'https://request.invalid',
    });
    const options = getAI.mock.calls[0]?.[0];
    expect(options).toMatchObject({ apiKey: 'byo-secret-key', type: 'openai' });
    expect(options).not.toHaveProperty('baseUrl');
    expect(JSON.stringify(options)).not.toContain('bifrost-gateway-key');
  });

  it('reads provider settings from the profile config block', async () => {
    const { clearCache: clear, setConfig } = await import(
      '@happyvertical/smrt-config'
    );
    clear();
    setConfig({
      packages: {
        ai: {
          profiles: {
            cheap: {
              apiKey: 'config-key',
              model: 'config-model',
              provider: 'openai',
            },
          },
        },
      },
    } as never);
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).resolves.toMatchObject({
      model: 'config-model',
      provider: 'openai',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'config-key' }),
    );
  });

  it.each([
    ['not a url', 'the base URL is not a valid URL'],
    ['ftp://host.test', 'must be http or https'],
    ['https://user:pw@host.test', 'must not embed credentials'],
    ['http://llm.example.test', 'never sent over plain http'],
  ])('rejects base URL %s before inference without echoing it', async (baseUrl, reason) => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    vi.stubEnv('IOLAUS_LOCAL_AI_BASE_URL', baseUrl);
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    const error = await resolveExtractionAiProfileClient().catch(
      (caught: Error) => caught,
    );
    expect(error).toMatchObject({ code: 'ai_provider_invalid' });
    expect((error as Error).message).toContain(reason);
    expect((error as Error).message).not.toContain('pw@');
    expect((error as Error).message).not.toContain('byo-secret-key');
    expect(getAI).not.toHaveBeenCalled();
  });

  it('allows plain http to a loopback host and to a keyless LAN host', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    vi.stubEnv('IOLAUS_LOCAL_AI_BASE_URL', 'http://localhost:1234/v1');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).resolves.toMatchObject({
      provider: 'openai',
    });
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'ollama');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', '');
    vi.stubEnv('IOLAUS_LOCAL_AI_MODEL', 'llama3.2');
    vi.stubEnv('IOLAUS_LOCAL_AI_BASE_URL', 'http://192.168.1.20:11434');
    await expect(resolveExtractionAiProfileClient()).resolves.toMatchObject({
      provider: 'ollama',
    });
  });

  it('rejects an invalid model name and an unsupported local provider', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    vi.stubEnv('IOLAUS_LOCAL_AI_MODEL', 'bad model; drop');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).rejects.toThrow(
      'the model name is not valid',
    );
    vi.stubEnv('IOLAUS_LOCAL_AI_MODEL', '');
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'typesafe');
    await expect(resolveExtractionAiProfileClient()).rejects.toThrow(
      'Unsupported AI provider for profile "cheap".',
    );
    expect(getAI).not.toHaveBeenCalled();
  });

  it('fails before inference when the provider lacks a required capability', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    const { resolveAiProfileClient } = await import('./ai-config');
    await expect(
      resolveAiProfileClient('cheap', { requiredCapabilities: ['vision'] }),
    ).rejects.toMatchObject({ code: 'ai_capability_missing' });

    getAI.mockResolvedValue({ chat: vi.fn() });
    await expect(resolveAiProfileClient('cheap')).rejects.toMatchObject({
      code: 'ai_capability_missing',
    });

    getAI.mockResolvedValue({
      chat: vi.fn(),
      getCapabilities: vi.fn(async () => capabilities({ vision: true })),
    });
    await expect(
      resolveAiProfileClient('cheap', { requiredCapabilities: ['vision'] }),
    ).resolves.toMatchObject({ provider: 'openai' });
  });

  it('honours the kill switch before any bring-your-own client is built', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    vi.stubEnv('IOLAUS_AI_DISABLED', 'true');
    const { resolveAiProfileClient } = await import('./ai-config');
    await expect(resolveAiProfileClient('cheap')).rejects.toMatchObject({
      code: 'ai_disabled',
    });
    expect(getAI).not.toHaveBeenCalled();
  });

  it('leaves the pinned intelligence, owned review and dedicated-credential routes on Bifrost', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    vi.stubEnv(
      'IOLAUS_LOCAL_AI_OPPORTUNITY_INTELLIGENCE_SCORING_API_KEY',
      'byo-scoring-key',
    );
    const {
      resolveOpportunityIntelligenceExtractionAiProfileClient,
      resolveOpportunityIntelligenceScoringAiProfileClient,
    } = await import('./ai-config');
    await expect(
      resolveOpportunityIntelligenceExtractionAiProfileClient(),
    ).resolves.toBeNull();
    await expect(
      resolveOpportunityIntelligenceScoringAiProfileClient(),
    ).resolves.toBeNull();
    const { resolveMatchingCandidateAiProfileClient } = await import(
      './ai-config'
    );
    await expect(
      resolveMatchingCandidateAiProfileClient(4096),
    ).resolves.toBeNull();
    const { resolveAiProfileClient } = await import('./ai-config');
    expect(getAI).not.toHaveBeenCalled();
    await expect(
      resolveAiProfileClient('admin-assistant', {
        apiKey: 'assistant-key',
        requireProfileApiKey: true,
      }),
    ).resolves.toMatchObject({ provider: 'bifrost' });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'assistant-key', type: 'bifrost' }),
    );
  });

  it('keeps a dedicated-credential route on Bifrost even when config names a bring-your-own provider', async () => {
    const { setConfig } = await import('@happyvertical/smrt-config');
    setConfig({
      packages: {
        ai: { profiles: { 'admin-assistant': { provider: 'openai' } } },
      },
    } as never);
    const { resolveAiProfileClient } = await import('./ai-config');
    await expect(
      resolveAiProfileClient('admin-assistant', {
        apiKey: 'assistant-key',
        requireProfileApiKey: true,
      }),
    ).rejects.toThrow('Unsupported AI provider');
    expect(getAI).not.toHaveBeenCalled();
  });
});

describe('hosted profiles keep the reviewed Bifrost route', () => {
  beforeEach(() => {
    clearCache();
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const name of Object.keys(process.env)) {
      if (
        name.startsWith('BIFROST_') ||
        name.startsWith('HAVE_AI_') ||
        name.startsWith('IOLAUS_LOCAL_AI_')
      ) {
        vi.stubEnv(name, '');
      }
    }
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'cloud');
    vi.stubEnv('SMRT_APP_ID', 'jobgeni');
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_PROFILE', 'openai');
    getAI.mockReset();
    getAI.mockResolvedValue({ chat: vi.fn() });
  });

  it.each([
    'cloud',
    'self-hosted',
  ])('ignores the bring-your-own provider environment on the %s profile', async (runtimeProfile) => {
    vi.stubEnv('SMRT_RUNTIME_PROFILE', runtimeProfile);
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    vi.stubEnv('IOLAUS_LOCAL_AI_MODEL', 'gpt-4o');
    vi.stubEnv('BIFROST_API_KEY', 'gateway-key');
    const { resolveExtractionAiProfileClient } = await import('./ai-config');

    await expect(resolveExtractionAiProfileClient()).resolves.toMatchObject({
      model: 'openai/gpt-5.6-luna',
      provider: 'bifrost',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'gateway-key', type: 'bifrost' }),
    );
  });

  it('still refuses a non-Bifrost provider configured for a hosted profile', async () => {
    const { setConfig } = await import('@happyvertical/smrt-config');
    setConfig({
      packages: {
        ai: { profiles: { cheap: { provider: 'openai' } } },
      },
    } as never);
    const { resolveExtractionAiProfileClient } = await import('./ai-config');
    await expect(resolveExtractionAiProfileClient()).rejects.toThrow(
      'Unsupported AI provider for profile "cheap".',
    );
    expect(getAI).not.toHaveBeenCalled();
  });

  it('keeps the pinned intelligence models and dedicated key requirement', async () => {
    vi.stubEnv('IOLAUS_LOCAL_AI_PROVIDER', 'openai');
    vi.stubEnv('IOLAUS_LOCAL_AI_API_KEY', 'byo-secret-key');
    vi.stubEnv('BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY', 'dedicated-key');
    const { resolveOpportunityIntelligenceExtractionAiProfileClient } =
      await import('./ai-config');
    await expect(
      resolveOpportunityIntelligenceExtractionAiProfileClient(),
    ).resolves.toMatchObject({
      model: 'openai/gpt-6-luna',
      provider: 'bifrost',
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'dedicated-key', type: 'bifrost' }),
    );
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_EXTRACTION_MODEL',
      'openai/other',
    );
    await expect(
      resolveOpportunityIntelligenceExtractionAiProfileClient(),
    ).rejects.toThrow('is not the pinned openai/gpt-6-luna');
  });
});
