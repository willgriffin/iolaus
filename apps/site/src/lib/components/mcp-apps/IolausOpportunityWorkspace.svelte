<script lang="ts">
import type { McpAppBridge, ToolResult } from '@happyvertical/smrt-mcp-apps';
import { useMcpApp } from '@happyvertical/smrt-svelte/mcp-apps';

type RecordValue = Record<string, unknown>;

type Opportunity = {
  applicationId: string | null;
  company: string;
  id: string;
  recommendation: string;
  score: number | null;
  summary: string;
  title: string;
};

type ApplicationWorkspace = {
  id: string;
  reviewUrl: string;
  status: string;
};

let {
  hostOrigin,
  hostWindow,
  iolausOrigin,
}: {
  /** Exact, trusted immediate MCP host origin. */
  hostOrigin: string;
  /** Supplied only by the trusted embedding runtime; defaults to window.parent. */
  hostWindow?: Window;
  /** Optional exact HTTPS origin for opening the authenticated Iolaus review UI. */
  iolausOrigin?: string;
} = $props();

const app = useMcpApp(() => ({
  appInfo: { name: 'Iolaus opportunity workspace', version: '1.0.0' },
  availableDisplayModes: ['inline', 'fullscreen'],
  hostOrigin,
  hostWindow: hostWindow ?? window.parent,
}));

let board = $state<Opportunity[]>([]);
let boardLoaded = $state(false);
let busy = $state('');
let detail = $state<Opportunity | null>(null);
let errorMessage = $state('');
let workspace = $state<ApplicationWorkspace | null>(null);
let handledHostResult = $state<ToolResult | null>(null);

const canCallTools = $derived(
  Boolean(app.snapshot?.hostCapabilities.serverTools),
);
const canOpenLinks = $derived(
  Boolean(app.snapshot?.hostCapabilities.openLinks),
);
const ready = $derived(app.snapshot?.state === 'ready');

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function structured(result: ToolResult): RecordValue | null {
  if (result.structuredContent) return result.structuredContent;
  const first = result.content.find((content) => content.type === 'text');
  if (!first) return null;
  try {
    return record(JSON.parse(first.text));
  } catch {
    return null;
  }
}

function opportunity(value: unknown): Opportunity | null {
  const candidate = record(value);
  const id = text(candidate?.id).trim();
  if (!candidate || !id) return null;
  const application = record(candidate.application);
  return {
    applicationId: text(application?.id).trim() || null,
    company: text(candidate.company, 'Unknown company'),
    id,
    recommendation: text(candidate.recommendation, 'Unreviewed'),
    score: number(candidate.score),
    summary: text(candidate.summary),
    title: text(candidate.title, 'Untitled opportunity'),
  };
}

function reviewPath(value: unknown): string {
  const path = text(value).trim();
  return /^\/admin\/applications\/[A-Za-z0-9_-]{1,128}\/review$/u.test(path)
    ? path
    : '';
}

function applicationWorkspace(value: unknown): ApplicationWorkspace | null {
  const candidate = record(value);
  const application = record(candidate?.application) ?? candidate;
  const id = text(application?.id).trim();
  const reviewUrl = reviewPath(application?.reviewUrl);
  if (!id || !reviewUrl) return null;
  return { id, reviewUrl, status: text(application?.status, 'in progress') };
}

function applyResult(result: ToolResult) {
  if (result.isError) {
    errorMessage = text(
      result.content[0]?.text,
      'Iolaus could not complete that request.',
    );
    return;
  }
  const data = structured(result);
  if (!data) {
    errorMessage = 'Iolaus returned an unreadable workspace result.';
    return;
  }
  if (Array.isArray(data.items)) {
    board = data.items
      .map(opportunity)
      .filter((item): item is Opportunity => item !== null);
    boardLoaded = true;
  }
  const inspected = opportunity(data);
  if (inspected) detail = inspected;
  const nextWorkspace = applicationWorkspace(data);
  if (nextWorkspace) workspace = nextWorkspace;
}

async function call(bridge: McpAppBridge, name: string, args: RecordValue) {
  errorMessage = '';
  const result = await bridge.callTool(name, args, bridge.signal);
  applyResult(result);
  return result;
}

async function loadBoard() {
  const bridge = app.bridge;
  if (!bridge || !canCallTools || busy) return;
  busy = 'board';
  try {
    await call(bridge, 'job_search_browse_opportunities', {});
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? error.message
        : 'Iolaus could not load opportunities.';
  } finally {
    busy = '';
  }
}

async function inspect(item: Opportunity) {
  const bridge = app.bridge;
  if (!bridge || !canCallTools || busy) return;
  busy = `inspect:${item.id}`;
  try {
    await call(bridge, 'job_search_inspect_opportunity', {
      opportunityId: item.id,
    });
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? error.message
        : 'Iolaus could not inspect this opportunity.';
  } finally {
    busy = '';
  }
}

async function prepare(item: Opportunity) {
  const bridge = app.bridge;
  if (!bridge || !canCallTools || busy) return;
  busy = `prepare:${item.id}`;
  try {
    const result = await call(bridge, 'job_search_open_application', {
      opportunityId: item.id,
    });
    const created = applicationWorkspace(result.structuredContent ?? {});
    const application = record(result.structuredContent)?.application;
    const applicationId = text(record(application)?.id).trim();
    if (created) return;
    if (applicationId) {
      await call(bridge, 'job_search_inspect_application', { applicationId });
    }
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? error.message
        : 'Iolaus could not prepare this workspace.';
  } finally {
    busy = '';
  }
}

function trustedReviewUrl(path: string): string | null {
  if (!iolausOrigin) return null;
  try {
    const origin = new URL(iolausOrigin);
    if (origin.origin !== iolausOrigin || origin.protocol !== 'https:')
      return null;
    return new URL(path, origin).href;
  } catch {
    return null;
  }
}

async function openHumanReview(event: MouseEvent) {
  const bridge = app.bridge;
  const current = workspace;
  const destination = current ? trustedReviewUrl(current.reviewUrl) : null;
  if (!bridge || !current || !destination || !canCallTools || !canOpenLinks)
    return;
  event.preventDefault();
  busy = 'review';
  try {
    const result = await call(bridge, 'iolaus_open_human_review', {
      url: current.reviewUrl,
    });
    const verifiedPath = reviewPath(structured(result)?.humanReviewUrl);
    if (!verifiedPath)
      throw new Error('Iolaus did not return a dedicated review URL.');
    const verifiedDestination = trustedReviewUrl(verifiedPath);
    if (!verifiedDestination)
      throw new Error('The configured review origin is unavailable.');
    await bridge.openLink(verifiedDestination, bridge.signal);
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? error.message
        : 'Iolaus could not open the review workspace.';
  } finally {
    busy = '';
  }
}

$effect(() => {
  const result = app.snapshot?.toolResult;
  if (!result || result === handledHostResult) return;
  handledHostResult = result;
  applyResult(result);
});

$effect(() => {
  if (ready && canCallTools && !boardLoaded && !busy) void loadBoard();
});
</script>

<section aria-label="Iolaus opportunity workspace" class="iolaus-workspace">
  <header>
    <p class="eyebrow">Iolaus</p>
    <h1>Opportunity workspace</h1>
    <p>Browse your own opportunity board, then prepare a local workspace for human review.</p>
  </header>

  {#if app.error}
    <p class="notice" role="status">The MCP host is unavailable: {app.error}</p>
  {:else if !ready}
    <p class="notice" role="status">Connecting to the MCP host…</p>
  {:else if !canCallTools}
    <p class="notice" role="status">This host cannot call Iolaus tools. Ask it to show the structured opportunity result, then use the authenticated Iolaus review page.</p>
  {:else}
    <div class="toolbar">
      <p>{boardLoaded ? `${board.length} opportunities available` : 'Loading opportunities…'}</p>
      <button disabled={Boolean(busy)} onclick={loadBoard} type="button">Refresh board</button>
    </div>
    {#if errorMessage}
      <p class="notice error" role="alert">{errorMessage}</p>
    {/if}
    {#if boardLoaded && board.length === 0}
      <p class="notice">No opportunities match the current board.</p>
    {/if}
    <ol class="opportunities">
      {#each board as item (item.id)}
        <li>
          <article>
            <p class="company">{item.company}</p>
            <h2>{item.title}</h2>
            {#if item.summary}<p>{item.summary}</p>{/if}
            <p class="metadata">{item.score === null ? 'Unscored' : `${item.score}/100`} · {item.recommendation}</p>
            <div class="actions">
              <button disabled={Boolean(busy)} onclick={() => inspect(item)} type="button">Inspect</button>
              <button disabled={Boolean(busy)} onclick={() => prepare(item)} type="button">Prepare workspace</button>
            </div>
          </article>
        </li>
      {/each}
    </ol>
  {/if}

  {#if detail}
    <aside aria-live="polite" class="detail">
      <h2>{detail.title}</h2>
      <p>{detail.company}</p>
      <p>{detail.summary || 'No summary is available for this opportunity.'}</p>
    </aside>
  {/if}

  {#if workspace}
    <aside aria-live="polite" class="review">
      <h2>Human review required</h2>
      <p>This application workspace is {workspace.status}. Iolaus cannot approve or submit it.</p>
      <a href={workspace.reviewUrl} onclick={openHumanReview}>Open dedicated review</a>
    </aside>
  {/if}
</section>

<style>
  .iolaus-workspace { color: #182230; font: 16px/1.5 system-ui, sans-serif; max-width: 52rem; padding: 1rem; }
  h1, h2, p { margin: 0; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; }
  header, article, .detail, .review { display: grid; gap: .45rem; }
  .eyebrow { color: #476582; font-size: .8rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .toolbar, .actions { align-items: center; display: flex; flex-wrap: wrap; gap: .6rem; justify-content: space-between; }
  button, a { border-radius: .35rem; font: inherit; padding: .38rem .65rem; }
  button { background: #173f5f; border: 1px solid #173f5f; color: white; cursor: pointer; }
  button:disabled { cursor: wait; opacity: .55; }
  .opportunities { display: grid; gap: .75rem; list-style: none; margin: 1rem 0; padding: 0; }
  article, .detail, .review, .notice { border: 1px solid #d5dde5; border-radius: .5rem; padding: .85rem; }
  .company, .metadata { color: #52606d; font-size: .9rem; }
  .detail, .review { margin-top: 1rem; } .review { border-color: #c89022; }
  .notice { margin-top: 1rem; } .error { border-color: #b3261e; color: #8d1711; }
</style>
