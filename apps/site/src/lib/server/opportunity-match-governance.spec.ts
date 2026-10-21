import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  govern: vi.fn(async (options) => ({
    output: (await options.invoke('ledger-request')).output,
    requestId: 'ledger-request',
    reused: false,
  })),
  chat: vi.fn(async () => ({
    content: JSON.stringify({
      decision: 'partial',
      confidence: 0.8,
      quote: 'TypeScript',
      evidenceRef: 'skill',
    }),
    usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
  })),
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: calls.govern,
  attachOpportunityIntelligenceInvocationMetadata: (error: unknown) => error,
}));
vi.mock('./ai-config.js', () => ({
  resolveOpportunityIntelligenceExtractionAiProfileClient: async () => ({
    model: 'openai/gpt-6-luna',
    aiClient: { chat: calls.chat },
    timeout: 1000,
  }),
}));
vi.mock('./opportunity-posting-preparation.js', () => ({
  countOpportunityInputTokens: async () => 200,
}));

import { matchEvidenceCache } from './opportunity-match-cache.js';

describe('Stage3 native governance boundary', () => {
  it('binds both private receipt and spend ledger to the selected owner and pins ceilings/model', async () => {
    const owner = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
    const result = await matchEvidenceCache.decide(
      owner,
      'TypeScript experience',
      [{ id: 'skill', kind: 'skill', title: 'TypeScript', text: 'TypeScript' }],
      { requirementHash: 'requirement', evidenceHash: 'evidence' },
    );
    expect(result.requestId).toBe('ledger-request');
    expect(calls.govern).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSubject: owner,
        billedUser: owner,
        inputTokenCeiling: 4096,
        maxOutputTokens: 512,
        estimatedInputTokens: 200,
        identity: expect.objectContaining({
          model: 'openai/gpt-6-luna',
          feature: 'requirement-evidence',
        }),
      }),
    );
    expect(calls.chat).toHaveBeenCalledOnce();
  });
  it('never invokes a provider when governance rejects the reservation', async () => {
    calls.chat.mockClear();
    calls.govern.mockRejectedValueOnce(new Error('user_budget_exceeded'));
    await expect(
      matchEvidenceCache.decide(
        { tenantId: 'tenant', userId: 'user', profileId: 'profile' },
        'TypeScript',
        [],
        { requirementHash: 'requirement' },
      ),
    ).rejects.toThrow('user_budget_exceeded');
    expect(calls.chat).not.toHaveBeenCalled();
  });
});
