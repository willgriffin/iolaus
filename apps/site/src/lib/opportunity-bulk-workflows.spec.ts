import { describe, expect, it } from 'vitest';
import { summarizeOpportunityBulkDetails } from './opportunity-bulk-workflows';

/**
 * The shape the DataSurface adapter actually returns. Reproduced from
 * `outcomesDetails()` in `@happyvertical/smrt-agents/server`: per-row results
 * live under `outcomes`, never under `rows`, and the tallies travel beside
 * them. A confirmation strip that reads the wrong key silently reports every
 * resolved row as though it will change.
 */
function adapterDetails(
  outcomes: { rowId: string; status: string; reason?: string }[],
  extra: Record<string, unknown> = {},
) {
  return {
    accepted: outcomes.filter(({ status }) => status === 'accepted').length,
    skipped: outcomes.filter(({ status }) => status === 'skipped').length,
    failed: outcomes.filter(({ status }) => status === 'failed').length,
    outcomes,
    ...extra,
  };
}

describe('summarizeOpportunityBulkDetails', () => {
  it('counts only the rows a confirm would change', () => {
    const summary = summarizeOpportunityBulkDetails(
      adapterDetails(
        [
          { rowId: 'a', status: 'accepted' },
          { rowId: 'b', status: 'accepted' },
          {
            rowId: 'c',
            status: 'skipped',
            reason: 'invalid_status_transition',
          },
        ],
        { count: 3 },
      ),
    );

    // Three rows resolved, but only two change: the resolved count must not
    // be what the operator confirms against.
    expect(summary.accepted).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.reasons).toEqual(['invalid_status_transition']);
  });

  it('surfaces every distinct skip reason', () => {
    const summary = summarizeOpportunityBulkDetails(
      adapterDetails([
        { rowId: 'a', status: 'skipped', reason: 'posting_content_missing' },
        { rowId: 'b', status: 'skipped', reason: 'invalid_status_transition' },
        { rowId: 'c', status: 'skipped', reason: 'posting_content_missing' },
      ]),
    );

    expect(summary.accepted).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.reasons).toEqual([
      'invalid_status_transition',
      'posting_content_missing',
    ]);
  });

  it('counts a failed row as not applied', () => {
    const summary = summarizeOpportunityBulkDetails(
      adapterDetails([
        { rowId: 'a', status: 'accepted' },
        { rowId: 'b', status: 'failed', reason: 'row_revision_drifted' },
      ]),
    );

    expect(summary.accepted).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.reasons).toEqual(['row_revision_drifted']);
  });

  it('reports nothing accepted when every row is skipped', () => {
    const summary = summarizeOpportunityBulkDetails(
      adapterDetails([{ rowId: 'a', status: 'skipped', reason: 'not_found' }], {
        count: 1,
      }),
    );

    // The confirm control keys off this, so an all-skipped preview must not
    // present a non-zero count.
    expect(summary.accepted).toBe(0);
  });

  it('falls back to the per-row walk when tallies are absent', () => {
    const summary = summarizeOpportunityBulkDetails({
      outcomes: [
        { rowId: 'a', status: 'accepted' },
        { rowId: 'b', status: 'skipped', reason: 'not_found' },
      ],
    });

    expect(summary).toEqual({
      accepted: 1,
      reasons: ['not_found'],
      skipped: 1,
    });
  });

  it('reports nothing for a result carrying no outcomes', () => {
    for (const details of [undefined, null, [], 'nope', {}, { rows: [] }]) {
      expect(summarizeOpportunityBulkDetails(details)).toEqual({
        accepted: 0,
        reasons: [],
        skipped: 0,
      });
    }
  });
});
