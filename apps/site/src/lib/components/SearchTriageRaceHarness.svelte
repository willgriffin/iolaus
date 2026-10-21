<script lang="ts">
import type { PublicOpportunity } from '$lib/public-opportunity-contract.js';
import SearchTriage from './SearchTriage.svelte';

const facets = {
  skills: [],
  seniority: [],
  function: [],
  work_mode: [],
  employment_type: [],
  country: [],
};
let page = $state({
  items: [] as PublicOpportunity[],
  next_cursor: null,
  total_estimate: 0,
  facets,
});
export function replaceDeck(items: PublicOpportunity[]) {
  page = { items, next_cursor: null, total_estimate: items.length, facets };
}
</script>

<SearchTriage input={{ q: '', skills: [], seniority: [], function: [], work_mode: [], employment_type: [], country: [], limit: 20, sort: 'relevance' }} {page} interpretation={null} signedIn={false} submitted initialView="triage"/>
