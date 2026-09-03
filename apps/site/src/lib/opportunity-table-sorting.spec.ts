import { describe, expect, it } from 'vitest';
import { DEFAULT_OPPORTUNITY_FILTERS } from './opportunity-filters';
import {
  filtersForOpportunityTableSort,
  opportunityTableSort,
} from './opportunity-table-sorting';

describe('opportunity table sorting', () => {
  it('maps supported server sorts to their matching table columns', () => {
    expect(
      opportunityTableSort({
        ...DEFAULT_OPPORTUNITY_FILTERS,
        sort: 'score',
        sortDirection: 'asc',
      }),
    ).toEqual({ columnId: 'score', direction: 'asc' });
    expect(
      opportunityTableSort({
        ...DEFAULT_OPPORTUNITY_FILTERS,
        sort: 'salary',
      }),
    ).toEqual({ columnId: 'compensation', direction: 'desc' });
  });

  it('turns header changes into server sort filters and resets a cleared header', () => {
    const scoreAscending = filtersForOpportunityTableSort(
      DEFAULT_OPPORTUNITY_FILTERS,
      { columnId: 'score', direction: 'asc' },
    );
    expect(scoreAscending).toMatchObject({
      sort: 'score',
      sortDirection: 'asc',
    });

    expect(
      filtersForOpportunityTableSort(scoreAscending, {
        columnId: 'score',
        direction: null,
      }),
    ).toMatchObject({ sort: 'best', sortDirection: 'desc' });
  });

  it('does not turn unrelated columns into a server sort', () => {
    expect(
      filtersForOpportunityTableSort(DEFAULT_OPPORTUNITY_FILTERS, {
        columnId: 'company',
        direction: 'asc',
      }),
    ).toBe(DEFAULT_OPPORTUNITY_FILTERS);
  });
});
