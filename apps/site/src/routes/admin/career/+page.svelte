<script lang="ts">
import CareerResume from '$lib/components/admin/CareerResume.svelte';

let { data } = $props();
</script>

<CareerResume {data} />
{#if data.publicProfilesEnabled}<p class="public-profile-link"><a href="/admin/career/public-profile">Manage public profile</a></p>{/if}

<style>.public-profile-link { margin: 1rem 0; } a { color: var(--smrt-color-primary); }</style>
