import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAiProfileClient: vi.fn(),
}));

vi.mock('./ai-config.js', () => ({
  resolveAiProfileClient: mocks.resolveAiProfileClient,
}));

import {
  actualAssistantSpendMicros,
  estimatedAssistantSpendMicros,
  resolveAdminAssistantAiClient,
  resolveAdminAssistantTurnConfig,
} from './admin-assistant-turn-config.js';

const completeEnvironment = {
  BIFROST_ADMIN_ASSISTANT_MODEL: 'openai/gpt-5.6-luna',
  IOLAUS_ADMIN_ASSISTANT_INPUT_COST_MICROS_PER_MILLION: '120000',
  IOLAUS_ADMIN_ASSISTANT_OUTPUT_COST_MICROS_PER_MILLION: '480000',
  IOLAUS_ADMIN_ASSISTANT_SESSION_SPEND_LIMIT_MICROS: '900000',
  IOLAUS_ADMIN_ASSISTANT_TURN_SPEND_LIMIT_MICROS: '120000',
};

describe('admin assistant turn configuration', () => {
  beforeEach(() => {
    mocks.resolveAiProfileClient.mockReset();
  });

  it('remains unavailable without every explicit model, price, and spend boundary', () => {
    expect(resolveAdminAssistantTurnConfig({})).toBeNull();
    expect(
      resolveAdminAssistantTurnConfig({
        ...completeEnvironment,
        IOLAUS_ADMIN_ASSISTANT_TURN_SPEND_LIMIT_MICROS: '0',
      }),
    ).toBeNull();
    expect(
      resolveAdminAssistantTurnConfig({
        ...completeEnvironment,
        IOLAUS_ADMIN_ASSISTANT_INPUT_COST_MICROS_PER_MILLION: undefined,
      }),
    ).toBeNull();
  });

  it('uses a bounded explicit model configuration and settles actual usage when supplied', () => {
    const config = resolveAdminAssistantTurnConfig(completeEnvironment);
    expect(config).toMatchObject({
      maxInputTokens: 4096,
      maxOutputTokens: 512,
      model: 'openai/gpt-5.6-luna',
      sessionSpendLimitMicros: 900000,
      turnSpendLimitMicros: 120000,
    });
    if (!config) throw new Error('Expected configuration.');

    const reserved = estimatedAssistantSpendMicros(config, 1000);
    expect(reserved).toBeGreaterThan(0);
    expect(actualAssistantSpendMicros(config, undefined, reserved)).toEqual({
      basis: 'conservative',
      spendMicros: reserved,
    });
    expect(
      actualAssistantSpendMicros(
        config,
        { completionTokens: 20, promptTokens: 100 },
        reserved,
      ),
    ).toEqual({ basis: 'actual', spendMicros: 22 });
  });

  it('uses an existing authorized Bifrost key only with the explicit assistant profile and budget', async () => {
    const config = resolveAdminAssistantTurnConfig(completeEnvironment);
    if (!config) throw new Error('Expected configuration.');
    mocks.resolveAiProfileClient.mockResolvedValue({
      aiClient: {},
      model: config.model,
      profile: 'admin-assistant',
      provider: 'bifrost',
    });

    await expect(
      resolveAdminAssistantAiClient(config, {
        ...completeEnvironment,
        BIFROST_API_KEY: 'existing-authorized-key',
      }),
    ).resolves.toMatchObject({ profile: 'admin-assistant' });
    expect(mocks.resolveAiProfileClient).toHaveBeenCalledWith(
      'admin-assistant',
      expect.objectContaining({
        apiKey: 'existing-authorized-key',
        model: config.model,
        requireProfileApiKey: true,
        usageTags: { feature: 'admin-assistant' },
      }),
    );
  });
});
