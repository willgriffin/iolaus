<script lang="ts">
import PublicOpportunityCard from '$lib/components/PublicOpportunityCard.svelte';
import PublicSiteHeader from '$lib/components/PublicSiteHeader.svelte';

let { data } = $props();
</script>

<svelte:head><title>{data.skill} opportunities</title><meta name="description" content="Public opportunities requiring this skill." /></svelte:head>
<PublicSiteHeader signedIn={data.signedIn}/>
<main class="collection">
  <a class="back" href="/opportunities">All opportunities</a>
  <header><h1>{data.skill} opportunities</h1></header>
  <ul>{#each data.page.items as item}<li><PublicOpportunityCard opportunity={item}/></li>{/each}</ul>
</main>

<style>
  .collection { width:min(100% - 2rem, 70rem); margin:0 auto; padding:clamp(1.5rem, 5vw, 3rem) 0; }
  .back { color:var(--smrt-color-primary, #075985); }
  header { margin:1.25rem 0; }
  h1 { margin:0; font-size:clamp(2rem, 6vw, 3rem); overflow-wrap:anywhere; }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:1rem; }
</style>
