import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  read: vi.fn(),
  publish: vi.fn(),
  enrich: vi.fn(),
}));
vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: async () => ({}),
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));
vi.mock('./smrt.js', () => ({
  getCollection: async () => ({ get: mocks.get }),
}));
vi.mock('./skill-vocabulary.js', async (original) => ({
  ...(await original<object>()),
  refreshSkillVocabularyLookup: async () => undefined,
}));
vi.mock('./opportunity-analysis-store.js', () => ({
  readCurrentAnalysis: mocks.read,
  publishOpportunityAnalysis: mocks.publish,
}));
vi.mock('./opportunity-analysis-enrichment.js', () => ({
  ANALYSIS_MODEL: 'openai/gpt-6-luna',
  ANALYSIS_PROMPT_VERSION: 'prompt/v1',
  ANALYSIS_OUTPUT_VERSION: 'output/v1',
  enrichOpportunityAnalysis: mocks.enrich,
}));

import { ensureOpportunityAnalysis } from './opportunity-analysis.js';
import { deterministicOpportunityAnalysis } from './opportunity-analysis-source.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const source = {
  title: 'TypeScript developer',
  requiredSkills: 'TypeScript',
  descriptionRaw: 'TypeScript is required.',
};
const identity = {
  id: 'one',
  sourceContentJson: JSON.stringify(source),
  sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
  sourceContentVersion: 1,
};
const snapshot = () => ({
  ...deterministicOpportunityAnalysis(identity),
  id: 'analysis-one',
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(identity);
  mocks.read.mockResolvedValue(snapshot());
  mocks.publish.mockImplementation(async (_db, _identity, value) => value);
  mocks.enrich.mockResolvedValue({
    snapshot: snapshot(),
    model: 'openai/gpt-6-luna',
    promptVersion: 'prompt/v1',
    requestId: 'request',
    inputTokens: 5,
    outputTokens: 5,
    costMicros: 1,
  });
});
describe('analysis enrichment fallback', () => {
  it('reads existing deterministic coverage without calling a provider by default', async () => {
    expect((await ensureOpportunityAnalysis('one')).status).toBe(
      'deterministic',
    );
    expect(mocks.enrich).not.toHaveBeenCalled();
  });
  it('enriches an existing deterministic artifact rather than returning early', async () => {
    expect(
      (
        await ensureOpportunityAnalysis('one', {
          enrich: true,
          budgetMicros: 2000,
        })
      ).status,
    ).toBe('enriched');
    expect(mocks.enrich).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it('retains deterministic coverage under provider refusal or exhausted budget', async () => {
    mocks.enrich.mockRejectedValue(new Error('budget exhausted'));
    expect(
      (
        await ensureOpportunityAnalysis('one', {
          enrich: true,
          budgetMicros: 1,
        })
      ).status,
    ).toBe('deterministic');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('does not publish malformed source citations', async () => {
    const bad = snapshot();
    bad.skills[0].evidence[0].quote = 'JavaScript';
    mocks.enrich.mockResolvedValue({ snapshot: bad });
    expect(
      (
        await ensureOpportunityAnalysis('one', {
          enrich: true,
          budgetMicros: 2000,
        })
      ).status,
    ).toBe('deterministic');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('does not permit source overlays or unverified fingerprints in a provider request', async () => {
    mocks.get.mockResolvedValue({
      ...identity,
      sourceContentFingerprint: 'wrong',
      descriptionRaw: 'PRIVATE',
    });
    await expect(
      ensureOpportunityAnalysis('one', { enrich: true, budgetMicros: 2000 }),
    ).rejects.toThrow('Unverified');
    expect(mocks.enrich).not.toHaveBeenCalled();
  });
});
