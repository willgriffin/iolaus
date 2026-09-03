import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-writer coverage for issue #456.
 *
 * The five fenced `database.update('opportunities', …)` writers in the crawler
 * and the details module, plus the intelligence status writer, all go around
 * `save()`, so the change-feed interceptor never sees them. Each must record a
 * bump — and only when the fence actually matched, because a bump for a row
 * that did not change makes every poller refetch for nothing.
 */

const mocks = vi.hoisted(() => ({
  bump: vi.fn(async () => 1),
  update: vi.fn(async () => ({ affected: 1 })),
}));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDatabase: vi.fn(async () => ({ update: mocks.update })),
}));

vi.mock('./db.js', () => ({ getDbConfig: vi.fn(() => ({})) }));

vi.mock('./application-workflow.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncRecommendedOpportunityDecisionTasks: vi.fn(async () => 0),
}));

vi.mock('./change-feed.js', () => ({
  bumpOpportunityChangeFeed: mocks.bump,
  bumpOpportunityTableChangeFeed: vi.fn(async () => 1),
  MAX_PER_ROW_CHANGE_BUMPS: 100,
  OPPORTUNITY_TABLE: 'opportunities',
}));

const {
  defaultFencedOpportunityBackfillUpdate,
  defaultFencedOpportunityIntelligenceUpdate,
  defaultFencedOpportunitySourceUpdate,
  defaultFencedOpportunityStatusUpdate,
} = await import('./opportunity-source-crawler.js');
const { defaultFencedOpportunityUpdate } = await import(
  './opportunity-details.js'
);
const { applyRecommendationSideEffects } = await import(
  './opportunity-intelligence.js'
);

beforeEach(() => {
  mocks.bump.mockClear();
  mocks.update.mockReset();
  mocks.update.mockResolvedValue({ affected: 1 });
});

/** Each writer, reduced to "call it for this opportunity id". */
const writers: [string, (id: string) => Promise<boolean>][] = [
  [
    'defaultFencedOpportunitySourceUpdate',
    (id) =>
      defaultFencedOpportunitySourceUpdate(id, 'fingerprint', 3, {
        sourceContentText: 'body',
      }),
  ],
  [
    'defaultFencedOpportunityIntelligenceUpdate',
    (id) =>
      defaultFencedOpportunityIntelligenceUpdate(id, 'fingerprint', 3, {
        sourceIntelligenceJobId: 'job-1',
        sourceIntelligenceStatus: 'queued',
      }),
  ],
  [
    'defaultFencedOpportunityStatusUpdate',
    (id) =>
      defaultFencedOpportunityStatusUpdate(
        id,
        'fingerprint',
        3,
        'found',
        'recommended',
      ),
  ],
  [
    'defaultFencedOpportunityBackfillUpdate',
    (id) =>
      defaultFencedOpportunityBackfillUpdate(
        id,
        'fingerprint',
        3,
        { status: 'found' },
        { companyName: 'Acme' },
      ),
  ],
  [
    'defaultFencedOpportunityUpdate',
    (id) =>
      defaultFencedOpportunityUpdate(id, 'fingerprint', {
        companyName: 'Acme',
      }),
  ],
];

describe.each(writers)('%s', (_name, write) => {
  it('bumps the change feed with the written id when the fence matched', async () => {
    await expect(write('opportunity-1')).resolves.toBe(true);
    expect(mocks.bump).toHaveBeenCalledTimes(1);
    expect(mocks.bump).toHaveBeenCalledWith(expect.anything(), [
      'opportunity-1',
    ]);
  });

  it('records nothing when the fence matched no row', async () => {
    mocks.update.mockResolvedValue({ affected: 0 });
    await expect(write('opportunity-1')).resolves.toBe(false);
    expect(mocks.bump).not.toHaveBeenCalled();
  });
});

describe('applyRecommendationSideEffects', () => {
  it('bumps the change feed for the opportunity whose status it re-stamped', async () => {
    await expect(
      applyRecommendationSideEffects({
        expectedSourceContentFingerprint: 'fingerprint',
        expectedSourceContentVersion: 3,
        opportunity: {
          id: 'opportunity-1',
          save: async () => {},
          status: 'found',
        },
        score: {
          confidence: 0.95,
          dataQualityWarnings: [],
          fitReasons: [],
          missingInfo: [],
          recommendation: 'recommend',
          risks: [],
          score: 90,
          suggestedNextAction: 'apply',
          summary: 'Strong fit.',
        },
      }),
    ).resolves.toBe(true);
    expect(mocks.bump).toHaveBeenCalledWith(expect.anything(), [
      'opportunity-1',
    ]);
  });
});
