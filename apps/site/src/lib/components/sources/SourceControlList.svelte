<script lang="ts">
import CircleCheck from '@lucide/svelte/icons/circle-check';
import CircleX from '@lucide/svelte/icons/circle-x';
import ExternalLink from '@lucide/svelte/icons/external-link';
import Pencil from '@lucide/svelte/icons/pencil';
import Play from '@lucide/svelte/icons/play';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import { onMount } from 'svelte';
import type { AdminRecord } from '$lib/admin/dock';
import SourceCrawlProgress from './SourceCrawlProgress.svelte';

type SourceHealth = {
  active: boolean;
  health: {
    created: number;
    errors: number;
    failedRuns: number;
    runs: number;
  };
  id: string;
  lastCheckedAt: string | null;
  name: string;
  provider: string;
  type: string;
};

type CrawlRequest = {
  createdAt: number;
  idempotencyKey: string;
};

type CrawlResult = {
  crawlId: string;
  reused: boolean;
  status: string;
};

type ActionState = 'activate' | 'crawl' | 'deactivate';
type SourceStateFilter = 'active' | 'all' | 'paused';

let {
  activeFilter = 'all',
  onRefresh = () => undefined,
  records,
}: {
  activeFilter?: SourceStateFilter;
  onRefresh?: () => void;
  records: AdminRecord[];
} = $props();

const MAX_CRAWL_RESULTS = 25;
const CRAWL_REQUEST_TTL_MS = 15 * 60 * 1_000;
const CRAWL_REASON = 'Requested from the Sources page.';
const ACTIVATION_REASON = 'Updated from the Sources page.';

let activeOverrides = $state<Record<string, boolean>>({});
let actionBySourceId = $state<Record<string, ActionState | undefined>>({});
let crawlBySourceId = $state<Record<string, CrawlResult | undefined>>({});
let feedbackBySourceId = $state<Record<string, string | undefined>>({});
let feedbackToneBySourceId = $state<
  Record<string, 'error' | 'success' | undefined>
>({});
let healthBySourceId = $state<Record<string, SourceHealth | undefined>>({});
let healthError = $state('');
let healthLoading = $state(true);

/**
 * The generic admin collection is only an initial render hint for this
 * curated page. Source health is the bounded, provenance-checked root-source
 * projection used by the agent surface, so fold it back into the cards once
 * it arrives. This prevents a valid local root from looking missing merely
 * because a generic collection hydration raced or used a stale snapshot.
 */
const rootSources = $derived.by(() => {
  const byId = new Map<string, AdminRecord>();

  for (const record of records) {
    if (!isRootSource(record)) continue;
    const id = sourceId(record);
    if (id) byId.set(id, record);
  }

  for (const item of Object.values(healthBySourceId)) {
    if (!item?.id) continue;
    const existing = byId.get(item.id) ?? {};
    // Health only lists durable, operable roots. Keep the generic record's
    // URL when available because health intentionally never exposes it.
    byId.set(item.id, {
      ...existing,
      id: item.id,
      isActive: item.active,
      lastCheckedAt: item.lastCheckedAt,
      name: item.name,
      parentSourceId: null,
      provider: item.provider,
      sourceRole: 'root',
      type: item.type,
    });
  }

  return [...byId.values()];
});
const visibleRootSources = $derived(
  rootSources.filter((source) =>
    activeFilter === 'all'
      ? true
      : activeFilter === 'active'
        ? active(source)
        : !active(source),
  ),
);

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function isRootSource(record: AdminRecord): boolean {
  return text(record.sourceRole) === 'root' && !text(record.parentSourceId);
}

function sourceId(source: AdminRecord): string {
  return text(source.id);
}

function sourceName(source: AdminRecord): string {
  return text(source.name) || 'Untitled job source';
}

function providerLabel(source: AdminRecord): string {
  const provider =
    healthBySourceId[sourceId(source)]?.provider || text(source.provider);
  return humanize(provider || 'unknown');
}

function sourceUrl(source: AdminRecord): string {
  return text(source.url);
}

function safeSourceUrl(source: AdminRecord): string {
  const value = sourceUrl(source);
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function active(source: AdminRecord): boolean {
  const id = sourceId(source);
  return Object.hasOwn(activeOverrides, id)
    ? activeOverrides[id] === true
    : source.isActive === true ||
        text(source.isActive).toLowerCase() === 'true';
}

function pending(source: AdminRecord): ActionState | undefined {
  return actionBySourceId[sourceId(source)];
}

function health(source: AdminRecord): SourceHealth | undefined {
  return healthBySourceId[sourceId(source)];
}

function healthLabel(source: AdminRecord): string {
  const summary = health(source)?.health;
  if (!summary || summary.runs === 0) return 'Ready to pull';
  if (summary.errors > 0 || summary.failedRuns > 0) return 'Needs attention';
  return 'Healthy';
}

function healthDetail(source: AdminRecord): string {
  const summary = health(source)?.health;
  if (!summary || summary.runs === 0) return 'No completed pulls yet.';
  const results = `${summary.created} new ${summary.created === 1 ? 'listing' : 'listings'}`;
  if (summary.errors > 0) {
    return `${results}; ${summary.errors} ${summary.errors === 1 ? 'item needs' : 'items need'} attention.`;
  }
  return `${results} from ${summary.runs} ${summary.runs === 1 ? 'pull' : 'pulls'}.`;
}

function lastPull(source: AdminRecord): string {
  const value = health(source)?.lastCheckedAt ?? text(source.lastCheckedAt);
  if (!value) return 'Not pulled yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function humanize(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function setFeedback(
  id: string,
  message: string,
  tone: 'error' | 'success',
): void {
  feedbackBySourceId = { ...feedbackBySourceId, [id]: message };
  feedbackToneBySourceId = { ...feedbackToneBySourceId, [id]: tone };
}

function setPending(id: string, state: ActionState | undefined): void {
  actionBySourceId = { ...actionBySourceId, [id]: state };
}

function boundedError(response: unknown, fallback: string): string {
  if (!response || typeof response !== 'object') return fallback;
  const message = text((response as Record<string, unknown>).error);
  return message ? message.slice(0, 300) : fallback;
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      boundedError(payload, 'That action could not be completed.'),
    );
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('That action returned an unexpected response.');
  }
  return payload as Record<string, unknown>;
}

function crawlStorageKey(id: string): string {
  return `iolaus.source-crawl-request.${id}`;
}

function forgetCrawlRequest(id: string): void {
  try {
    sessionStorage.removeItem(crawlStorageKey(id));
  } catch {
    // Storage is only a retry convenience.
  }
}

function crawlRequest(id: string): CrawlRequest {
  const key = crawlStorageKey(id);
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<CrawlRequest>;
      if (
        typeof parsed.idempotencyKey === 'string' &&
        parsed.idempotencyKey.length >= 8 &&
        typeof parsed.createdAt === 'number' &&
        Date.now() - parsed.createdAt < CRAWL_REQUEST_TTL_MS
      ) {
        return {
          createdAt: parsed.createdAt,
          idempotencyKey: parsed.idempotencyKey,
        };
      }
    }
  } catch {
    // Storage is a retry convenience only. A fresh in-memory key is safe.
  }

  const request = {
    createdAt: Date.now(),
    idempotencyKey: `source-ui:${id}:${crypto.randomUUID()}`,
  };
  try {
    sessionStorage.setItem(key, JSON.stringify(request));
  } catch {
    // Private browsing may deny storage; the button still remains bounded.
  }
  return request;
}

async function refreshHealth(): Promise<void> {
  healthLoading = true;
  healthError = '';
  try {
    const response = await fetch(
      '/api/job-search/source-health?limit=25&historyLimit=10',
      { credentials: 'same-origin' },
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== 'object') {
      throw new Error(
        boundedError(payload, 'Source health could not be refreshed.'),
      );
    }
    const items = Array.isArray((payload as Record<string, unknown>).items)
      ? ((payload as Record<string, unknown>).items as SourceHealth[])
      : [];
    healthBySourceId = Object.fromEntries(
      items
        .filter((item) => typeof item?.id === 'string')
        .map((item) => [item.id, item]),
    );
  } catch (caught) {
    healthError =
      caught instanceof Error
        ? caught.message
        : 'Source health could not be refreshed.';
  } finally {
    healthLoading = false;
  }
}

async function changeActive(source: AdminRecord): Promise<void> {
  const id = sourceId(source);
  if (!id || pending(source)) return;
  const next = !active(source);
  setPending(id, next ? 'activate' : 'deactivate');
  setFeedback(id, '', 'success');
  try {
    await postJson('/api/job-search/set-source-active', {
      active: next,
      reason: ACTIVATION_REASON,
      sourceId: id,
    });
    activeOverrides = { ...activeOverrides, [id]: next };
    setFeedback(id, next ? 'Source activated.' : 'Source paused.', 'success');
    await refreshHealth();
    onRefresh();
  } catch (caught) {
    setFeedback(
      id,
      caught instanceof Error
        ? caught.message
        : 'The source could not be updated.',
      'error',
    );
  } finally {
    setPending(id, undefined);
  }
}

async function pullNow(source: AdminRecord): Promise<void> {
  const id = sourceId(source);
  if (!id || pending(source)) return;
  if (!active(source)) {
    setFeedback(id, 'Activate this source before pulling listings.', 'error');
    return;
  }
  setPending(id, 'crawl');
  setFeedback(id, '', 'success');
  try {
    const request = crawlRequest(id);
    const response = await postJson('/api/job-search/crawl-source', {
      idempotencyKey: request.idempotencyKey,
      limit: MAX_CRAWL_RESULTS,
      reason: CRAWL_REASON,
      sourceId: id,
    });
    const crawlId = text(response.crawlId);
    const result = {
      crawlId,
      reused: response.reused === true,
      status: text(response.status) || 'queued',
    };
    crawlBySourceId = { ...crawlBySourceId, [id]: result };
    setFeedback(
      id,
      result.reused
        ? 'The existing pull is still being tracked.'
        : 'Pull queued. We will show new listings when it finishes.',
      'success',
    );
  } catch (caught) {
    setFeedback(
      id,
      caught instanceof Error
        ? caught.message
        : 'The pull could not be started.',
      'error',
    );
  } finally {
    setPending(id, undefined);
  }
}

async function pullAgain(source: AdminRecord): Promise<void> {
  const id = sourceId(source);
  // A terminal progress card can receive two queued clicks before its parent
  // re-renders. Do not let the second click erase the freshly-created request
  // key that the first click is about to use for an active crawl.
  if (!id || pending(source)) return;
  forgetCrawlRequest(id);
  await pullNow(source);
}

onMount(() => {
  void refreshHealth();
});
</script>

<section class="source-controls" aria-label="Job sources">
  {#if healthError}
    <p class="source-health-error" role="status">
      {healthError}
      <button type="button" onclick={() => void refreshHealth()}>Try again</button>
    </p>
  {/if}

  <div class="source-card-list" aria-busy={healthLoading}>
    {#each visibleRootSources as source (source.id)}
      {@const id = sourceId(source)}
      {@const sourceActive = active(source)}
      {@const sourcePending = pending(source)}
      {@const queuedCrawl = crawlBySourceId[id]}
      {@const sourceLink = safeSourceUrl(source)}
      <article
        class="source-card"
        class:inactive={!sourceActive}
        data-source-id={id}
        data-source-crawl-id={queuedCrawl?.crawlId ?? undefined}
      >
        <header>
          <div>
            <h3>{sourceName(source)}</h3>
            <p class="source-provider">{providerLabel(source)} · {humanize(text(source.type) || 'job board')}</p>
          </div>
          <span class:active={sourceActive} class="source-state">
            {sourceActive ? 'Active' : 'Paused'}
          </span>
        </header>

        {#if sourceLink}
          <a class="source-url" href={sourceLink} target="_blank" rel="noreferrer">
            <ExternalLink size={14} strokeWidth={2.3} aria-hidden="true" />
            <span>{sourceLink}</span>
          </a>
        {:else}
          <p class="source-url missing">No careers-board address saved yet.</p>
        {/if}

        <dl class="source-facts">
          <div>
            <dt>Health</dt>
            <dd class:attention={healthLabel(source) === 'Needs attention'}>{healthLabel(source)}</dd>
            <small>{healthDetail(source)}</small>
          </div>
          <div>
            <dt>Last pull</dt>
            <dd>{lastPull(source)}</dd>
          </div>
        </dl>

        <div class="source-actions" aria-label={`Actions for ${sourceName(source)}`}>
          <button
            type="button"
            class="secondary"
            disabled={Boolean(sourcePending)}
            onclick={() => void changeActive(source)}
          >
            {#if sourceActive}
              <CircleX size={15} strokeWidth={2.3} aria-hidden="true" />
              <span>{sourcePending === 'deactivate' ? 'Deactivating…' : 'Deactivate'}</span>
            {:else}
              <CircleCheck size={15} strokeWidth={2.3} aria-hidden="true" />
              <span>{sourcePending === 'activate' ? 'Starting…' : 'Activate'}</span>
            {/if}
          </button>
          <button
            type="button"
            class="primary"
            disabled={Boolean(sourcePending) || !sourceActive}
            title={sourceActive ? 'Pull up to 25 current listings' : 'Activate this source before pulling listings'}
            onclick={() => void pullNow(source)}
          >
            {#if sourcePending === 'crawl'}
              <span class="spinning"><RefreshCw size={15} strokeWidth={2.3} aria-hidden="true" /></span>
              <span>Starting pull…</span>
            {:else}
              <Play size={15} strokeWidth={2.3} aria-hidden="true" />
              <span>Pull now</span>
            {/if}
          </button>
          <a class="secondary" href={`/admin/sources/${encodeURIComponent(id)}/edit`}>
            <Pencil size={15} strokeWidth={2.3} aria-hidden="true" />
            <span>Edit</span>
          </a>
          <a class="secondary" href="/admin/opportunities">
            <span>View opportunities</span>
          </a>
        </div>

        {#if feedbackBySourceId[id]}
          <p class:source-feedback-error={feedbackToneBySourceId[id] === 'error'} class="source-feedback" role={feedbackToneBySourceId[id] === 'error' ? 'alert' : 'status'}>
            {feedbackBySourceId[id]}
          </p>
        {/if}

        {#if queuedCrawl?.crawlId}
          <SourceCrawlProgress
            sourceId={id}
            crawlId={queuedCrawl.crawlId}
            onPullAgain={() => void pullAgain(source)}
            onViewOpportunities={() => {
              window.location.href = '/admin/opportunities';
            }}
            onTerminal={() => {
              void refreshHealth();
              onRefresh();
            }}
          />
        {/if}
      </article>
    {:else}
      <div class="source-empty">
        <h3>{activeFilter === 'all' ? 'Start with a job source' : `No ${activeFilter} job sources`}</h3>
        <p>{activeFilter === 'all' ? 'Add a careers page or job board from the header, then Iolaus can pull the listings you want to review.' : 'Try another status in Filters.'}</p>
      </div>
    {/each}
  </div>
</section>

<style>
  .source-controls {
    display: grid;
    gap: 18px;
  }

  .source-card header,
  .source-actions,
  .source-facts,
  .source-url {
    display: flex;
    gap: 12px;
  }

  .source-card header {
    align-items: start;
    justify-content: space-between;
  }

  .source-controls h3,
  .source-controls p {
    margin: 0;
  }

  .source-provider,
  .source-url,
  .source-facts small,
  .source-empty p {
    color: var(--smrt-color-on-surface-variant);
  }

  .source-card-list {
    display: grid;
    gap: 14px;
  }

  .source-card,
  .source-empty {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 14px;
    background: var(--smrt-color-surface);
    padding: 18px;
  }

  .source-card.inactive {
    opacity: 0.76;
  }

  .source-card h3 {
    font-size: 1.05rem;
  }

  .source-provider {
    font-size: 0.88rem;
    margin-top: 3px !important;
  }

  .source-state {
    border-radius: 999px;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.8rem;
    font-weight: 700;
    padding: 4px 9px;
  }

  .source-state.active {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .source-url {
    align-items: center;
    margin-top: 14px;
    max-width: max-content;
    overflow-wrap: anywhere;
  }

  .source-url:not(.missing) {
    color: var(--smrt-color-primary);
    font-weight: 650;
    text-decoration: none;
  }

  .source-url:not(.missing):hover,
  .source-url:not(.missing):focus-visible {
    text-decoration: underline;
  }

  .source-facts {
    flex-wrap: wrap;
    margin: 16px 0;
  }

  .source-facts div {
    min-width: min(100%, 210px);
  }

  .source-facts dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.8rem;
    font-weight: 700;
  }

  .source-facts dd {
    font-weight: 700;
    margin: 2px 0;
  }

  .source-facts dd.attention {
    color: var(--smrt-color-on-warning-container);
  }

  .source-actions {
    align-items: center;
    flex-wrap: wrap;
  }

  .source-actions button,
  .source-actions a,
  .source-health-error button {
    align-items: center;
    border-radius: 8px;
    display: inline-flex;
    font: inherit;
    font-weight: 700;
    gap: 7px;
    justify-content: center;
    padding: 8px 11px;
    text-decoration: none;
  }

  .source-actions button,
  .source-actions a {
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .source-actions button {
    cursor: pointer;
  }

  .source-actions .primary {
    background: var(--smrt-color-on-surface);
    border-color: var(--smrt-color-on-surface);
    color: var(--smrt-color-surface);
  }

  .source-actions .secondary {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  .source-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.58;
  }

  .source-feedback,
  .source-health-error {
    color: var(--smrt-color-on-success-container);
    font-size: 0.9rem;
    margin-top: 12px !important;
  }

  .source-feedback.source-feedback-error,
  .source-health-error {
    color: var(--smrt-color-error);
  }

  .source-health-error button {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }

  .source-empty {
    display: grid;
    gap: 10px;
    justify-items: start;
    text-align: left;
  }

  .spinning {
    animation: source-spin 0.9s linear infinite;
  }

  @keyframes source-spin {
    to { transform: rotate(360deg); }
  }

</style>
