import {
  type AIResponseFormat,
  type ChatOptions,
  getAI,
} from '@happyvertical/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('native Bifrost response formats', () => {
  it.each<AIResponseFormat>([
    { type: 'json_object' },
    {
      type: 'json_schema',
      json_schema: {
        name: 'owned_review_fixture',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['rows'],
          properties: {
            rows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['status', 'quote'],
                properties: {
                  status: { type: 'string', enum: ['strength', 'uncertain'] },
                  quote: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  ])('serializes $type through the public SDK without changing usage', async (responseFormat) => {
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        'https://gateway.invalid/openai/chat/completions',
      );
      requests.push(request);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-native-schema-fixture',
          object: 'chat.completion',
          created: 1,
          model: 'openai/gpt-6-luna',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"rows":[]}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetch);
    const client = await getAI({
      type: 'bifrost',
      baseUrl: 'https://gateway.invalid/openai',
      apiKey: 'unit-test-key',
      defaultModel: 'openai/gpt-6-luna',
      maxRetries: 0,
    });
    const options: ChatOptions = {
      model: 'openai/gpt-6-luna',
      maxTokens: 100,
      user: 'native-request-fixture',
      responseFormat,
    };
    const result = await client.chat(
      [{ role: 'user', content: 'Return the fixture rows.' }],
      options,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await requests[0].json()).toMatchObject({
      model: options.model,
      user: options.user,
      response_format: responseFormat,
      stream: false,
    });
    expect(result.content).toBe('{"rows":[]}');
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
    });
  });
});
