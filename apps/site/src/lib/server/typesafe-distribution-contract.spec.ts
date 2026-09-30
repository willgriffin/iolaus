import { getAI } from '@happyvertical/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('installed TypeSafe adapter compatibility', () => {
  it.each([
    0.48, 0.49, 0.51, 0.52,
  ])('enforces bounded mass for an 82-option response (%s)', async (first) => {
    const keys = Array.from({ length: 82 }, (_, index) => `candidate_${index}`);
    const probabilities = Object.fromEntries(
      keys.map((key, index) => [
        key,
        index === 0 ? first : index === 1 ? 0.5 : 0,
      ]),
    );
    const choice = first > 0.5 ? keys[0] : keys[1];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers: {
              source: {
                type: 'choice',
                choice,
                confidence: 0.87,
                probabilities,
              },
            },
            usage: { input_tokens: 1200, output_tokens: 340 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const client = await getAI({
      type: 'typesafe',
      apiKey: 'synthetic-test-key',
      defaultModel: 'jev-1.13.0',
    });
    if (!client.decide)
      throw new Error('TypeSafe client must implement decide.');
    const pending = client.decide({
      state: 'Synthetic candidate evidence only.',
      questions: {
        source: {
          type: 'choice',
          instructions: 'Select the supported synthetic source.',
          criteria: Object.fromEntries(keys.map((key) => [key, null])),
        },
      },
    });
    if (first === 0.48 || first === 0.52) {
      await expect(pending).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      return;
    }
    const result = await pending;
    const answer = result.answers.source;
    expect(answer.type).toBe('choice');
    if (answer.type !== 'choice') throw new Error('Expected choice answer');
    expect(Object.keys(answer.probabilities)).toEqual(keys);
    expect(
      Object.values(answer.probabilities).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBeCloseTo(1, 12);
    expect(answer.choice).toBe(choice);
    expect(answer.confidence).toBe(0.87);
    expect(result.usage).toMatchObject({
      promptTokens: 1200,
      completionTokens: 340,
      totalTokens: 1540,
    });
    expect(result.provenance).toMatchObject({
      provider: 'typesafe',
      model: 'jev-1.13.0',
    });
  });
});
