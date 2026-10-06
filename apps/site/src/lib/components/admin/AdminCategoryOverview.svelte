<script lang="ts">
import {
  type AdminCategoryKey,
  adminCategoryNavigation,
} from '$lib/admin/category-navigation';
import type { AdminResource } from '$lib/admin/resources';
import NavIcon from './NavIcon.svelte';

let { category, resources } = $props<{
  category: AdminCategoryKey;
  resources: AdminResource[];
}>();
const navigation = $derived(adminCategoryNavigation(category, resources));
</script>

<svelte:head><title>{navigation.label} — Iolaus</title></svelte:head>

<section class="category-overview" aria-labelledby="category-title">
  <a class="back-link" href={category === 'memory' ? '/admin/system' : '/admin'}>← Back to {category === 'memory' ? 'System' : 'Overview'}</a>
  <header>
    <span class="category-icon" aria-hidden="true"><NavIcon name={navigation.icon ?? 'folder-tree'} size={24} /></span>
    <div><h1 id="category-title">{navigation.label}</h1><p>{navigation.description}</p></div>
  </header>
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
  .back-link { color: var(--smrt-color-on-surface-variant); width: fit-content; padding-block: var(--smrt-spacing-2, .5rem); }
  header { display: flex; align-items: flex-start; gap: var(--smrt-spacing-4, 1rem); min-width: 0; }
  header div, .section-link div { min-width: 0; }
  h1 { margin: 0 0 var(--smrt-spacing-2, .5rem); font-size: clamp(1.5rem, 4vw, 2rem); }
  p { margin: 0; color: var(--smrt-color-on-surface-variant); line-height: 1.5; overflow-wrap: anywhere; }
  .category-icon { display: grid; place-items: center; flex: 0 0 auto; width: 3rem; height: 3rem; border-radius: var(--smrt-radius-medium, .5rem); background: var(--smrt-color-surface-container); }
  .category-sections { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--smrt-spacing-3, .75rem); }
  .section-link { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--smrt-spacing-3, .75rem); min-width: 0; min-height: 5rem; padding: var(--smrt-spacing-4, 1rem); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium, .5rem); color: var(--smrt-color-on-surface); text-decoration: none; background: var(--smrt-color-surface-container-low, var(--smrt-color-surface)); }
  .section-link:hover { background: var(--smrt-color-surface-container); }
  h2 { margin: 0 0 .375rem; font-size: 1rem; overflow-wrap: anywhere; }
  .section-link p { font-size: .875rem; }
  .section-icon, .section-arrow { color: var(--smrt-color-on-surface-variant); }
  a:focus-visible { outline: 2px solid var(--smrt-color-on-surface); outline-offset: 3px; }
  @media (max-width: 40rem) { .category-sections { grid-template-columns: minmax(0, 1fr); } }
</style>
