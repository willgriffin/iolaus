import type { DecisionRequest } from '@happyvertical/ai';
import * as ai from '@happyvertical/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMatchingSourceDecisionProvider,
  resolveMatchingSourceDecisionConfig,
} from './matching-source-decision-provider.js';

const config = {
  IOLAUS_SOURCE_DECISION_PROVIDER: 'laya',
  IOLAUS_SOURCE_DECISION_MODEL: 'typed-decisions',
  IOLAUS_SOURCE_DECISION_REVISION: 'evaluation-r1',
  LAYA_BASE_URL: 'http://localhost:8080',
};

const gatewayConfig = {
  ...config,
  IOLAUS_SOURCE_DECISION_TRANSPORT: 'bifrost',
  IOLAUS_SOURCE_DECISION_MODEL: 'laya/english',
  IOLAUS_SOURCE_DECISION_BIFROST_BASE_URL: 'https://gateway.example/prefix/',
  IOLAUS_SOURCE_DECISION_BIFROST_API_KEY: 'fixture-gateway-key',
  LAYA_API_KEY: 'fixture-direct-key',
};

const request: DecisionRequest = {
  state: 'Prior Rust experience required.',
  questions: {
    required: {
      type: 'predicate',
      instructions: 'Is this a requirement for applicants?',
    },
  },
};
const answer = {
  model: 'laya-rl-agent',
  routing: { model: 'typed-decisions' },
  answers: { required: { type: 'noul', noul: 0.9 } },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('matching source decision provider', () => {
  it.each([
    { IOLAUS_SOURCE_DECISION_PROVIDER: 'unknown' },
    { IOLAUS_SOURCE_DECISION_MODEL: '' },
    { IOLAUS_SOURCE_DECISION_REVISION: '' },
    { LAYA_BASE_URL: undefined },
    { LAYA_BASE_URL: 'http://secret@localhost:8080' },
    { IOLAUS_SOURCE_DECISION_MAX_LEN: '1e3' },
    { IOLAUS_SOURCE_DECISION_TIMEOUT_MS: '60001' },
    { IOLAUS_SOURCE_DECISION_PROVIDER: 'typesafe' },
  ])('rejects invalid explicit configuration %o', (override) => {
    expect(() =>
      resolveMatchingSourceDecisionConfig({ ...config, ...override }),
    ).toThrow();
  });

  it('requires the SDK capability before exposing inference', async () => {
    const client = await ai.getAI({
      type: 'laya',
      baseUrl: config.LAYA_BASE_URL,
    });
    const prototype = Object.getPrototypeOf(client) as typeof client;
    const decide = vi.spyOn(prototype, 'decide');
    const capabilities = await client.getCapabilities();
    vi.spyOn(prototype, 'getCapabilities').mockResolvedValue({
      ...capabilities,
      decisions: false,
    });
    await expect(
      createMatchingSourceDecisionProvider(
        resolveMatchingSourceDecisionConfig(config),
      ),
    ).rejects.toThrow('does not support typed decisions');
    expect(decide).not.toHaveBeenCalled();
  });

  it('uses the SDK adapter and reports measured Laya usage', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        ...answer,
        usage: { input_tokens: 55, output_tokens: 0, truncated: false },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const onAttempt = vi.fn();
    const client = await createMatchingSourceDecisionProvider(
      resolveMatchingSourceDecisionConfig(config),
      { onAttempt },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(client.provenance).toEqual({
      provider: 'laya',
      transport: 'direct',
      model: 'typed-decisions',
      revision: 'evaluation-r1',
      maxInputBytes: 1024,
    });
    expect(await client.decide(request)).toMatchObject({
      status: 'ok',
      result: {
        model: 'typed-decisions',
        answers: { required: { type: 'predicate', probability: 0.9 } },
      },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'http://localhost:8080/v1/systemone',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    expect(onAttempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'ok',
        calls: 1,
        retries: 0,
        observedModel: 'typed-decisions',
        usage: { promptTokens: 55, completionTokens: 0, totalTokens: 55 },
      }),
    );
  });

  it.each([
    { IOLAUS_SOURCE_DECISION_TRANSPORT: 'unknown' },
    { IOLAUS_SOURCE_DECISION_MODEL: 'english' },
    { IOLAUS_SOURCE_DECISION_BIFROST_BASE_URL: undefined },
    {
      IOLAUS_SOURCE_DECISION_BIFROST_BASE_URL: 'https://gateway.example/openai',
    },
    {
      IOLAUS_SOURCE_DECISION_BIFROST_BASE_URL:
        'https://gateway.example/typesafe/v1/',
    },
    { IOLAUS_SOURCE_DECISION_BIFROST_API_KEY: undefined },
  ])('rejects invalid gateway settings %o instead of falling back', (override) => {
    expect(() =>
      resolveMatchingSourceDecisionConfig({ ...gatewayConfig, ...override }),
    ).toThrow();
  });

  it('uses native Bifrost ingress and preserves Laya usage and truncation without direct fallback', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...answer,
          routing: { model: 'english' },
          usage: { input_tokens: 55, output_tokens: 0, truncated: false },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...answer,
          routing: { model: 'english' },
          usage: { input_tokens: 61, output_tokens: 0, truncated: true },
        }),
      )
      .mockResolvedValueOnce(
        new Response('Gateway unavailable', { status: 503 }),
      );
    vi.stubGlobal('fetch', fetch);
    const onAttempt = vi.fn();
    const client = await createMatchingSourceDecisionProvider(
      resolveMatchingSourceDecisionConfig(gatewayConfig),
      { onAttempt },
    );
    expect(client.provenance).toMatchObject({
      provider: 'laya',
      transport: 'bifrost',
      model: 'laya/english',
      maxInputBytes: 512,
    });
    expect(await client.decide(request)).toMatchObject({
      status: 'ok',
      result: { model: 'english' },
    });
    expect(await client.decide(request)).toEqual({ status: 'truncated' });
    expect(await client.decide(request)).toEqual({ status: 'failed' });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('https://gateway.example/prefix/typesafe/v1/systemone');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer fixture-gateway-key',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'laya/english',
        max_len: 512,
      });
    }
    expect(onAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: 'truncated',
        retries: 0,
        usage: { promptTokens: 61, completionTokens: 0, totalTokens: 61 },
      }),
    );
  });

  it('does not infer when a short window cannot fit the request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const onAttempt = vi.fn();
    const client = await createMatchingSourceDecisionProvider(
      resolveMatchingSourceDecisionConfig({
        ...config,
        IOLAUS_SOURCE_DECISION_MAX_LEN: '512',
      }),
      { onAttempt },
    );
    expect(await client.decide({ ...request, state: 'é'.repeat(300) })).toEqual(
      {
        status: 'oversized',
      },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(onAttempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'oversized',
        calls: 0,
        retries: 0,
        usage: null,
      }),
    );
  });

  it.each([
    [{ truncated: true }, 'truncated'],
    [{ truncated: false, state_tokens_dropped: 7 }, 'truncated'],
    [{ truncated: false, truncated_questions: ['required'] }, 'truncated'],
    [{}, 'invalid'],
  ])('rejects incomplete Laya answers %o', async (facts, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...answer,
          usage: { input_tokens: 55, output_tokens: 0, ...facts },
        }),
      ),
    );
    const client = await createMatchingSourceDecisionProvider(
      resolveMatchingSourceDecisionConfig(config),
    );
    expect(await client.decide(request)).toEqual({ status });
  });

  it('keeps malformed responses and failures unresolved with no retries', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...answer, answers: {} }))
      .mockResolvedValueOnce(new Response('Provider detail', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const onAttempt = vi.fn();
    const client = await createMatchingSourceDecisionProvider(
      resolveMatchingSourceDecisionConfig(config),
      { onAttempt },
    );
    expect(await client.decide(request)).toEqual({ status: 'invalid' });
    expect(await client.decide(request)).toEqual({ status: 'failed' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onAttempt.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ status: 'invalid', retries: 0, usage: null }),
      expect.objectContaining({ status: 'failed', retries: 0, usage: null }),
    ]);
  });

  it('returns a timeout and does not retry an aborted SDK request', async () => {
    const fetch = vi.fn(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = await createMatchingSourceDecisionProvider(
      resolveMatchingSourceDecisionConfig({
        ...config,
        IOLAUS_SOURCE_DECISION_TIMEOUT_MS: '10',
      }),
    );
    expect(await client.decide(request)).toEqual({ status: 'timeout' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('routes TypeSafe through native Bifrost without using direct credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        model: 'jev-1.13.0',
        answers: answer.answers,
        usage: { input_tokens: 24, output_tokens: 0 },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = await createMatchingSourceDecisionProvider(
      resolveMatchingSourceDecisionConfig({
        ...gatewayConfig,
        IOLAUS_SOURCE_DECISION_PROVIDER: 'typesafe',
        IOLAUS_SOURCE_DECISION_MODEL: 'typesafe/jev-1.13.0',
        TYPESAFE_API_KEY: 'fixture-direct-key',
      }),
    );
    expect(await client.decide(request)).toMatchObject({
      status: 'ok',
      result: { usage: { promptTokens: 24, completionTokens: 0 } },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://gateway.example/prefix/typesafe/v1/systemone',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fixture-gateway-key',
        }),
      }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'typesafe/jev-1.13.0',
    });
  });

  it('uses distinct TypeSafe provenance and keeps unreported usage unknown', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ model: 'jev-test', answers: answer.answers }),
      );
    vi.stubGlobal('fetch', fetch);
    const onAttempt = vi.fn();
    const client = await createMatchingSourceDecisionProvider(
      resolveMatchingSourceDecisionConfig({
        IOLAUS_SOURCE_DECISION_PROVIDER: 'typesafe',
        IOLAUS_SOURCE_DECISION_MODEL: 'jev-test',
        IOLAUS_SOURCE_DECISION_REVISION: 'evaluation-r2',
        TYPESAFE_API_KEY: 'fixture-key',
      }),
      { onAttempt },
    );
    expect(client.provenance).toMatchObject({
      provider: 'typesafe',
      model: 'jev-test',
      revision: 'evaluation-r2',
    });
    expect(await client.decide(request)).toMatchObject({ status: 'ok' });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.typesafe.ai/v1/systemone',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onAttempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'ok',
        calls: 1,
        retries: 0,
        usage: null,
      }),
    );
  });
});
