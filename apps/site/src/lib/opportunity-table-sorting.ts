import type { SortState } from '@happyvertical/smrt-ui/data';
import type {
  OpportunityFilterState,
  OpportunitySort,
} from './opportunity-filters';

const COLUMN_SORTS = {
  score: 'score',
  compensation: 'salary',
} as const satisfies Record<string, OpportunitySort>;

type SortableColumnId = keyof typeof COLUMN_SORTS;

function columnForSort(sort: OpportunitySort): SortableColumnId | null {
  for (const [columnId, candidateSort] of Object.entries(COLUMN_SORTS)) {
    if (candidateSort === sort) return columnId as SortableColumnId;
  }
  return null;
}

export function opportunityTableSort(
  filters: OpportunityFilterState,
): SortState {
  const columnId = columnForSort(filters.sort);
  return {
    columnId,
    direction: columnId ? filters.sortDirection : null,
  };
}

export function filtersForOpportunityTableSort(
  filters: OpportunityFilterState,
  nextSort: SortState,
): OpportunityFilterState {
  if (!nextSort.columnId || !nextSort.direction) {
    return {
      ...filters,
      sort: 'best',
      sortDirection: 'desc',
    };
  }

  const sort = COLUMN_SORTS[nextSort.columnId as SortableColumnId];
  if (!sort) return filters;
  return { ...filters, sort, sortDirection: nextSort.direction };
}
