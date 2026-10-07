<script lang="ts">
let { data } = $props();
</script>

<svelte:head><title>Opportunities</title><meta name="description" content="Search public job opportunities." /></svelte:head>
<main><h1>Opportunities</h1><form method="GET"><label>Search <input name="q" value={data.input.q} /></label><button>Search</button></form>
  <p>{data.page.items.length} opportunities</p>
  <ul>{#each data.page.items as item}<li><a href={`/opportunities/${item.id}`}>{item.title}</a> at {item.company} · {item.workMode}</li>{/each}</ul>
  {#if data.page.nextCursor}<a href={`?q=${encodeURIComponent(data.input.q)}&cursor=${encodeURIComponent(data.page.nextCursor)}`}>Next page</a>{/if}
</main>
