<script lang="ts">
import PublicOpportunityCard from '$lib/components/PublicOpportunityCard.svelte';
import PublicSiteHeader from '$lib/components/PublicSiteHeader.svelte';

let { data } = $props();
</script><svelte:head><title>{data.skill} opportunities</title><meta name="description" content="Public opportunities requiring this skill." /></svelte:head>
<PublicSiteHeader signedIn={data.signedIn}/>
<main><a href="/opportunities">All opportunities</a><h1>{data.skill} opportunities</h1><ul>{#each data.page.items as item}<li><PublicOpportunityCard opportunity={item}/></li>{/each}</ul></main>

<style>main{max-width:70rem;margin:auto;padding:1rem}ul{list-style:none;padding:0;display:grid;gap:1rem}</style>
