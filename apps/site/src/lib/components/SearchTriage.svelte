<script lang="ts">
import Clock3 from '@lucide/svelte/icons/clock-3';
import Heart from '@lucide/svelte/icons/heart';
import Layers from '@lucide/svelte/icons/layers';
import List from '@lucide/svelte/icons/list';
import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
import Undo2 from '@lucide/svelte/icons/undo-2';
import X from '@lucide/svelte/icons/x';
import { onMount, tick } from 'svelte';
import { replaceState } from '$app/navigation';
import { page as routePage } from '$app/state';
import AdminWorkspaceShell from '$lib/components/admin/AdminWorkspaceShell.svelte';
import PublicOpportunityListItem from '$lib/components/PublicOpportunityListItem.svelte';
import PublicOpportunitySearch from '$lib/components/PublicOpportunitySearch.svelte';
import PublicOpportunityTriageCard from '$lib/components/PublicOpportunityTriageCard.svelte';
import PublicSiteHeader from '$lib/components/PublicSiteHeader.svelte';
import {
  type PublicOpportunity,
  type PublicOpportunityDetail,
  type PublicSearchInput,
  publicOpportunityDetailSchema,
  publicSearchPageSchema,
} from '$lib/public-opportunity-contract.js';
import type { loadAdminShellData } from '$lib/server/admin-shell-data';
import { createShortlistClient } from '$lib/shortlist-client.js';
import type {
  ShortlistChange,
  ShortlistEntry,
} from '$lib/shortlist-contract.js';

type Facet = { value: string; label: string; count: number };
type SearchPage = {
  items: PublicOpportunity[];
  next_cursor: string | null;
  total_estimate: number;
  facets: Record<string, Facet[]>;
};
type Interpretation = {
  originalQuery: string;
  chips: { kind: string; value: string; label: string }[];
  warnings: string[];
} | null;
let {
  input,
  page,
  interpretation,
  signedIn,
  submitted,
  initialView = 'triage',
  workspace = null,
}: {
  input: PublicSearchInput;
  page: SearchPage;
  interpretation: Interpretation;
  signedIn: boolean;
  submitted: boolean;
  initialView?: 'triage' | 'list';
  workspace?: Awaited<ReturnType<typeof loadAdminShellData>> | null;
} = $props();
let entries = $state<ShortlistEntry[]>([]),
  current = $state(0),
  loadingNext = $state(false),
  busy = $state(false),
  ready = $state(false),
  failure = $state(''),
  warning = $state(''),
  items = $state<PublicOpportunity[]>([]),
  nextCursor = $state<string | null>(null),
  showFilters = $state(false),
  activeSignedIn = $state<boolean | null>(null);
let detail = $state<PublicOpportunityDetail | null>(null),
  detailState = $state<'loading' | 'ready' | 'error'>('loading'),
  detailRetry = $state(0);
let filterDialog: HTMLDialogElement;
async function openFilters() {
  showFilters = true;
  await tick();
  filterDialog.showModal();
}
let view = $state<'triage' | 'list'>('triage');
let listOrigin = $state<{ id: string; scrollY: number } | null>(null);
const selectedView = $derived(listOrigin ? 'list' : view);
$effect(() => {
  view = initialView;
});
function listScrollHost(): HTMLElement | null {
  return workspace && signedIn && selectedView === 'list'
    ? document.getElementById('smrt-admin-shell-main')
    : null;
}
function listScrollY(): number {
  return listScrollHost()?.scrollTop ?? window.scrollY;
}
function setView(next: 'triage' | 'list') {
  const origin = next === 'list' ? listOrigin : null;
  listOrigin = null;
  view = next;
  const url = new URL(routePage.url);
  url.searchParams.set('view', next);
  replaceState(url, routePage.state);
  if (origin)
    void tick().then(() => {
      const index = items.findIndex((item) => item.id === origin.id);
      const fallback = [
        ...items.slice(index + 1),
        ...items.slice(0, index).reverse(),
      ].find(isPendingInList);
      const target =
        document.getElementById(`review-${origin.id}`) ??
        (fallback ? document.getElementById(`review-${fallback.id}`) : null);
      (target ?? document.getElementById('triage-title'))?.focus({
        preventScroll: true,
      });
      (listScrollHost() ?? window).scrollTo({
        top: origin.scrollY,
        behavior: 'instant',
      });
    });
}
function reviewFromList(opportunity: PublicOpportunity) {
  const index = items.findIndex((item) => item.id === opportunity.id);
  if (index < 0) return;
  const origin = { id: opportunity.id, scrollY: listScrollY() };
  current = index;
  listOrigin = origin;
  view = 'triage';
  void tick().then(() =>
    document.querySelector<HTMLElement>('.triage-card')?.focus(),
  );
}
let deckGeneration = 0;
let client = $state<ReturnType<typeof createShortlistClient> | null>(null);
let lastUndo = $state<{
  opportunity: PublicOpportunity;
  change: ShortlistChange;
  index: number;
} | null>(null);
type UiIdentity = {
  deck: number;
  cardId: string | null;
  view: 'triage' | 'list';
  listOriginId: string | null;
};
function captureUiIdentity(): UiIdentity {
  return {
    deck: deckGeneration,
    cardId: card?.id ?? null,
    view,
    listOriginId: listOrigin?.id ?? null,
  };
}
function isCurrentUi(identity: UiIdentity): boolean {
  return (
    deckGeneration === identity.deck &&
    card?.id === identity.cardId &&
    view === identity.view &&
    (listOrigin?.id ?? null) === identity.listOriginId
  );
}
const seenIds = new Set<string>();
const card = $derived(items[current] ?? null);
const entryFor = (opportunity: PublicOpportunity) =>
  entries.find((entry) => entry.opportunity.id === opportunity.id);
function isPendingInList(item: PublicOpportunity) {
  const decision = entryFor(item)?.decision;
  return decision !== 'passed' && decision !== 'saved' && decision !== 'later';
}
const visibleListItems = $derived(items.filter(isPendingInList));
const filters = [
  ['seniority', 'Seniority'],
  ['work_mode', 'Work mode'],
  ['employment_type', 'Employment type'],
  ['country', 'Country'],
] as const;
$effect(() => {
  deckGeneration += 1;
  items = [...page.items];
  nextCursor = page.next_cursor;
  current = 0;
  listOrigin = null;
  lastUndo = null;
  failure = '';
  showFilters = false;
  filterDialog?.close();
});
$effect(() => {
  const opportunity = view === 'triage' ? card : null;
  // The active card alone receives a detail read. Cleanup aborts an old read
  // before the next card can paint, and the sequence fence covers fetch
  // implementations that resolve after abort.
  if (!opportunity) {
    detail = null;
    detailState = 'loading';
    return;
  }
  const controller = new AbortController();
  const id = opportunity.id;
  const retry = detailRetry;
  detail = null;
  detailState = 'loading';
  void (async () => {
    try {
      const response = await fetch(
        `/api/public/v1/opportunities/${encodeURIComponent(id)}`,
        { headers: { accept: 'application/json' }, signal: controller.signal },
      );
      if (!response.ok)
        throw new Error(`Could not load this posting (${response.status}).`);
      const next = publicOpportunityDetailSchema.parse(await response.json());
      if (next.id !== id) throw new Error('Unexpected posting returned.');
      if (
        !controller.signal.aborted &&
        card?.id === id &&
        detailRetry === retry
      ) {
        detail = next;
        detailState = 'ready';
      }
    } catch (error) {
      if (
        !controller.signal.aborted &&
        card?.id === id &&
        detailRetry === retry
      )
        detailState = 'error';
    }
  })();
  return () => controller.abort();
});
async function loadClient(next: ReturnType<typeof createShortlistClient>) {
  ready = false;
  failure = '';
  try {
    await next.load();
    if (signedIn) await next.mergeGuest();
    ready = true;
  } catch (error) {
    failure =
      error instanceof Error ? error.message : 'Could not load your shortlist.';
  }
}
function makeClient() {
  return createShortlistClient({
    signedIn,
    onChange: (next) => (entries = next),
    onWarning: (message) => (warning = message),
  });
}
onMount(() => {
  client = makeClient();
  activeSignedIn = signedIn;
  void loadClient(client);
  return () => client?.destroy();
});
$effect(() => {
  if (!client || activeSignedIn === signedIn) return;
  client.destroy();
  entries = [];
  lastUndo = null;
  client = makeClient();
  activeSignedIn = signedIn;
  void loadClient(client);
});
$effect(() => {
  const displayed = view === 'list' ? items : card ? [card] : [];
  const unseen = displayed.filter(
    (item) =>
      !seenIds.has(item.id) &&
      !entries.some((entry) => entry.opportunity.id === item.id),
  );
  if (!submitted || !unseen.length || !client || !ready || busy) return;
  const activeClient = client;
  busy = true;
  void (async () => {
    try {
      for (const opportunity of unseen) {
        await activeClient.mutate(opportunity, { decision: 'seen' });
        seenIds.add(opportunity.id);
      }
    } catch (error) {
      // Stop automatic retries; Retry clears this set and reloads the adapter.
      for (const opportunity of unseen) seenIds.add(opportunity.id);
      failure =
        error instanceof Error
          ? error.message
          : 'Could not record these opportunities.';
    } finally {
      busy = false;
    }
  })();
});
function entriesForInput(next: PublicSearchInput) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null || value === '') continue;
    for (const item of Array.isArray(value) ? value : [value])
      params.append(key, String(item));
  }
  return params;
}
function optionLabel(value: string) {
  return value.replaceAll('_', ' ');
}
async function record(change: ShortlistChange, target = card, advance = true) {
  const originalCard = target,
    originalEntry = originalCard ? entryFor(originalCard) : undefined,
    index = items.findIndex((item) => item.id === originalCard?.id);
  const originScrollY = listScrollY();
  if (!originalCard || !client || !ready || busy) return;
  const identity = captureUiIdentity();
  busy = true;
  failure = '';
  const prior: ShortlistChange = {
    decision: originalEntry?.decision ?? 'seen',
    applied: Boolean(originalEntry?.appliedAt),
  };
  try {
    await client.mutate(originalCard, change);
    // The choice is durable even if the user navigated away while it was in
    // flight. Its completion must not move a newly selected card, restore an
    // old list origin, or make an obsolete choice undoable.
    if (!isCurrentUi(identity)) return;
    lastUndo = { opportunity: originalCard, change: prior, index };
    if (change.decision && advance) {
      if (listOrigin) setView('list');
      else current = index + 1;
    } else if (change.decision && view === 'list') {
      listOrigin = { id: originalCard.id, scrollY: originScrollY };
      setView('list');
    }
  } catch (error) {
    if (isCurrentUi(identity))
      failure =
        error instanceof Error
          ? error.message
          : 'Could not save that choice. Please retry.';
  } finally {
    busy = false;
  }
}
async function opened(displayed = card) {
  if (!displayed || !client || !ready) return;
  const identity = captureUiIdentity();
  try {
    await client.mutate(displayed, { opened: true });
  } catch (error) {
    if (isCurrentUi(identity))
      failure =
        error instanceof Error
          ? error.message
          : 'Could not record that opening.';
  }
}
async function undo() {
  const undo = lastUndo;
  if (!undo || !client || !ready || busy) return;
  const identity = captureUiIdentity();
  busy = true;
  failure = '';
  try {
    await client.mutate(undo.opportunity, undo.change);
    if (!isCurrentUi(identity)) return;
    current = undo.index;
    lastUndo = null;
  } catch (error) {
    if (isCurrentUi(identity))
      failure =
        error instanceof Error
          ? error.message
          : 'Could not undo that choice. Reload and try again.';
  } finally {
    busy = false;
  }
}
async function getNext() {
  if (!nextCursor || loadingNext) return;
  const generation = deckGeneration,
    cursor = nextCursor;
  loadingNext = true;
  failure = '';
  try {
    const response = await fetch(
      `/api/public/v1/opportunities?${entriesForInput({ ...input, cursor })}`,
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok)
      throw new Error(
        `Could not load more opportunities (${response.status}).`,
      );
    const next = publicSearchPageSchema.parse(await response.json());
    if (generation !== deckGeneration) return;
    const known = new Set(items.map((item) => item.id));
    items = [...items, ...next.items.filter((item) => !known.has(item.id))];
    nextCursor = next.next_cursor;
  } catch (error) {
    if (generation === deckGeneration)
      failure =
        error instanceof Error
          ? error.message
          : 'Could not load more opportunities.';
  } finally {
    loadingNext = false;
  }
}
function retry() {
  seenIds.clear();
  if (client) void loadClient(client);
}
function retryDetails() {
  detailRetry += 1;
}
</script>

  {#snippet verdicts()}<div class="header-verdicts" role="group" aria-label="Triage actions"><button type="button" class="verdict" disabled={!ready || busy} onclick={() => record({decision:'passed'})}><X size={22} aria-hidden="true"/><span>Pass</span></button><button type="button" class="verdict" disabled={!ready || busy} onclick={() => record({decision:'later'})}><Clock3 size={22} aria-hidden="true"/><span>Later</span></button><button type="button" class="verdict save" disabled={!ready || busy} onclick={() => record({decision:'saved'})}><Heart size={22} aria-hidden="true"/><span>Save</span></button></div>{/snippet}
  {#snippet undoControl()}<button class="header-undo" type="button" aria-label="Undo last choice" title="Undo last choice" disabled={!ready || busy || !lastUndo} onclick={undo}><Undo2 size={22} aria-hidden="true"/></button>{/snippet}
{#snippet resultActions()}{#if submitted}{#if selectedView === 'list'}<button class="filter-icon" type="button" aria-label="Filters" title="Filters" aria-haspopup="dialog" onclick={openFilters}><SlidersHorizontal size={21} aria-hidden="true" /></button>{/if}<div class="view-switch" role="group" aria-label="Results view"><button type="button" aria-label="Triage view" title="Triage view" aria-pressed={selectedView === 'triage'} onclick={() => setView('triage')}><Layers size={20} aria-hidden="true" /></button><button type="button" aria-label="List view" title="List view" aria-pressed={selectedView === 'list'} onclick={() => setView('list')}><List size={20} aria-hidden="true" /></button></div>{/if}{/snippet}
{#snippet resultBody()}

  <div class="triage-content"><h1 id="triage-title" tabindex="-1">Find opportunities</h1>

  {#if !submitted}<p class="start">Enter a role or skill to start a focused review. You can also add filters from the skill catalog.</p>{:else if view === 'list'}
    <ul class="result-list" aria-label="Opportunity results">
      {#each visibleListItems as opportunity (opportunity.id)}
        <li><PublicOpportunityListItem {opportunity} decision={entryFor(opportunity)?.decision} onReview={() => reviewFromList(opportunity)} busy={!ready || busy} onChoice={(decision) => record({decision}, opportunity, false)}/></li>
      {/each}
    </ul>
    {#if !visibleListItems.length}<p class="start">{items.length ? 'You have reviewed all opportunities in this list. Undo your last choice or load more results.' : 'No opportunities match this search. Try fewer filters or a different role or skill.'}</p>{/if}
    {#if nextCursor}<button class="load-more" type="button" onclick={getNext} disabled={loadingNext}>{loadingNext ? 'Loading more opportunities…' : 'Load more opportunities'}</button>{/if}
  {:else if card}<div class="card-wrap"><PublicOpportunityTriageCard opportunity={card} {detail} {detailState} selectedSkills={input.skills} busy={!ready || busy} onAction={(decision) => record({ decision })} onOriginalOpen={() => opened()} onRetry={retryDetails}/></div>{:else}<p class="start">{items.length ? 'You have reached the end of these results.' : 'No opportunities match this search.'} {#if !items.length}Try fewer filters or a different role or skill.{/if}</p>{#if nextCursor}<button type="button" onclick={getNext} disabled={loadingNext}>{loadingNext ? 'Loading next opportunity…' : 'Show next opportunity'}</button>{:else if items.length}<a href="/shortlist">Review your shortlist</a>{/if}{/if}
  {#if lastUndo && (view !== 'triage' || !card)}<button class="undo" type="button" disabled={!ready || busy} onclick={undo}>Undo last choice</button>{/if}{#if failure}<p class="error" role="alert">{failure} <button type="button" onclick={retry}>Retry</button></p>{/if}{#if warning}<p class="notice" role="status">{warning}</p>{/if}
  </div>
{/snippet}
{#if workspace && signedIn && selectedView === 'list'}
  <AdminWorkspaceShell data={workspace} browsing headerActions={resultActions} headerCenter={submitted && view === 'triage' && card ? verdicts : undefined} headerAuxiliary={submitted && view === 'triage' && card ? undoControl : undefined}>
    <section class="triage" class:deck={view === 'triage' && submitted} class:embedded={view === 'triage' && submitted} aria-labelledby="triage-title">{@render resultBody()}</section>
  </AdminWorkspaceShell>
{:else}
  <section class="triage" class:deck={view === 'triage' && submitted} aria-labelledby="triage-title">
    <PublicSiteHeader {signedIn} center={submitted && view === 'triage' && card ? verdicts : undefined} auxiliary={submitted && view === 'triage' && card ? undoControl : undefined} actions={resultActions}/>
    {@render resultBody()}
  </section>
{/if}
<dialog class="filter-dialog" bind:this={filterDialog} aria-labelledby="filters-title" onclose={() => showFilters = false}>
  <header class="filter-heading"><div><h2 id="filters-title">Refine your search</h2><p>Choose what matters for your next opportunity.</p></div><button type="button" aria-label="Close filters" onclick={() => filterDialog.close()}><X size={22} aria-hidden="true" /></button></header>
  {#if showFilters}<PublicOpportunitySearch filterMode q={input.q} skills={page.facets.skills ?? []} selectedSkills={input.skills}>
    <input type="hidden" name="start" value="1"/><input type="hidden" name="view" value="list"/>
    <fieldset><legend>Location &amp; work</legend><div class="filter-grid"><label>Location<input name="location" maxlength="120" value={input.location ?? ''} placeholder="Anywhere"/></label>
    {#each filters as [name, label]}<label>{label}<select name={name} value={input[name]?.[0] ?? ''}><option value="">Any</option>{#if input[name]?.[0] && !(page.facets[name] ?? []).some((facet) => facet.value === input[name][0])}<option value={input[name][0]}>{optionLabel(input[name][0])}</option>{/if}{#each page.facets[name] ?? [] as facet}<option value={facet.value}>{facet.label} ({facet.count})</option>{/each}</select></label>{/each}</div></fieldset>
    <fieldset><legend>Compensation</legend><div class="filter-grid"><label>Minimum pay<input name="salary_min" type="number" min="0" value={input.salary_min ?? ''} placeholder="No minimum"/></label><label>Currency<input name="salary_currency" maxlength="3" value={input.salary_currency ?? ''} placeholder="e.g. CAD"/></label><label>Pay period<select name="salary_period"><option value="">Any</option>{#each ['hour','day','week','month','year'] as period}<option value={period} selected={input.salary_period === period}>{optionLabel(period)}</option>{/each}</select></label></div></fieldset>
    <fieldset><legend>Display</legend><label>Sort results<select name="sort" value={input.sort}><option value="relevance">Relevance</option><option value="newest">Newest first</option></select></label></fieldset>
  </PublicOpportunitySearch>{/if}
</dialog>

<style>
.triage.deck.embedded { height:100%; }
:global(.admin-content.browsing:has(.embedded)) { height:100%; min-height:0; }
:global(#smrt-admin-shell-main:has(.embedded)) { overflow:hidden; }

.deck .triage-content { display:flex; flex-direction:column; flex:1; width:100%; min-height:0; max-width:none; margin:0; padding:0; }
.triage.deck { display:flex; flex-direction:column; width:100%; max-width:none; height:100dvh; margin:0; padding:0; overflow:clip; background:var(--bg); }
.deck .triage-content > :not(.card-wrap) { flex-shrink:0; }
h1 { position:absolute; width:1px; height:1px; margin:0; overflow:hidden; clip-path:inset(50%); }
.deck .card-wrap { flex:1; min-height:0; overflow:clip; }
.deck .undo { align-self:center; margin:0; }
.deck .error, .deck .notice { margin:.25rem 1rem; }

.view-switch { display:inline-flex; flex-shrink:0; overflow:hidden; border:1px solid var(--border-strong); border-radius:.5rem; }
.view-switch button { display:grid; place-items:center; width:44px; height:44px; padding:0; border:0; border-radius:0; background:var(--bg-elev); color:var(--ink); cursor:pointer; }
.view-switch button + button { border-left:1px solid var(--border-strong); }
.view-switch button:focus-visible { outline:2px solid var(--ink); outline-offset:-4px; }
button[aria-pressed="true"], .view-switch button[aria-pressed="true"] { background:var(--accent); color:var(--bg); border-color:var(--accent); }
.result-list { display:grid; gap:.65rem; padding:0; list-style:none; }
.result-list li { min-width:0; }
.load-more { width:100%; margin-top:1rem; }
.triage-content{max-width:52rem;margin:auto;padding:1rem;overflow-wrap:anywhere}.start{padding:1rem;background:var(--bg-elev);border-radius:.5rem}button,select,input{min-height:44px;padding:.5rem .75rem;font:inherit;max-width:100%;box-sizing:border-box}.undo{margin-top:.75rem}.error{color:#9e1c12;font-weight:600}.notice{color:var(--ink-3)}@media(min-width:42rem){.triage-content{padding:2rem}}
.filter-icon { display:grid; place-items:center; width:44px; height:44px; padding:0; border-radius:.5rem; }
.filter-icon:hover { background:var(--tag-bg); }
.filter-dialog { width:min(42rem, calc(100vw - 1.5rem)); max-height:calc(100dvh - 1.5rem); margin:auto; padding:1.25rem; box-sizing:border-box; border:1px solid var(--border-strong); border-radius:1rem; background:var(--bg-elev); color:var(--ink); overflow:auto; }
.filter-dialog::backdrop { background:rgb(0 0 0 / .6); backdrop-filter:blur(3px); }
.filter-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; margin-bottom:1.5rem; }
.filter-heading h2 { margin:0; font-size:1.5rem; }
.filter-heading p { margin:.4rem 0 0; color:var(--ink-3); font-size:.9rem; }
.filter-heading button { display:grid; place-items:center; flex-shrink:0; width:44px; padding:0; }
.filter-dialog fieldset { margin:0; padding:0; border:0; min-width:0; }
.filter-dialog legend { padding:0; margin-bottom:.75rem; font-weight:700; }
.filter-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.85rem; }
.filter-dialog label { display:grid; gap:.35rem; font-size:.85rem; color:var(--ink-3); }
.filter-dialog input, .filter-dialog select { width:100%; min-width:0; background:var(--bg); color:var(--ink); border:1px solid var(--border-strong); border-radius:.5rem; }
@media(max-width:30rem) { .filter-grid { grid-template-columns:1fr; } }
.header-verdicts { display:flex; align-items:center; justify-content:center; gap:.6rem; }
.header-verdicts .verdict { display:grid; place-items:center; width:56px; height:56px; padding:0; border:0; border-radius:.5rem; background:transparent; color:var(--ink); }
.header-verdicts .verdict:hover:not(:disabled) { background:var(--tag-bg); }
.header-verdicts .verdict:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.verdict span { font-size:.65rem; font-weight:700; }
.header-undo { display:grid; place-items:center; width:44px; height:44px; padding:0; color:var(--ink-3); border-radius:50%; }
.header-undo:disabled, .verdict:disabled { opacity:.35; cursor:default; }
.header-undo:hover:not(:disabled) { background:var(--tag-bg); }
</style>
