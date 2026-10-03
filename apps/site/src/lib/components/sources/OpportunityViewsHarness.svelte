<script lang="ts">
import type { AdminRecord } from '$lib/admin/dock';
import { createAdminListPagination } from '$lib/admin/pagination';
import { EMPTY_OPPORTUNITY_FILTER_OPTIONS } from '$lib/opportunity-filters';
import OpportunityCardList from '../admin/OpportunityCardList.svelte';

let records = $state<AdminRecord[]>([
  {
    id: 'opp-1',
    title: 'Staff engineer',
    company: 'Acme',
    humanReviewStatus: '',
  },
  {
    id: 'opp-2',
    title: 'Platform lead',
    company: 'Orbit',
    humanReviewStatus: '',
  },
]);
let selectedIds = $state(new Set<string>());
let currentPage = $state(1);
export function replacePage(next: AdminRecord[], page = 2) {
  records = next;
  currentPage = page;
}
</script>
<OpportunityCardList {records} {selectedIds}
  onSelectedIdsChange={(ids) => selectedIds = ids}
  candidateSkills={[]} activeReviewFilter="unsorted"
  pagination={createAdminListPagination(4, currentPage, 2)}
  filterOptions={EMPTY_OPPORTUNITY_FILTER_OPTIONS}
  reviewFilters={[{ label: 'Unsorted', value: 'unsorted' }, { label: 'All', value: 'all' }]}
  reviewStatuses={[]} />
<output aria-label="Selected IDs">{[...selectedIds].sort().join(',')}</output>
