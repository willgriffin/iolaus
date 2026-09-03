<script lang="ts">
import ArrowRight from '@lucide/svelte/icons/arrow-right';
import Briefcase from '@lucide/svelte/icons/briefcase';
import Building2 from '@lucide/svelte/icons/building-2';
import ClipboardCheck from '@lucide/svelte/icons/clipboard-check';
import { goto } from '$app/navigation';
import type { AdminRecord } from '$lib/admin/dock';

let {
  records,
  loading = false,
  refreshing = false,
  stale = false,
  error = null,
  onRetry,
} = $props<{
  records: AdminRecord[];
  loading?: boolean;
  refreshing?: boolean;
  stale?: boolean;
  error?: string | null;
  onRetry?: () => void;
}>();

// The journey shown as a tracker. Each application status maps onto one of
// these stages; terminal/branch states render as a plain chip instead.
const STAGES = [
  { key: 'drafting', label: 'Drafting' },
  { key: 'review', label: 'Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'submitting', label: 'Submitting' },
  { key: 'submitted', label: 'Submitted' },
] as const;

const STATUS_TO_STAGE: Record<string, (typeof STAGES)[number]['key']> = {
  draft: 'drafting',
  application_drafting: 'drafting',
  awaiting_user: 'review',
  approved: 'approved',
  submitting: 'submitting',
  manual_submission: 'submitting',
  submitted: 'submitted',
};

// Statuses that sit off the linear track — show them as a standalone chip.
const TERMINAL_LABELS: Record<string, string> = {
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  archived: 'Archived',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stageIndex(status: string): number {
  const stage = STATUS_TO_STAGE[status];
  return stage ? STAGES.findIndex((entry) => entry.key === stage) : -1;
}

// The packet is generated and waiting on the user — surface Review prominently.
function isReviewReady(status: string): boolean {
  return status === 'awaiting_user';
}

function eventTargetIsNestedControl(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest('a,button,input,select,textarea'))
    : false;
}

function openApplication(event: MouseEvent, href: string): void {
  if (eventTargetIsNestedControl(event.target)) return;
  void goto(href);
}

function handleApplicationKeydown(event: KeyboardEvent, href: string): void {
  if (eventTargetIsNestedControl(event.target)) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;

  event.preventDefault();
  void goto(href);
}

const cards = $derived(
  (records as AdminRecord[]).map((record) => {
    const id = str(record.id);
    const status = str(record.status);
    return {
      id,
      status,
      title: str(record.opportunityTitle) || 'Untitled opportunity',
      company: str(record.companyName),
      opportunityHref: str(record.opportunityHref),
      terminalLabel: TERMINAL_LABELS[status] ?? '',
      reviewReady: isReviewReady(status),
      activeStage: stageIndex(status),
      href: `/admin/applications/${encodeURIComponent(id)}`,
    };
  }),
);
</script>

<div class="application-list">
  {#if error}
    <div class="empty" role="alert">
      <p>{error}</p>
      {#if onRetry}
        <button type="button" onclick={onRetry}>Try again</button>
      {/if}
    </div>
  {/if}

  {#if refreshing || stale}
    <p class="empty" role="status">Refreshing applications…</p>
  {/if}

  {#if loading && cards.length === 0}
    <p class="empty" role="status">Loading applications…</p>
  {:else if !error && cards.length === 0}
    <p class="empty">No applications yet. Apply to an opportunity to start one.</p>
  {/if}

  {#each cards as card (card.id)}
    <div
      class="card"
      class:review-ready={card.reviewReady}
      role="link"
      tabindex="0"
      aria-label={`Open application for ${card.title}`}
      onclick={(event) => openApplication(event, card.href)}
      onkeydown={(event) => handleApplicationKeydown(event, card.href)}
    >
      <div class="head">
        <h2 class="title">
          {#if card.opportunityHref}
            <a href={card.opportunityHref} target="_blank" rel="noreferrer noopener">{card.title}</a>
          {:else}
            {card.title}
          {/if}
        </h2>
        {#if card.company}
          <span class="company"><Building2 size={13} strokeWidth={2.2} />{card.company}</span>
        {/if}
      </div>

      <div class="track-row">
        {#if card.terminalLabel}
          <span class="terminal-chip status-{card.status}">{card.terminalLabel}</span>
        {:else if card.activeStage >= 0}
          <ol class="track" aria-label="Application stage">
            {#each STAGES as stage, index}
              <li
                class:done={index < card.activeStage}
                class:current={index === card.activeStage}
              >
                <span class="dot"></span>
                <span class="step-label">{stage.label}</span>
              </li>
            {/each}
          </ol>
        {:else}
          <span class="terminal-chip status-{card.status}">{card.status || 'Unknown'}</span>
        {/if}
      </div>

      <div class="actions">
        {#if card.reviewReady}
          <a class="action primary" href={card.href}>
            <ClipboardCheck size={15} strokeWidth={2.2} />
            Review
          </a>
        {:else}
          <a class="action" href={card.href}>
            <Briefcase size={15} strokeWidth={2.2} />
            Open <ArrowRight size={14} strokeWidth={2.2} />
          </a>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .application-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .empty {
    color: var(--smrt-color-on-surface-variant);
    padding: 24px 4px;
  }

  .card {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 2fr) auto;
    align-items: center;
    gap: 16px;
    padding: 14px 16px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 10px;
    background: var(--smrt-color-surface);
  }

  .card.review-ready {
    border-color: var(--smrt-color-primary);
    box-shadow: inset 3px 0 0 0 var(--smrt-color-primary);
  }

  .head {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .title {
    margin: 0;
    font-size: 0.98rem;
    font-weight: 700;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title a {
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }

  .title a:hover {
    text-decoration: underline;
  }

  .company {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.82rem;
  }

  .track {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 0;
  }

  .track li {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }

  .track li::before {
    content: '';
    position: absolute;
    top: 5px;
    left: -50%;
    width: 100%;
    height: 2px;
    background: var(--smrt-color-outline-variant);
  }

  .track li:first-child::before {
    display: none;
  }

  .track li.done::before,
  .track li.current::before {
    background: var(--smrt-color-primary);
  }

  .dot {
    position: relative;
    z-index: 1;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--smrt-color-surface);
    border: 2px solid var(--smrt-color-outline-variant);
  }

  .track li.done .dot {
    background: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
  }

  .track li.current .dot {
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary) 25%, transparent);
  }

  .step-label {
    font-size: 0.68rem;
    color: var(--smrt-color-on-surface-variant);
    white-space: nowrap;
  }

  .track li.current .step-label {
    color: var(--smrt-color-on-surface);
    font-weight: 700;
  }

  .terminal-chip {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 0.76rem;
    font-weight: 700;
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }

  .terminal-chip.status-offer {
    background: var(--smrt-color-success);
    color: var(--smrt-color-on-success);
  }

  .terminal-chip.status-rejected {
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-self: end;
  }

  .action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 13px;
    border-radius: 7px;
    border: 1px solid var(--smrt-color-outline-variant);
    font-size: 0.83rem;
    font-weight: 700;
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    white-space: nowrap;
  }

  .action.primary {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .action.subtle {
    border-color: transparent;
    color: var(--smrt-color-on-surface-variant);
    padding: 7px 6px;
  }

  .action:hover {
    border-color: var(--smrt-color-primary);
  }

  @media (max-width: 720px) {
    .card {
      grid-template-columns: 1fr;
      gap: 12px;
    }
    .actions {
      justify-self: start;
    }
  }
</style>
