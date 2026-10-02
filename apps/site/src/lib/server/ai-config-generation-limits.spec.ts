import { createServer } from 'node:http';
import { clearCache } from '@happyvertical/smrt-config';
import { expect, it, vi } from 'vitest';
import {
  AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS,
  resolveOpportunityIntelligenceExtractionAiProfileClient,
} from './ai-config.js';
import { preflightOpportunityRequirementCoverageExtraction } from './opportunity-details.js';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';

it('uses the real configured SDK limiter: refuses8192 before transport and admits the source plan at4096', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    requests.push({ path: request.url ?? '', body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'loopback-chat-source-limit',
        object: 'chat.completion',
        created: 1,
        model: 'openai/gpt-6-luna',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{"loopback":true}' },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing loopback address');
    for (const name of Object.keys(process.env))
      if (name.startsWith('BIFROST_') || name.startsWith('HAVE_AI_'))
        vi.stubEnv(name, '');
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY',
      'fictional-loopback-only-key',
    );
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_EXTRACTION_BASE_URL',
      `http://127.0.0.1:${address.port}/openai`,
    );
    vi.stubEnv(
      'BIFROST_OPPORTUNITY_INTELLIGENCE_EXTRACTION_MODEL',
      'openai/gpt-6-luna',
    );
    vi.stubEnv('OPPORTUNITY_INTELLIGENCE_MAX_INPUT_TOKENS', '6000');
    clearCache();
    const resolved =
      await resolveOpportunityIntelligenceExtractionAiProfileClient();
    if (!resolved) throw new Error('Missing configured fixture client');
    // No injected client, getAI mock or substitute limiter: this is the SDK
    // created by the same ai-config function as production source extraction.
    await expect(
      resolved.aiClient.chat([{ role: 'user', content: 'loopback only' }], {
        model: resolved.model,
        maxTokens: 8192,
      }),
    ).rejects.toMatchObject({ code: 'AI_LIMIT_EXCEEDED' });
    expect(requests).toHaveLength(0);
    const opportunity = {
      id: 'fictional-source-sdk-limit',
      title: 'Platform engineer',
      descriptionRaw:
        'Requirements\nMust improve service reliability using TypeScript.',
      sourceContentFingerprint: 'fictional-current-source',
      sourceContentVersion: 1,
    };
    const plan = await preflightOpportunityRequirementCoverageExtraction(
      opportunity,
      prepareOpportunityPosting(opportunity),
      {
        model: resolved.model,
        auditPricing: {
          configured: true,
          inputMicrosPerMillion: 100000,
          outputMicrosPerMillion: 500000,
        },
      },
    );
    expect(AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(plan.maxOutputTokens).toBe(AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS);
    expect(plan.admitted).toBe(true);
    const result = await resolved.aiClient.chat(plan.messages[0], {
      model: resolved.model,
      maxTokens: plan.maxOutputTokens,
      reasoning: { effort: 'low', maxTokens: 1024 },
      responseFormat: { type: 'json_object' },
    });
    expect(result.content).toBe('{"loopback":true}');
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/openai/chat/completions');
    expect(
      requests[0].body.max_tokens ?? requests[0].body.max_completion_tokens,
    ).toBe(4096);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    clearCache();
  }
});
