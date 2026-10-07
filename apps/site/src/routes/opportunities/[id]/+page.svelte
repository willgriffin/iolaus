<script lang="ts">let { data } = $props();
const opportunity = $derived(data.opportunity);
</script>
<svelte:head><title>{opportunity.title} at {opportunity.company}</title><meta name="description" content={opportunity.summary.join(' ')} /></svelte:head>
<main><a href="/opportunities">All opportunities</a><h1>{opportunity.title}</h1><p>{opportunity.company} · {opportunity.workMode}</p><ul>{#each opportunity.summary as item}<li>{item}</li>{/each}</ul><p>Skills: {opportunity.skills.join(', ')}</p><a href={opportunity.originalUrl} target="_blank" rel="noopener noreferrer">View original posting</a></main>
