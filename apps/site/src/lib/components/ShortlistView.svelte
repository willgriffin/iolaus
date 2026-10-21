<script lang="ts">
import { onMount } from 'svelte';
import PublicOpportunityCard from '$lib/components/PublicOpportunityCard.svelte';
import PublicSiteHeader from '$lib/components/PublicSiteHeader.svelte';
import { postingLink } from '$lib/public-opportunity-presentation.js';
import { createShortlistClient } from '$lib/shortlist-client.js';
import type {
  ShortlistDecision,
  ShortlistEntry,
} from '$lib/shortlist-contract.js';

let { signedIn }: { signedIn: boolean } = $props();
let entries = $state<ShortlistEntry[]>([]),
  mode = $state<'saved' | 'all'>('saved'),
  page = $state(0),
  failure = $state(''),
  warning = $state(''),
  ready = $state(false),
  busy = $state(false),
  activeSignedIn = $state<boolean | null>(null),
  refreshed = $state('');
let client = $state<ReturnType<typeof createShortlistClient> | null>(null);
const pageSize = 20;
const allVisible = $derived(
  entries.filter((entry) => mode === 'all' || entry.decision === 'saved'),
);
const visible = $derived(
  allVisible.slice(page * pageSize, (page + 1) * pageSize),
);
const safeMailEntries = $derived(
  allVisible.flatMap((entry) => {
    const link =
      entry.available === false
        ? null
        : postingLink(entry.opportunity.posting_url);
    return link ? [{ entry, link }] : [];
  }),
);
function makeClient() {
  return createShortlistClient({
    signedIn,
    onChange: (next) => (entries = next),
    onWarning: (message) => (warning = message),
  });
}
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
  page = 0;
  refreshed = '';
  client = makeClient();
  activeSignedIn = signedIn;
  void loadClient(client);
});
$effect(() => {
  const ids = visible
    .map((entry) => entry.opportunity.id)
    .sort()
    .join(',');
  if (!client || !ready || !ids || ids === refreshed) return;
  refreshed = ids;
  void client
    .refreshAvailable(visible.map((entry) => entry.opportunity.id))
    .catch(
      (error: unknown) =>
        (failure =
          error instanceof Error
            ? error.message
            : 'Could not refresh these opportunities.'),
    );
});
function switchMode(next: 'saved' | 'all') {
  mode = next;
  page = 0;
  refreshed = '';
}
async function change(entry: ShortlistEntry, decision: ShortlistDecision) {
  if (!client || !ready || busy) return;
  busy = true;
  failure = '';
  try {
    await client.mutate(entry.opportunity, { decision });
  } catch (error) {
    failure =
      error instanceof Error
        ? error.message
        : 'Could not update this opportunity.';
  } finally {
    busy = false;
  }
}
async function mark(entry: ShortlistEntry, applied: boolean) {
  if (!client || !ready || busy) return;
  busy = true;
  failure = '';
  try {
    await client.mutate(entry.opportunity, { applied });
  } catch (error) {
    failure =
      error instanceof Error
        ? error.message
        : 'Could not update this opportunity.';
  } finally {
    busy = false;
  }
}
async function opened(entry: ShortlistEntry) {
  if (!client || !ready) return;
  try {
    await client.mutate(entry.opportunity, { opened: true });
  } catch (error) {
    failure =
      error instanceof Error ? error.message : 'Could not record that opening.';
  }
}
function recheckVisible() {
  refreshed = '';
}
function mailto() {
  let body = '',
    count = 0,
    truncated = false;
  for (const { entry, link } of safeMailEntries.slice(0, 25)) {
    const line = `${entry.opportunity.title} — ${entry.opportunity.company?.name ?? 'Employer not listed'}\n${link.href}`;
    if (encodeURIComponent(body ? `${body}\n\n${line}` : line).length > 5500) {
      truncated = true;
      break;
    }
    body = body ? `${body}\n\n${line}` : line;
    count += 1;
  }
  return {
    href: `mailto:?subject=${encodeURIComponent('My opportunity shortlist')}&body=${encodeURIComponent(body)}`,
    count,
    truncated: truncated || safeMailEntries.length > count,
  };
}
const email = $derived(mailto());
</script>
<PublicSiteHeader {signedIn}/>
<section class="shortlist" aria-labelledby="shortlist-title"><h1 id="shortlist-title">Your shortlist</h1>
<div class="tabs" aria-label="Shortlist views"><button type="button" aria-pressed={mode === 'saved'} onclick={() => switchMode('saved')}>Saved ({entries.filter((entry) => entry.decision === 'saved').length})</button><button type="button" aria-pressed={mode === 'all'} onclick={() => switchMode('all')}>All shown ({entries.length})</button></div>
{#if visible.length}<button type="button" disabled={!ready} onclick={recheckVisible}>Recheck visible postings</button>{/if}
{#if email.count}<p><a href={email.href}>Email this list to yourself</a> <span class="muted">Opens your email app; enter a recipient before sending. Up to 25 safe posting links are included.</span>{#if email.truncated}<span class="muted"> The email was shortened to fit a mail link.</span>{/if}</p>{/if}
{#if !visible.length}<p class="empty">{mode === 'saved' ? 'No saved opportunities yet. Browse a search and save the ones you want to revisit.' : 'No opportunities have been reviewed yet.'}</p>{/if}
<ol>{#each visible as entry (entry.opportunity.id)}{@const safeLink = postingLink(entry.opportunity.posting_url)}<li><PublicOpportunityCard opportunity={entry.opportunity} showOriginal={entry.available !== false} onOriginalOpen={() => opened(entry)}/><div class="entry-actions">{#if entry.available === false}<p class="unavailable">This posting is no longer available. Its saved details remain here for your history.</p>{:else if safeLink}<a href={safeLink.href} target="_blank" rel="noopener noreferrer" onclick={() => opened(entry)}>Open posting <span class="sr-only">(opens in a new tab)</span></a>{/if}<label>Decision <select value={entry.decision} disabled={!ready || busy} onchange={(event) => change(entry, (event.currentTarget as HTMLSelectElement).value as ShortlistDecision)}>{#each ['seen','later','saved','passed'] as decision}<option value={decision}>{decision}</option>{/each}</select></label><button type="button" disabled={!ready || busy} onclick={() => mark(entry, !entry.appliedAt)}>{entry.appliedAt ? 'Mark not applied' : 'Mark applied'}</button>{#if entry.appliedAt}<span class="status">Applied recorded</span>{/if}</div></li>{/each}</ol>
{#if allVisible.length > pageSize}<nav aria-label="Shortlist pages"><button type="button" disabled={page === 0} onclick={() => { page -= 1; refreshed = ''; }}>Previous</button><span>Page {page + 1} of {Math.ceil(allVisible.length / pageSize)}</span><button type="button" disabled={(page + 1) * pageSize >= allVisible.length} onclick={() => { page += 1; refreshed = ''; }}>Next</button></nav>{/if}
{#if failure}<p role="alert" class="error">{failure} <button type="button" onclick={() => client && void loadClient(client)}>Retry</button></p>{/if}{#if warning}<p role="status" class="muted">{warning}</p>{/if}</section>
<style>.shortlist{max-width:70rem;margin:auto;padding:1rem;overflow-wrap:anywhere}.tabs,.entry-actions,nav{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}h1{font-size:clamp(1.8rem,7vw,3rem)}button,.entry-actions a,select{min-height:44px;padding:.5rem .75rem;font:inherit}button[aria-pressed='true']{background:#1a1814;color:#fff}ol{padding:0;list-style:none;display:grid;gap:1rem}li{border:1px solid #ddd;border-radius:.65rem;padding:1rem}.entry-actions{margin-top:.75rem}.entry-actions label{display:flex;align-items:center;gap:.25rem}.empty{padding:1rem;background:#f4f2ee;border-radius:.5rem}.unavailable,.muted{color:#655f57}.error{color:#9e1c12;font-weight:600}.status{font-weight:600}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}@media(min-width:42rem){.shortlist{padding:2rem}}</style>
