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
