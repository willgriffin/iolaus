<script lang="ts">
import BadgeCheck from '@lucide/svelte/icons/badge-check';
import Banknote from '@lucide/svelte/icons/banknote';
import Bot from '@lucide/svelte/icons/bot';
import BriefcaseBusiness from '@lucide/svelte/icons/briefcase-business';
import CalendarDays from '@lucide/svelte/icons/calendar-days';
import ChevronUp from '@lucide/svelte/icons/chevron-up';
import ExternalLink from '@lucide/svelte/icons/external-link';
import LinkIcon from '@lucide/svelte/icons/link';
import ListChecks from '@lucide/svelte/icons/list-checks';
import Plane from '@lucide/svelte/icons/plane';
import RotateCw from '@lucide/svelte/icons/rotate-cw';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import Sparkles from '@lucide/svelte/icons/sparkles';
import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
import { enhance } from '$app/forms';
import type { AdminRecord } from '$lib/admin/dock';
import {
  type AdminResource,
  displayFieldLabel,
  type ReferenceOption,
  type ReferenceOptionsByField,
  type ResourceField,
} from '$lib/admin/resources';

let { onCollapse, record, referenceOptions, resource } = $props<{
  onCollapse?: () => void;
  record: AdminRecord;
  referenceOptions: ReferenceOptionsByField;
  resource: AdminResource;
}>();

const opportunityRoleDetailKeys = [
  'employmentType',
  'seniority',
  'freshness',
  'locationNotes',
  'greenfieldSignal',
  'founderSignal',
] as const;
const opportunityCompensationDetailKeys = [
  'salaryMin',
  'salaryMax',
  'currency',
  'hourlyMin',
  'hourlyMax',
  'equityMinPercent',
  'equityMaxPercent',
  'compNotes',
] as const;
const opportunityTimelineDetailKeys = [
  'postedAt',
  'expiresAt',
  'firstSeenAt',
  'lastSeenAt',
  'reviewedAt',
  'updated_at',
] as const;
const humanizedDetailKeys = new Set([
  'employmentType',
  'freshness',
  'humanReviewStatus',
  'seniority',
  'status',
  'workMode',
]);
const booleanDetailKeys = new Set([
  'founderSignal',
  'greenfieldSignal',
  'relocationSupported',
  'visaOrEorPossible',
]);

type EvidenceEntry = {
  requirement?: string;
  sources?: Array<{ excerpt?: string; kind?: string; title?: string }>;
  status?: string;
};
type AgentRunEntry = {
  error?: string;
  finishedAt?: string;
  runType?: string;
  status?: string;
};

let detailLoadState = $state<'idle' | 'loading' | 'loaded' | 'error'>('idle');
let detailLoadMessage = $state('');
let selectedDetailOpportunityId = $state('');

const selectedOpportunityHref = $derived(
  record.id ? `/admin/opportunities/${encodeURIComponent(record.id)}` : '',
);
const selectedOpportunityCompanyLabel = $derived(
  valueFor('companyId')
    ? (referenceLabelForField('companyId', valueFor('companyId')) ??
        'Unknown company')
    : 'Unknown company',
);

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

function arrayValue<T>(key: string): T[] {
  const value = record[key];
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function stringListFor(key: string): string[] {
  return arrayValue<unknown>(key).map(stringifyValue).filter(Boolean);
}

function evidenceEntries(): EvidenceEntry[] {
  return arrayValue<EvidenceEntry>('evidenceMatrix').filter((entry) =>
    Boolean(entry?.requirement),
  );
}

function agentRunEntries(): AgentRunEntry[] {
  return arrayValue<AgentRunEntry>('agentRuns').filter((entry) =>
    Boolean(entry?.runType),
  );
}

function valueFor(key: string): string {
  return stringifyValue(record[key]);
}

function referenceLabelForField(field: string, id: string): string | null {
  return (
    referenceOptions?.[field]?.find(
      (option: ReferenceOption) => option.value === id,
    )?.label ?? null
  );
}

function labelFor(key: string): string {
  const field = resource.fields.find((item: ResourceField) => item.key === key);
  if (field) return displayFieldLabel(field);
  return key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function displayDate(value: unknown): string {
  const text = stringifyValue(value);
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function isDateDetailKey(key: string): boolean {
  return key === 'created_at' || key === 'updated_at' || key.endsWith('At');
}

function booleanStateFor(key: string): 'yes' | 'no' | 'unknown' {
  const text = valueFor(key).trim().toLowerCase();
  if (!text) return 'unknown';
  if (['1', 'true', 'yes', 'y'].includes(text)) return 'yes';
  if (['0', 'false', 'no', 'n'].includes(text)) return 'no';
  return 'unknown';
}

function booleanLabelFor(key: string): string {
  const state = booleanStateFor(key);
  if (state === 'unknown') return 'Unavailable';
  return state === 'yes' ? 'Yes' : 'No';
}

function booleanToneFor(key: string): string {
  const state = booleanStateFor(key);
  if (state === 'yes') return 'tone-positive';
  if (state === 'no') return 'tone-negative';
  return 'tone-muted';
}

function statusToneFor(value: unknown): string {
  const text = stringifyValue(value).trim().toLowerCase();
  if (!text || text === 'unknown') return 'tone-muted';
  if (
    ['apply', 'applied', 'interviewing', 'offer', 'recommended'].includes(text)
  ) {
    return 'tone-positive';
  }
  if (['found', 'maybe', 'needs_input'].includes(text)) return 'tone-amber';
  if (['archived', 'closed', 'reject', 'rejected'].includes(text))
    return 'tone-negative';
  return 'tone-neutral';
}

function recommendationToneFor(value: unknown): string {
  const text = stringifyValue(value).trim().toLowerCase();
  if (text === 'recommend') return 'tone-positive';
  if (text === 'maybe' || text === 'needs_research') return 'tone-amber';
  if (text === 'reject' || text === 'skip') return 'tone-negative';
  if (!text || text === 'unknown') return 'tone-muted';
  return 'tone-neutral';
}

function latestScoreLabel(): string {
  const score = valueFor('latestScore');
  const recommendation = humanize(valueFor('latestRecommendation'), '');
  if (!score && !recommendation) return 'Unscored';
  return [score ? `${score}/100` : '', recommendation]
    .filter(Boolean)
    .join(' / ');
}

function workModeToneFor(value: unknown): string {
  const text = stringifyValue(value).trim().toLowerCase();
  if (text === 'remote') return 'tone-positive';
  if (text === 'hybrid') return 'tone-amber';
  if (text === 'onsite') return 'tone-negative';
  if (!text || text === 'unknown') return 'tone-muted';
  return 'tone-neutral';
}

function humanize(value: unknown, fallback = 'None'): string {
  const text = stringifyValue(value).trim();
  if (!text) return fallback;
  return text.replaceAll('_', ' ').replace(/\bwill\b/gi, 'user');
}

function displayDetailValue(key: string): string {
  const value = valueFor(key);
  if (!value) return '';
  if (isDateDetailKey(key)) return displayDate(value);
  if (booleanDetailKeys.has(key)) return booleanLabelFor(key);
  if (humanizedDetailKeys.has(key)) return humanize(value, '');
  return value;
}

function evidenceStatusLabel(status: unknown): string {
  return stringifyValue(status) === 'supported' ? 'Supported' : 'Gap';
}

function evidenceStatusTone(status: unknown): string {
  return stringifyValue(status) === 'supported'
    ? 'tone-positive'
    : 'tone-amber';
}

function hasAnyDetailValue(keys: readonly string[]): boolean {
  return keys.some((key) => Boolean(valueFor(key)));
}

function openPostingInNewTab(event: MouseEvent, url: string): void {
  event.preventDefault();
  event.stopPropagation();
  window.open(url, '_blank', 'noopener,noreferrer');
}

function enhanceOpportunityDetailsLoad() {
  return async ({
    result,
    update,
  }: {
    result: { data?: { message?: string; status?: string }; type: string };
    update: (options: {
      invalidateAll?: boolean;
      reset?: boolean;
    }) => Promise<void>;
  }) => {
    if (result.type === 'success') {
      await update({ invalidateAll: true, reset: false });
      const status = result.data?.status;
      detailLoadState = status === 'resolved' ? 'loaded' : 'error';
      detailLoadMessage = result.data?.message ?? '';
      return;
    }
    detailLoadState = 'error';
    detailLoadMessage =
      result.data?.message ?? 'Could not load posting details.';
  };
}

$effect(() => {
  const nextId = String(record.id ?? '');
  if (nextId === selectedDetailOpportunityId) return;
  selectedDetailOpportunityId = nextId;
  detailLoadState = 'idle';
  detailLoadMessage = '';
});
</script>

<section class="opportunity-review-panel">
  <header class="opportunity-review-header">
    <div class="opportunity-review-title">
      <a href={selectedOpportunityHref}>{valueFor('title') || 'Untitled opportunity'}</a>
      <p>{selectedOpportunityCompanyLabel}</p>
    </div>
    <div class="detail-actions icon-actions" aria-label="Opportunity actions">
      {#if onCollapse}
        <button
          type="button"
          class="posting-link icon-only"
          title="Collapse review drawer"
          aria-label="Collapse review drawer"
          onclick={(event) => {
            event.stopPropagation();
            onCollapse?.();
          }}
        >
          <ChevronUp size={14} strokeWidth={2.2} />
        </button>
      {/if}
      <form
        method="POST"
        action="?/loadOpportunityDetails"
        class="detail-load-form"
        use:enhance={enhanceOpportunityDetailsLoad}
        onsubmit={() => {
          detailLoadState = 'loading';
          detailLoadMessage = '';
        }}
      >
        <input type="hidden" name="opportunityId" value={record.id} />
        <button
          type="submit"
          class="posting-link icon-only detail-load-button"
          disabled={detailLoadState === 'loading'}
          aria-label={detailLoadState === 'loading' ? 'Loading details' : 'Load details'}
          title={detailLoadState === 'loading' ? 'Loading details' : 'Load details'}
        >
          <RotateCw size={14} strokeWidth={2.2} />
        </button>
      </form>
      {#if valueFor('postingUrl')}
        <button
          type="button"
          class="posting-link icon-only"
          title="Open posting"
          aria-label="Open posting"
          onclick={(event) => openPostingInNewTab(event, valueFor('postingUrl'))}
        >
          <LinkIcon size={14} strokeWidth={2.2} />
        </button>
      {/if}
      <a
        class="posting-link icon-only"
        href={selectedOpportunityHref}
        aria-label="Open full opportunity view"
        title="Open full opportunity view"
      >
        <ExternalLink size={14} strokeWidth={2.2} />
      </a>
    </div>
  </header>
  <div class="review-scroll">
    <section class="details-section opportunity-details">
      {#if detailLoadMessage}
        <p class={`detail-load-state ${detailLoadState}`}>{detailLoadMessage}</p>
      {/if}

      <div class="signal-grid" aria-label="Opportunity signals">
        <div class={`signal-card ${statusToneFor(valueFor('status'))}`}>
          <BadgeCheck class="signal-icon" size={16} strokeWidth={2.2} />
          <span class="signal-label">Status</span>
          <strong>{humanize(valueFor('status'), 'Unavailable')}</strong>
        </div>
        <div class={`signal-card ${recommendationToneFor(valueFor('latestRecommendation'))}`}>
          <Sparkles class="signal-icon" size={16} strokeWidth={2.2} />
          <span class="signal-label">Recommendation</span>
          <strong>{latestScoreLabel()}</strong>
        </div>
        <div class={`signal-card ${workModeToneFor(valueFor('workMode'))}`}>
          <BriefcaseBusiness class="signal-icon" size={16} strokeWidth={2.2} />
          <span class="signal-label">Work mode</span>
          <strong>{humanize(valueFor('workMode'), 'Unavailable')}</strong>
        </div>
        <div class={`signal-card ${booleanToneFor('relocationSupported')}`}>
          <Plane class="signal-icon" size={16} strokeWidth={2.2} />
          <span class="signal-label">Relocation</span>
          <strong>{booleanLabelFor('relocationSupported')}</strong>
        </div>
        <div class={`signal-card ${booleanToneFor('visaOrEorPossible')}`}>
          <ShieldCheck class="signal-icon" size={16} strokeWidth={2.2} />
          <span class="signal-label">Visa / EOR</span>
          <strong>{booleanLabelFor('visaOrEorPossible')}</strong>
        </div>
      </div>

      {#if valueFor('latestScoreSummary') || stringListFor('latestFitReasons').length > 0 || stringListFor('latestRisks').length > 0 || stringListFor('latestMissingInfo').length > 0}
        {@const fitReasons = stringListFor('latestFitReasons')}
        {@const risks = stringListFor('latestRisks')}
        {@const missingInfo = stringListFor('latestMissingInfo')}
        <div class="detail-block intelligence-block">
          <h4>
            <Sparkles size={14} strokeWidth={2.2} />
            <span>Intelligence</span>
          </h4>
          {#if valueFor('latestScoreSummary')}
            <p class="summary-text">{valueFor('latestScoreSummary')}</p>
          {/if}
          <div class="intelligence-columns">
            {#if fitReasons.length > 0}
              <div>
                <h5>Fit</h5>
                <ul>
                  {#each fitReasons as reason}
                    <li>{reason}</li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if risks.length > 0}
              <div>
                <h5>Risks</h5>
                <ul>
                  {#each risks as risk}
                    <li>{risk}</li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if missingInfo.length > 0}
              <div>
                <h5>Missing</h5>
                <ul>
                  {#each missingInfo as item}
                    <li>{item}</li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if stringListFor('latestDataQualityWarnings').length > 0}
        {@const warnings = stringListFor('latestDataQualityWarnings')}
        <div class="detail-block warning-block">
          <h4>
            <TriangleAlert size={14} strokeWidth={2.2} />
            <span>Quality warnings</span>
          </h4>
          <ul>
            {#each warnings as warning}
              <li>{warning}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if evidenceEntries().length > 0}
        {@const evidence = evidenceEntries()}
        <div class="detail-block evidence-block">
          <h4>
            <ListChecks size={14} strokeWidth={2.2} />
            <span>Evidence and gaps</span>
          </h4>
          <div class="evidence-list">
            {#each evidence as entry}
              <article class={`evidence-item ${evidenceStatusTone(entry.status)}`}>
                <header>
                  <strong>{entry.requirement}</strong>
                  <span>{evidenceStatusLabel(entry.status)}</span>
                </header>
                {#if entry.sources && entry.sources.length > 0}
                  <ul>
                    {#each entry.sources as source}
                      <li>
                        <span>{source.title || source.kind || 'Evidence'}</span>
                        {#if source.excerpt}
                          <small>{source.excerpt}</small>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p>No reviewed fact, resume skill, achievement, or company note matched this requirement.</p>
                {/if}
              </article>
            {/each}
          </div>
        </div>
      {/if}

      {#if agentRunEntries().length > 0}
        {@const runs = agentRunEntries()}
        <div class="detail-block agent-run-block">
          <h4>
            <Bot size={14} strokeWidth={2.2} />
            <span>Agent history</span>
          </h4>
          <dl class="agent-run-list">
            {#each runs as run}
              <div>
                <dt>{humanize(run.runType, 'run')}</dt>
                <dd>
                  <span>{humanize(run.status, 'unknown')}</span>
                  {#if run.finishedAt}
                    <time>{displayDate(run.finishedAt)}</time>
                  {/if}
                  {#if run.error}
                    <small>{run.error}</small>
                  {/if}
                </dd>
              </div>
            {/each}
          </dl>
        </div>
      {/if}

      <div class="detail-block">
        <h4>
          <Banknote size={14} strokeWidth={2.2} />
          <span>Compensation</span>
        </h4>
        {#if hasAnyDetailValue(opportunityCompensationDetailKeys)}
          <dl class="detail-list compact-detail-list">
            {#each opportunityCompensationDetailKeys as key}
              {@const value = displayDetailValue(key)}
              {#if value}
                <div class:wide-detail={key === 'compNotes'}>
                  <dt>{labelFor(key)}</dt>
                  <dd>{value}</dd>
                </div>
              {/if}
            {/each}
          </dl>
        {:else}
          <p class="placeholder">unavailable</p>
        {/if}
      </div>

      {#if valueFor('descriptionSummary') || valueFor('descriptionRaw')}
        <div class="detail-block">
          <h4>Captured notes</h4>
          <dl class="detail-list">
            {#if valueFor('descriptionSummary')}
              <div>
                <dt>Parsed summary</dt>
                <dd class="formatted-text">{valueFor('descriptionSummary')}</dd>
              </div>
            {/if}
            {#if valueFor('descriptionRaw')}
              <div>
                <dt>Source text</dt>
                <dd class="formatted-text">{valueFor('descriptionRaw')}</dd>
              </div>
            {/if}
          </dl>
        </div>
      {/if}

      <div class="detail-block">
        <h4>Role context</h4>
        {#if hasAnyDetailValue(opportunityRoleDetailKeys)}
          <dl class="detail-list">
            {#each opportunityRoleDetailKeys as key}
              {@const value = displayDetailValue(key)}
              {#if value}
                <div class:wide-detail={key === 'locationNotes'}>
                  <dt>{labelFor(key)}</dt>
                  <dd>{value}</dd>
                </div>
              {/if}
            {/each}
          </dl>
        {:else}
          <p class="placeholder">unavailable</p>
        {/if}
      </div>

      <div class="detail-block">
        <h4>
          <CalendarDays size={14} strokeWidth={2.2} />
          <span>Timeline</span>
        </h4>
        {#if hasAnyDetailValue(opportunityTimelineDetailKeys)}
          <dl class="detail-list compact-detail-list">
            {#each opportunityTimelineDetailKeys as key}
              {@const value = displayDetailValue(key)}
              {#if value}
                <div>
                  <dt>{labelFor(key)}</dt>
                  <dd>{value}</dd>
                </div>
              {/if}
            {/each}
          </dl>
        {:else}
          <p class="placeholder">unavailable</p>
        {/if}
      </div>
    </section>
  </div>
</section>

<style>
  .opportunity-review-panel {
    display: grid;
    gap: 14px;
    color: var(--smrt-color-on-surface);
  }

  .opportunity-review-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: start;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .opportunity-review-title {
    display: grid;
    min-width: 0;
    gap: 4px;
  }

  .opportunity-review-title a {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-large-font);
    overflow-wrap: anywhere;
    text-decoration: none;
  }

  .opportunity-review-title a:hover,
  .opportunity-review-title a:focus-visible {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  .opportunity-review-title p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 13px;
    font-weight: 800;
    line-height: 1.35;
  }

  .review-scroll {
    display: grid;
    gap: 16px;
  }

  .details-section {
    display: grid;
    gap: 14px;
  }

  .detail-actions {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }

  .detail-load-form {
    display: contents;
  }

  .posting-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 9px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-primary);
    font: inherit;
    font-size: 12px;
    font-weight: 900;
    text-decoration: none;
  }

  .posting-link.icon-only {
    justify-content: center;
    width: 30px;
    padding: 0;
  }

  .posting-link:hover:not(:disabled) {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }

  .posting-link:disabled {
    cursor: progress;
    opacity: 0.62;
  }

  .detail-load-button {
    color: var(--smrt-color-on-success-container);
  }

  .detail-load-state {
    margin: -5px 0 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    line-height: 1.4;
  }

  .detail-load-state.loaded {
    color: var(--smrt-color-on-success-container);
  }

  .detail-load-state.error {
    color: var(--smrt-color-on-warning-container);
  }

  .signal-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }

  .signal-card {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    min-width: 0;
    padding: 9px 10px;
    border: 1px solid currentColor;
    border-radius: 6px;
    background: color-mix(in srgb, currentColor 8%, var(--smrt-color-surface));
  }

  .signal-icon {
    grid-row: span 2;
    margin-top: 1px;
  }

  .signal-label {
    color: var(--smrt-color-on-surface-variant);
    font: 800 10px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .signal-card strong {
    min-width: 0;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.2;
    overflow-wrap: anywhere;
    text-transform: capitalize;
  }

  .tone-positive {
    color: var(--smrt-color-on-success-container);
  }

  .tone-amber {
    color: var(--smrt-color-on-warning-container);
  }

  .tone-negative {
    color: var(--smrt-color-on-error-container);
  }

  .tone-neutral {
    color: var(--smrt-color-on-surface-variant);
  }

  .tone-muted {
    color: var(--smrt-color-on-surface-variant);
  }

  .detail-block {
    display: grid;
    gap: 8px;
  }

  .detail-block h4 {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .detail-block h5 {
    margin: 0 0 5px;
    color: var(--smrt-color-on-surface-variant);
    font: 900 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .summary-text {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.45;
  }

  .intelligence-columns {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .intelligence-columns ul,
  .warning-block ul,
  .evidence-item ul {
    display: grid;
    gap: 5px;
    margin: 0;
    padding-left: 17px;
    color: var(--smrt-color-on-surface);
    font-size: 12px;
    line-height: 1.4;
  }

  .warning-block {
    padding: 10px;
    border: 1px solid var(--smrt-color-warning);
    border-radius: 6px;
    background: var(--smrt-color-warning-container);
  }

  .evidence-list {
    display: grid;
    gap: 8px;
  }

  .evidence-item {
    display: grid;
    gap: 7px;
    padding: 9px 10px;
    border: 1px solid currentColor;
    border-radius: 6px;
    background: color-mix(in srgb, currentColor 7%, var(--smrt-color-surface));
  }

  .evidence-item header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 8px;
  }

  .evidence-item header strong {
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.3;
  }

  .evidence-item header span {
    flex: 0 0 auto;
    color: currentColor;
    font-size: 11px;
    font-weight: 900;
    text-transform: uppercase;
  }

  .evidence-item p,
  .evidence-item small,
  .agent-run-list small {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .evidence-item li span {
    display: block;
    color: var(--smrt-color-on-surface);
    font-weight: 800;
  }

  .agent-run-list div {
    display: grid;
    grid-template-columns: minmax(120px, 0.45fr) minmax(0, 1fr);
    gap: 8px;
  }

  .agent-run-list dd {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 8px;
  }

  .agent-run-list time {
    color: var(--smrt-color-on-surface-variant);
  }

  .detail-list,
  .details-section dl {
    display: grid;
    gap: 9px;
    margin: 0;
  }

  .compact-detail-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .detail-list .wide-detail {
    grid-column: 1 / -1;
  }

  dt {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  dd {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.4;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .formatted-text {
    white-space: pre-wrap;
  }

  .placeholder {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }

  @media (max-width: 860px) {
    .signal-grid,
    .intelligence-columns {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 520px) {
    .opportunity-review-header,
    .signal-grid,
    .compact-detail-list,
    .intelligence-columns,
    .agent-run-list div {
      grid-template-columns: 1fr;
    }

    .detail-actions {
      justify-content: flex-start;
    }
  }
</style>
