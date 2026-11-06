<script lang="ts">
import Layers from '@lucide/svelte/icons/layers';
import { getContext } from 'svelte';
import {
  ADMIN_HEADER_ACTIONS,
  type AdminHeaderActions,
} from '$lib/admin/header-actions';
import type { AdminOverview } from '$lib/admin/overview';

let { overview } = $props<{ overview: Promise<AdminOverview> }>();
const adminHeader = getContext<AdminHeaderActions | undefined>(
  ADMIN_HEADER_ACTIONS,
);
$effect(() => adminHeader?.register(overviewHeaderActions));

function dueDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(
        date,
      );
}
</script>

{#snippet overviewHeaderActions()}
  <a
    class="admin-header-action"
    href="/admin/opportunities?review=unsorted&triage=1"
    aria-label="Review new opportunities"
    title="Review new opportunities"
  >
    <Layers size={21} aria-hidden="true" />
  </a>
{/snippet}

<svelte:head><title>Overview — Employment Search</title></svelte:head>

{#snippet loading(label: string)}
  <div class="loading" role="status">
    <p>{label}</p>
    {#each [1, 2, 3] as row (row)}
      <div class="skeleton" aria-hidden="true"></div>
    {/each}
  </div>
{/snippet}

<div class="overview" data-testid="admin-overview">
  <div class="overview-columns">
    <section aria-labelledby="overview-tasks">
      <header class="section-heading"><div><h2 id="overview-tasks">Priority tasks</h2><p>Overdue work and actions waiting on you come first.</p></div><a href="/admin/tasks">All tasks</a></header>
      {#await overview}
        {@render loading('Loading priority tasks…')}
      {:then data}
        {#if data.tasks.length}
          <ol class="task-list">
            {#each data.tasks as task (task.id)}
              <li>
                <a class="record-link" href={task.href}>
                  <span class="record-title">{task.title}</span>
                  <span class="record-meta"><span class="priority">{task.priority}</span><span>{task.assignee}</span><span>{task.status}</span>{#if dueDate(task.dueAt)}<span>Due {dueDate(task.dueAt)}</span>{/if}</span>
                </a>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="empty-state">No active tasks to show. Review new opportunities or check your applications.</p>
        {/if}
      {:catch}
        <p role="status">Could not load priority tasks. You can still open All tasks.</p>
      {/await}
    </section>

    <section aria-labelledby="overview-opportunities">
      <header class="section-heading"><div><h2 id="overview-opportunities">Best new opportunities</h2><p>Matches for your target roles and work locations, excluding existing applications.</p></div><a href="/admin/opportunities?review=unsorted&amp;sort=score&amp;excludeExpired=1&amp;excludeStale=1">All new opportunities</a></header>
      {#await overview}
        {@render loading('Loading opportunities…')}
      {:then data}
        {#if data.opportunities.length}
          <ol class="opportunity-list">
            {#each data.opportunities as opportunity (opportunity.id)}
              <li><a class="record-link opportunity-link" href={opportunity.href}>
                <div><span class="record-title">{opportunity.title}</span><span class="record-meta">{opportunity.company}{#if opportunity.location}<span>{opportunity.location}</span>{/if}</span><span class="eligibility">{opportunity.eligibility}</span>
                  {#if opportunity.matchHighlight}<span class="record-meta match-highlight">{opportunity.matchHighlight}</span>{/if}
                </div>
                {#if opportunity.discoveryStatus === 'screened-with-gaps'}
                  {#if !opportunity.matchHighlight}<span class="record-meta">{opportunity.readiness}</span>{/if}
                {:else if opportunity.fitScore !== null}
                  <span class="match"><strong>{opportunity.fitScore}</strong><span>Match / 100</span></span>
                {/if}
              </a></li>
            {/each}
          </ol>
        {:else}
          <p class="empty-state">No new matches to show yet. Open Opportunities to check matching progress.</p>
        {/if}

      {:catch}
        <p role="status">Could not load recommendations. You can still open All new opportunities.</p>
      {/await}
    </section>
  </div>
  <nav class="section-menu" aria-label="Workspace sections">
    <a href="/admin/career">Resume <span>Editor, profiles and experience</span></a>
    <a href="/admin/research">Research <span>Sources and companies</span></a>
    <a href="/admin/system">System <span>Memory, preferences and activity</span></a>
    <a href="/admin/account">Account <span>Download or delete your data</span></a>
  </nav>
</div>

<style>
  .admin-header-action { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:.4rem; color:var(--smrt-color-on-surface-variant); }
  .admin-header-action:hover { background:var(--smrt-color-surface-container); color:var(--smrt-color-on-surface); }
  .admin-header-action:focus-visible { outline:2px solid var(--smrt-color-on-surface); outline-offset:2px; }
  .overview { display: grid; gap: var(--smrt-spacing-6); min-width: 0; }
  .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--smrt-spacing-4); flex-wrap: wrap; }
  h2, p { margin: 0; }
  h2 { font-size: 1.2rem; }
  p { color: var(--smrt-color-on-surface-variant); line-height: 1.5; margin-top: var(--smrt-spacing-2); }
  a { color: var(--smrt-color-primary); }
  .overview-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--smrt-spacing-6); }
  section { min-width: 0; padding: var(--smrt-spacing-5); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-large); background: var(--smrt-color-surface-container-low); }
  .section-heading a { min-height: 44px; display: inline-flex; align-items: center; font-size: .9rem; }
  ol { list-style: none; padding: 0; margin: var(--smrt-spacing-4) 0 0; display: grid; gap: var(--smrt-spacing-2); }
  .record-link { display: grid; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-3); border-radius: var(--smrt-radius-medium); color: var(--smrt-color-on-surface); text-decoration: none; min-height: 44px; }
  .record-link:hover, .record-link:focus-visible { background: var(--smrt-color-surface-container-high); }
  .record-link:focus-visible, a:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .record-title { display: block; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; }
  .record-meta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--smrt-spacing-2); margin-top: var(--smrt-spacing-1); font-size: .85rem; color: var(--smrt-color-on-surface-variant); }
  .priority { color: var(--smrt-color-primary); font-weight: 600; }
  .match-highlight { color: var(--smrt-color-on-surface); font-weight: 600; overflow-wrap: anywhere; }
  .opportunity-link { grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--smrt-spacing-4); }
  .eligibility { display: block; font-size: .8rem; color: var(--smrt-color-on-surface-variant); margin-top: var(--smrt-spacing-2); }
  .match { display: grid; justify-items: end; gap: var(--smrt-spacing-1); }
  .match strong { color: var(--smrt-color-primary); font-size: 1.4rem; }
  .match span { font-size: .7rem; color: var(--smrt-color-on-surface-variant); }
  .loading { display: grid; gap: var(--smrt-spacing-2); margin-top: var(--smrt-spacing-4); }
  .skeleton { height: 3.5rem; border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface-container-high); }
  .empty-state { padding: var(--smrt-spacing-3) 0; }
  .section-menu { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--smrt-spacing-3); }
  .section-menu a { display: grid; gap: var(--smrt-spacing-1); padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); text-decoration: none; min-height: 44px; font-weight: 600; }
  .section-menu span { font-size: .8rem; font-weight: 400; color: var(--smrt-color-on-surface-variant); }
  @media (max-width: 900px) { .overview-columns { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 600px) { .section-menu { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 480px) { section { padding: var(--smrt-spacing-3); } .overview { gap: var(--smrt-spacing-4); } }
</style>
