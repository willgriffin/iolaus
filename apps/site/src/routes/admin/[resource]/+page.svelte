<script lang="ts">
import { page } from '$app/state';
import AdminGenericHydratedResourcePage from '$lib/components/admin/AdminGenericHydratedResourcePage.svelte';
import AdminHydratedResourcePage from '$lib/components/admin/AdminHydratedResourcePage.svelte';
import { isHydratedAdminResourceSlug } from '$lib/components/admin/admin-resource-hydration';

let { data, form } = $props();
</script>

{#if isHydratedAdminResourceSlug(data.resource.slug)}
  {#key `${data.resource.slug}:${page.url.search}`}
    <AdminHydratedResourcePage {data} {form} />
  {/key}
{:else}
  {#key `${data.resource.slug}:${page.url.search}`}
    <AdminGenericHydratedResourcePage {data} {form} />
  {/key}
{/if}
