<script lang="ts">
import SearchLanding from '$lib/components/SearchLanding.svelte';
import SearchTriage from '$lib/components/SearchTriage.svelte';

let { data } = $props();
</script>
<svelte:head><title>Opportunity search</title><meta name="description" content="Search public job opportunities by role, skills, location, and work mode."/><link rel="search" type="application/opensearchdescription+xml" title="Opportunity search" href="/opensearch.xml"/></svelte:head>
{#key data.accountKey}{#if !data.submitted}<SearchLanding appName={data.appName} signedIn={data.signedIn}/>{:else}<SearchTriage workspace={data.workspace} input={data.input} page={data.page} interpretation={data.interpretation} signedIn={data.signedIn} submitted={data.submitted} initialView={data.view}/>{/if}{/key}
