<script lang="ts">
import Building2 from '@lucide/svelte/icons/building-2';
import ExternalLink from '@lucide/svelte/icons/external-link';
import MapPin from '@lucide/svelte/icons/map-pin';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Undo2 from '@lucide/svelte/icons/undo-2';
import type { AdminRecord } from '$lib/admin/dock';
import {
  TRIAGE_SHORTCUTS,
  type TriageShortcutAction,
} from '$lib/admin/triage-shortcuts';
import { getNumber, getString, parseSkillList } from '$lib/opportunity-filters';
import { createCandidateSkillMatcher } from '$lib/skill-matching';

/**
 * One triage card: the job description is the body, on the left; the right
 * column carries the facts, the fit (summary, skills, responsibilities,
 * qualifications), and the review notes. The three verdicts live in the triage
 * dialog's own footer, not here; the sidebar carries the notes a verdict reads
 * and the utilities beside it. The verdict buttons stamp the rating and the
 * posting check happens behind "dig deeper", so neither is shown here.
 *
 * The component is presentational — every action is raised to the route, which
 * owns the queue, the in-flight state, and the posts to the same
 * `reviewOpportunity` action the list uses.
 *
 * Every field is optional on purpose: a freshly crawled posting may have no
 * score, no company, no salary, and no summary, and it still has to be
 * decidable.
 */
let {
  record,
  candidateSkills = [],
  busy = false,
  canUndo = false,
  undoLabel = '',
  onAction,
  notes = $bindable(''),
} = $props<{
  record: AdminRecord;
  candidateSkills?: string[];
  busy?: boolean;
  canUndo?: boolean;
  undoLabel?: string;
  onAction: (action: TriageShortcutAction) => void;
  notes?: string;
}>();

const hasSkill = $derived(createCandidateSkillMatcher(candidateSkills));

function str(key: string): string {
  return getString(record, key);
}

function humanize(value: string, fallback = ''): string {
  const text = value.trim();
  return text ? text.replaceAll('_', ' ') : fallback;
}

function lineItems(key: string): string[] {
  return str(key)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
}

const opportunityId = $derived(str('id'));
const title = $derived(str('title') || 'Untitled opportunity');
const company = $derived(str('companyName') || str('company'));
const locations = $derived(str('locations') || str('locationNotes'));
const postingUrl = $derived(str('postingUrl') || str('applyUrl'));
const score = $derived(getNumber(record, 'latestScore'));
const summary = $derived(
  str('latestScoreSummary') || str('descriptionSummary'),
);
const requiredSkills = $derived(parseSkillList(str('requiredSkills')));
const preferredSkills = $derived(parseSkillList(str('preferredSkills')));
const responsibilities = $derived(lineItems('responsibilities'));
const qualifications = $derived(lineItems('qualifications'));

const salaryLabel = $derived.by(() => {
  const currency = str('currency') || 'USD';
  const min = getNumber(record, 'salaryMin');
  const max = getNumber(record, 'salaryMax');
  const hourlyMin = getNumber(record, 'hourlyMin');
  const hourlyMax = getNumber(record, 'hourlyMax');
  const format = (value: number) => value.toLocaleString('en-US');
  if (min !== null || max !== null) {
    const range =
      min !== null && max !== null
        ? `${format(min)}–${format(max)}`
        : format((min ?? max) as number);
    return `${currency} ${range}`;
  }
  if (hourlyMin !== null || hourlyMax !== null) {
    const range =
      hourlyMin !== null && hourlyMax !== null
        ? `${format(hourlyMin)}–${format(hourlyMax)}`
        : format((hourlyMin ?? hourlyMax) as number);
    return `${currency} ${range}/hr`;
  }
  return '';
});

const facts = $derived(
  [
    { label: 'Employment type', value: humanize(str('employmentType')) },
    { label: 'Work mode', value: humanize(str('workMode')) },
    { label: 'Seniority', value: humanize(str('seniority')) },
    { label: 'Freshness', value: humanize(str('freshness')) },
    { label: 'Compensation', value: salaryLabel },
    { label: 'Apply method', value: humanize(str('applyMethod')) },
    { label: 'Status', value: humanize(str('status')) },
  ].filter(
    (fact) => fact.value !== '' && fact.value.toLowerCase() !== 'unknown',
  ),
);
</script>

<article class="triage-card" aria-label={`Triage card for ${title}`}>
  <div class="main">
    <header class="card-head">
      <h2>{title}</h2>
      <p class="meta">
        <span><Building2 size={14} strokeWidth={2.2} /> {company || 'Unknown company'}</span>
        <span><MapPin size={14} strokeWidth={2.2} /> {locations || 'Location not stated'}</span>
        {#if score !== null}
          <span class="badge"><Sparkles size={12} strokeWidth={2.4} /> {score}</span>
        {:else}
          <span class="badge muted"><Sparkles size={12} strokeWidth={2.4} /> Not scored</span>
        {/if}
      </p>
      {#if postingUrl}
        <a class="posting-link" href={postingUrl} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={14} strokeWidth={2.2} /> View the posting
        </a>
      {/if}
    </header>

    <section aria-label="Job description">
      <h3>Job description</h3>
      {#if str('descriptionRaw')}
        <pre>{str('descriptionRaw')}</pre>
      {:else}
        <p class="muted">No description captured yet.</p>
      {/if}
    </section>
  </div>

  <aside class="card-aside" aria-label="Decision">
    <section class="panel" aria-label="Facts">
      <h3>Facts</h3>
      {#if facts.length}
        <dl class="facts">
          {#each facts as fact}
            <div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
          {/each}
        </dl>
      {:else}
        <p class="muted">Nothing captured beyond the title.</p>
      {/if}
      <a class="detail-link" href={`/admin/opportunities/${encodeURIComponent(opportunityId)}`}>
        Open the full record
      </a>
    </section>

    <section class="panel" aria-label="Fit">
      <h3>Summary</h3>
      {#if summary}
        <p class="summary">{summary}</p>
      {:else}
        <p class="muted">No summary captured yet.</p>
      {/if}

      {#if requiredSkills.length || preferredSkills.length}
        <h4>Skills</h4>
        <div class="skills">
          {#each requiredSkills as skill}
            <span class="chip" class:have={hasSkill(skill)}>{skill}</span>
          {/each}
          {#each preferredSkills as skill}
            <span class="chip preferred" class:have={hasSkill(skill)}>{skill}</span>
          {/each}
        </div>
      {/if}

      {#if responsibilities.length}
        <h4>Responsibilities</h4>
        <ul>{#each responsibilities as item}<li>{item}</li>{/each}</ul>
      {/if}

      {#if qualifications.length}
        <h4>Qualifications</h4>
        <ul>{#each qualifications as item}<li>{item}</li>{/each}</ul>
      {/if}
    </section>

    <section class="panel" aria-label="Review">
      <label class="field">
        <span>Review notes</span>
        <textarea
          name="humanReviewNotes"
          rows="3"
          bind:value={notes}
          placeholder="Why is this worth a deeper look — or not?"
        ></textarea>
      </label>

      <div class="secondary-actions">
        <button type="button" disabled={busy} onclick={() => onAction('verify')}>
          <ShieldCheck size={13} strokeWidth={2.2} /> Verify posting
        </button>
        <button
          type="button"
          disabled={busy || !canUndo}
          title={canUndo ? undoLabel : 'Nothing to undo'}
          onclick={() => onAction('undo')}
        >
          <Undo2 size={13} strokeWidth={2.2} /> Undo
        </button>
      </div>

      <p class="undo-note">
        Undo restores the review fields of the last decision. Nothing here
        starts an application — apply from the shortlist or the full record.
      </p>

      <dl class="shortcuts" aria-label="Keyboard shortcuts">
        {#each TRIAGE_SHORTCUTS as shortcut}
          <div><dt>{shortcut.hint}</dt><dd>{shortcut.label}</dd></div>
        {/each}
      </dl>
    </section>
  </aside>
</article>

<style>
  .triage-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 24rem);
    align-items: start;
    gap: 16px;
  }

  .main {
    display: grid;
    gap: 14px;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 10px;
    background: var(--smrt-color-surface);
  }

  /* Scrolls with the description; the verdicts live in the dialog footer. */
  .card-aside {
    display: grid;
    align-content: start;
    align-self: start;
    gap: 12px;
    min-width: 0;
  }

  .panel {
    display: grid;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 10px;
    background: var(--smrt-color-surface);
  }

  .card-head {
    display: grid;
    gap: 6px;
  }

  h2 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-small-font);
  }

  h3 {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  h4 {
    margin: 6px 0 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 13px;
  }

  .meta span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .badge {
    padding: 1px 8px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    font-weight: 800;
  }

  .badge.muted {
    color: var(--smrt-color-on-surface-variant);
  }

  .posting-link,
  .detail-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--smrt-color-primary);
    font-size: 13px;
    font-weight: 800;
    text-decoration: none;
  }

  .posting-link:hover,
  .detail-link:hover {
    text-decoration: underline;
  }

  section {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .summary,
  ul {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.5;
  }

  ul {
    padding-left: 18px;
  }

  .muted {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 13px;
  }

  /* The description is the body of the card: no cap, the dialog scrolls. */
  pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: 13px;
    line-height: 1.55;
  }

  .skills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    padding: 1px 8px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
  }

  .chip.have {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .chip.preferred {
    font-weight: 500;
  }

  .facts,
  .shortcuts {
    display: grid;
    gap: 4px;
    margin: 0;
  }

  .facts div,
  .shortcuts div {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    font-size: 12px;
  }

  dt {
    color: var(--smrt-color-on-surface-variant);
    font-weight: 800;
    text-transform: uppercase;
  }

  dd {
    margin: 0;
    color: var(--smrt-color-on-surface);
    text-align: right;
  }

  .field {
    display: grid;
    gap: 4px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .field textarea {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: 13px;
    text-transform: none;
  }

  .field textarea {
    resize: vertical;
  }

  .secondary-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .secondary-actions button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-weight: 800;
    cursor: pointer;
  }

  .secondary-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .undo-note {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    line-height: 1.45;
  }

  @media (max-width: 960px) {
    .triage-card {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
