<script lang="ts">
import { onMount } from 'svelte';
import {
  crawlElapsedLabel,
  crawlStateLabel,
  createCrawlStatusPoller,
  isTerminalCrawlStatus,
  readCrawlStatusResponse,
  type SourceCrawlStatus,
} from './source-crawl-progress.js';

let {
  crawlId,
  onPullAgain = () => undefined,
  onTerminal = () => undefined,
  onViewOpportunities = () => undefined,
  sourceId,
}: {
  crawlId: string;
  onPullAgain?: (sourceId: string) => void;
  onTerminal?: (status: SourceCrawlStatus) => void;
  onViewOpportunities?: (sourceId: string) => void;
  sourceId: string;
} = $props();

let progress = $state<SourceCrawlStatus | null>(null);
let feedback = $state('');
let mounted = false;

function statusUrl(id: string): string {
  const query = new URLSearchParams({ crawlId: id, limit: '1' });
  return `/api/job-search/source-crawl-status?${query.toString()}`;
}

async function loadStatus(): Promise<SourceCrawlStatus | null> {
  const response = await fetch(statusUrl(crawlId), {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('status unavailable');
  const payload: unknown = await response.json().catch(() => null);
  const status = readCrawlStatusResponse(payload, crawlId);
  return status?.sourceId === sourceId ? status : null;
}

$effect(() => {
  if (!mounted || !crawlId || !sourceId) return;
  progress = null;
  feedback = '';
  const poller = createCrawlStatusPoller({
    load: loadStatus,
    onMissing: () => {
      feedback =
        'We could not find that pull anymore. You can start another one.';
    },
    onStatus: (status) => {
      progress = status;
    },
    onTerminal,
    onUnavailable: () => {
      feedback = 'We could not refresh pull progress. Try again in a moment.';
    },
  });
  poller.start();
  return () => poller.stop();
});

onMount(() => {
  mounted = true;
  return () => {
    mounted = false;
  };
});

const terminal = $derived(
  progress ? isTerminalCrawlStatus(progress.status) : false,
);
const elapsed = $derived(
  progress ? crawlElapsedLabel(progress.startedAt, progress.finishedAt) : '',
);
</script>

<section class="crawl-progress" aria-live="polite" aria-label="Pull progress" data-crawl-id={crawlId}>
  {#if progress}
    <div class="crawl-progress-heading">
      <p class:failed={progress.status === 'failed' || progress.status === 'timed_out'} class="crawl-state">
        {crawlStateLabel(progress.status)}
      </p>
      <span>{elapsed}</span>
    </div>

    <dl class="crawl-counts">
      <div><dt>Found</dt><dd>{progress.counts.candidates}</dd></div>
      <div><dt>Imported</dt><dd>{progress.counts.created}</dd></div>
      <div><dt>Skipped</dt><dd>{progress.counts.skipped}</dd></div>
      <div><dt>Needs attention</dt><dd>{progress.counts.errors}</dd></div>
    </dl>

    {#if progress.errors.length}
      <ul class="crawl-errors" aria-label="Pull details">
        {#each progress.errors as message}
          <li>{message}</li>
        {/each}
      </ul>
    {/if}

    {#if terminal}
      <div class="crawl-complete-actions">
        <button type="button" class="secondary" onclick={() => onViewOpportunities(sourceId)}>
          View opportunities
        </button>
        <button type="button" class="secondary" onclick={() => onPullAgain(sourceId)}>
          Pull again
        </button>
      </div>
    {/if}
  {:else if !feedback}
    <p class="crawl-state">Checking pull progress…</p>
  {/if}

  {#if feedback}
    <p class="crawl-feedback" role="status">{feedback}</p>
    <button type="button" class="secondary" onclick={() => onPullAgain(sourceId)}>
      Pull again
    </button>
  {/if}
</section>

<style>
  .crawl-progress {
    border-top: 1px solid var(--smrt-color-border, #d8dee9);
    display: grid;
    gap: 12px;
    margin-top: 16px;
    padding-top: 16px;
  }

  .crawl-progress-heading,
  .crawl-complete-actions,
  .crawl-counts {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .crawl-progress-heading {
    justify-content: space-between;
  }

  .crawl-state,
  .crawl-feedback {
    font-weight: 650;
    margin: 0;
  }

  .crawl-progress-heading span,
  .crawl-errors {
    color: var(--smrt-color-text-muted, #64748b);
    font-size: 0.88rem;
  }

  .crawl-state.failed {
    color: #b42318;
  }

  .crawl-counts {
    margin: 0;
  }

  .crawl-counts div {
    min-width: 74px;
  }

  .crawl-counts dt {
    color: var(--smrt-color-text-muted, #64748b);
    font-size: 0.76rem;
    font-weight: 700;
  }

  .crawl-counts dd {
    font-weight: 750;
    margin: 2px 0 0;
  }

  .crawl-errors {
    display: grid;
    gap: 4px;
    margin: 0;
    padding-left: 18px;
  }

  .secondary {
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-border, #cbd5e1);
    border-radius: 8px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    padding: 7px 10px;
  }

  .secondary:hover,
  .secondary:focus-visible {
    border-color: var(--smrt-color-primary, #2563eb);
  }
</style>
