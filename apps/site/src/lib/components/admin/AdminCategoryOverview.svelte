<script lang="ts">
import { getContext } from 'svelte';
import {
  type AdminCategoryKey,
  adminCategoryNavigation,
} from '$lib/admin/category-navigation';
import {
  ADMIN_HEADER_ACTIONS,
  type AdminHeaderActions,
} from '$lib/admin/header-actions';
import { adminBackLink } from '$lib/admin/navigation';
import type { AdminResource } from '$lib/admin/resources';
import AdminBackLink from '$lib/components/admin/AdminBackLink.svelte';
import NavIcon from './NavIcon.svelte';

let { category, resources } = $props<{
  category: AdminCategoryKey;
  resources: AdminResource[];
}>();
const navigation = $derived(adminCategoryNavigation(category, resources));
const parentLabel = $derived(category === 'memory' ? 'System' : 'Overview');
const parentHref = $derived(category === 'memory' ? '/admin/system' : '/admin');
const backLink = $derived(adminBackLink(parentLabel, parentHref));
const adminHeader = getContext<AdminHeaderActions | undefined>(
  ADMIN_HEADER_ACTIONS,
);
$effect(() => adminHeader?.register(categoryHeaderActions));
</script>

{#snippet categoryHeaderActions()}
  <AdminBackLink {...backLink} />
{/snippet}

<svelte:head><title>{navigation.label} — Iolaus</title></svelte:head>

<section class="category-overview" aria-labelledby="category-title">
  {#if !adminHeader}
    <AdminBackLink {...backLink} />
  {/if}
  <h1 id="category-title" class="visually-hidden">{navigation.label}</h1>
  <nav class="category-sections" aria-label={`${navigation.label} sections`}>
    {#each navigation.children ?? [] as section (section.href)}
      <a class="section-link" href={section.href}>
        <span class="section-icon" aria-hidden="true"><NavIcon name={section.icon ?? 'database'} size={20} /></span>
        <div><h2>{section.label}</h2>{#if section.description}<p>{section.description}</p>{/if}</div>
        <span class="section-arrow" aria-hidden="true">→</span>
      </a>
    {:else}
      <p>No sections are available in this workspace.</p>
    {/each}
  </nav>
</section>

<style>
  .category-overview { display: grid; gap: var(--smrt-spacing-6, 1.5rem); min-width: 0; max-width: 70rem; }
  .section-link div { min-width: 0; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  p { margin: 0; color: var(--smrt-color-on-surface-variant); line-height: 1.5; overflow-wrap: anywhere; }
  .category-sections { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--smrt-spacing-3, .75rem); }
  .section-link { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--smrt-spacing-3, .75rem); min-width: 0; min-height: 5rem; padding: var(--smrt-spacing-4, 1rem); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium, .5rem); color: var(--smrt-color-on-surface); text-decoration: none; background: var(--smrt-color-surface-container-low, var(--smrt-color-surface)); }
  .section-link:hover { background: var(--smrt-color-surface-container); }
  h2 { margin: 0 0 .375rem; font-size: 1rem; overflow-wrap: anywhere; }
  .section-link p { font-size: .875rem; }
  .section-icon, .section-arrow { color: var(--smrt-color-on-surface-variant); }
  a:focus-visible { outline: 2px solid var(--smrt-color-on-surface); outline-offset: 3px; }
  @media (max-width: 40rem) { .category-sections { grid-template-columns: minmax(0, 1fr); } }
</style>
