import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
}));
vi.mock('./smrt.js', () => ({
  getCollection: async (name: string) => ({
    list: async () =>
      (fixture.rows[name] ?? []).map((row) => ({
        id: row.id,
        toJSON: () => row,
      })),
  }),
}));

import { loadMatchingCatalog } from './opportunity-matching.js';

describe('current matching recall catalog', () => {
  it('includes enriched analyses but excludes stale, opted-out and inactive sources', async () => {
    fixture.rows.Source = [
      { id: 'source', isActive: true, publicListing: true },
    ];
    fixture.rows.Opportunity = [
      {
        id: 'job',
        sourceId: 'source',
        currentAnalysisId: 'analysis',
        sourceContentFingerprint: 'current',
        sourceContentVersion: 2,
        requiredSkills: 'TypeScript',
      },
    ];
    fixture.rows.OpportunityAnalysis = [
      {
        id: 'analysis',
        opportunityId: 'job',
        status: 'enriched',
        sourceContentFingerprint: 'current',
        sourceContentVersion: 2,
        skillsJson: '[{"slug":"typescript","kind":"required"}]',
        requirementsJson: '[]',
      },
    ];
    expect(await loadMatchingCatalog()).toHaveLength(1);
    fixture.rows.OpportunityAnalysis[0].sourceContentVersion = 1;
    expect(await loadMatchingCatalog()).toEqual([]);
    fixture.rows.OpportunityAnalysis[0].sourceContentVersion = 2;
    fixture.rows.Source[0].publicListing = false;
    expect(await loadMatchingCatalog()).toEqual([]);
    fixture.rows.Source[0].publicListing = true;
    fixture.rows.Source[0].isActive = false;
    expect(await loadMatchingCatalog()).toEqual([]);
  });
});
