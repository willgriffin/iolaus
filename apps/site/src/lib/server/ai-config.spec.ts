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
          app: 'iolaus.localhost',
          environment: 'test',
          feature: 'unspecified',
          profile: 'cheap',
        },
      }),
    );
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
          app: 'iolaus.localhost',
          environment: 'prod-secret',
          feature: 'source-crawl',
          profile: 'cheap',
        },
      }),
    );
  });
});
