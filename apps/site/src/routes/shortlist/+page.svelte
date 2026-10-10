<script lang="ts">
import ShortlistView from '$lib/components/ShortlistView.svelte';

let { data } = $props();
</script>

<svelte:head><title>Your opportunity shortlist</title><meta name="description" content="Review opportunities you saved, passed, or set aside for later."/></svelte:head>
{#key data.accountKey}<ShortlistView signedIn={data.signedIn}/>{/key}
