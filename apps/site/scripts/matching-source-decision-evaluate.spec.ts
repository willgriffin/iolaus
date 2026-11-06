import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluate,
  parseArguments,
  summarizeAttempts,
} from './matching-source-decision-evaluate.js';
import { parseBenchmarkFixture } from './matching-source-decision-evaluate-fixtures.js';

const liveArgs = ['--mode', 'laya', '--allow-live-laya', '--max-calls', '1'];
const liveEnv = {
  IOLAUS_SOURCE_DECISION_PROVIDER: 'laya',
  IOLAUS_SOURCE_DECISION_TRANSPORT: 'bifrost',
  IOLAUS_SOURCE_DECISION_MODEL: 'laya/requested-private-model',
  IOLAUS_SOURCE_DECISION_REVISION: 'private-revision',
  IOLAUS_SOURCE_DECISION_BIFROST_BASE_URL: 'http://private-endpoint.example',
  IOLAUS_SOURCE_DECISION_BIFROST_API_KEY: 'private-fixture-key',
};

afterEach(() => vi.unstubAllGlobals());

describe('matching source decision evaluation', () => {
  it('requires a bounded live opt-in and rejects hosted mode', async () => {
    expect(() => parseArguments(['--mode', 'laya'])).toThrow();
    expect(() => parseArguments(['--mode', 'typesafe'])).toThrow();
    expect(() => parseArguments([...liveArgs, '--max-calls', '2'])).toThrow();
    expect(() => parseArguments(['--allow-live-laya'])).toThrow();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      evaluate(parseArguments(liveArgs), {
        ...liveEnv,
        IOLAUS_SOURCE_DECISION_PROVIDER: 'typesafe',
      }),
    ).rejects.toThrow('Explicit Laya configuration required.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects duplicate sources, incorrect offsets and unexpected fixture properties', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          './matching-source-decision-evaluate-fixtures.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(parseBenchmarkFixture(fixture).synthetic.length).toBeGreaterThan(1);
    expect(() =>
      parseBenchmarkFixture({ ...fixture, heldOut: fixture.synthetic }),
    ).toThrow('Duplicate benchmark source.');
    expect(() =>
      parseBenchmarkFixture({ ...fixture, privateProfile: 'sensitive value' }),
    ).toThrow('Invalid benchmark fixture.');
    fixture.synthetic[0].gold.required[0].citation.start = 1;
    expect(() => parseBenchmarkFixture(fixture)).toThrow(
      'Invalid reviewed citation.',
    );
  });

  it('evaluates both splits, with controls, using zero network calls in mock mode', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await evaluate(parseArguments([]), liveEnv);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.evidence).toBe('scripted-plumbing-only');
    expect(result.synthetic.cases).toBeGreaterThan(0);
    expect(result.heldOut.cases).toBeGreaterThan(0);
    for (const split of [result.synthetic, result.heldOut]) {
      expect(split.candidate.advisoryConcepts).toMatchObject({
        equivalentSpans: 1,
        equivalentChecked: 1,
        equivalentCorrect: 1,
        relatedOnlySpans: 1,
        relatedOnlyChecked: 1,
        relatedOnlySuggested: 0,
        noFitSpans: 1,
        noFitChecked: 1,
        noFitSuggested: 0,
      });
      expect(
        split.controls.codePathWithAbstention.advisoryConcepts,
      ).toMatchObject({
        equivalentChecked: 0,
        equivalentMissed: 1,
      });
    }
    expect(result.synthetic.candidate.citations).toMatchObject({ invalid: 0 });
    expect(result.synthetic.candidate.conflicts).toMatchObject({
      detectedConflicts: 1,
      falseConflicts: 0,
    });
    expect(result.synthetic.controls.frozenAbstentionV1.required).toMatchObject(
      { correct: 0, missing: 4 },
    );
    expect(
      result.synthetic.controls.frozenAbstentionV1.conflicts,
    ).toMatchObject({ missedConflicts: 1 });
    expect(result.synthetic.candidate.required.correct).toBeGreaterThan(
      result.synthetic.controls.codePathWithAbstention.required.correct,
    );
    expect(result.usage).toMatchObject({ providerCalls: 0, retries: 0 });
    expect(JSON.stringify(result)).not.toContain('The role calls for');
  });

  it('counts wrong and missing groups and false conflicts without publishing external inputs', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          './matching-source-decision-evaluate-fixtures.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    fixture.synthetic = fixture.synthetic.slice(0, 1);
    fixture.synthetic[0].source.description += '\nSynthetic private marker';
    fixture.synthetic[0].gold.required[0].alternatives = [{ slug: 'docker' }];
    fixture.synthetic[0].probes[0].remoteCountry = 'US';
    const directory = await mkdtemp(join(tmpdir(), 'decision-evaluation-'));
    const file = join(directory, 'private-fixture.json');
    try {
      await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
      const result = await evaluate(parseArguments(['--fixture', file]), {});
      expect(result.synthetic.candidate.required).toEqual({
        correct: 0,
        wrong: 1,
        missing: 1,
      });
      expect(result.synthetic.candidate.conflicts.falseConflicts).toBe(1);
      expect(result.fixture).toEqual({ version: 1, origin: 'external' });
      expect(JSON.stringify(result)).not.toContain('private');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('caps the run at one simulated live request and reports truncation and its usage', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        model: 'laya-rl-agent',
        routing: { model: 'requested-private-model' },
        answers: {
          classification: {
            type: 'choice',
            choice: 'requirement',
            confidence: 1,
            probabilities: {
              requirement: 1,
              preferred: 0,
              context: 0,
              unresolved: 0,
            },
          },
        },
        usage: { input_tokens: 24, output_tokens: 1, truncated: true },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await evaluate(parseArguments(liveArgs), liveEnv);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'http://private-endpoint.example/typesafe/v1/systemone',
      expect.anything(),
    );
    expect(result.transport).toBe('bifrost');
    expect(result.fullRunWithinBudget).toBe(false);
    expect(result.heldOut.budgetBlockedRequests).toBeGreaterThan(0);
    expect(result.heldOut.candidate.advisoryConcepts).toMatchObject({
      equivalentChecked: 0,
      equivalentMissed: 1,
      relatedOnlyChecked: 0,
      noFitChecked: 0,
    });
    expect(result.usage).toMatchObject({
      providerCalls: 1,
      retries: 0,
      missingUsageCalls: 0,
      statuses: { truncated: 1 },
      tokens: { totalTokens: { reportingCalls: 1, reportedSubtotal: 25 } },
    });
    expect(result.usage.observedModel.matched).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it('keeps missing call usage separate from reported zero and from host preflight skips', () => {
    const base = {
      retries: 0,
      elapsedMs: 1,
      observedModel: null,
      usage: null,
    } as const;
    const usage = summarizeAttempts(
      [
        { ...base, status: 'oversized', calls: 0 },
        { ...base, status: 'timeout', calls: 1 },
        {
          ...base,
          status: 'ok',
          calls: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      ],
      'model',
    );
    expect(usage.missingUsageCalls).toBe(1);
    expect(usage.providerCalls).toBe(2);
    expect(usage.tokens.totalTokens).toEqual({
      reportingCalls: 1,
      reportedSubtotal: 0,
    });
    expect(
      summarizeAttempts([], 'model').tokens.totalTokens.reportedSubtotal,
    ).toBeNull();
  });
});
