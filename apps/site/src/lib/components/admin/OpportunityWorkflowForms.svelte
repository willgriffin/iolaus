<script lang="ts">
import FileText from '@lucide/svelte/icons/file-text';
import MessageSquareText from '@lucide/svelte/icons/message-square-text';
import type { AdminRecord } from '$lib/admin/dock';
import {
  applyMethods,
  coverLetterModes,
  resumeModes,
} from '$lib/admin/resources';

/**
 * Per-opportunity workflow forms relocated out of the admin dock (issue #421):
 * the only human paths from an opportunity to a draft application and to a
 * fact intake ("Notes"). Rendered in the opportunity expansion row and on the
 * opportunity detail page so both surfaces stay identical.
 *
 * `preflightOverrideReason` is a human-only override. It stays a plain form
 * field here and must never be exported anywhere tool-shaped (WebMCP/MCP).
 */
let {
  record,
  draftApplicationAction = '?/createDraftApplication',
  factIntakeAction = '?/createFactIntake',
  compact = false,
} = $props<{
  record: AdminRecord;
  draftApplicationAction?: string;
  factIntakeAction?: string;
  compact?: boolean;
}>();

function str(key: string): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

function humanize(value: string, fallback = ''): string {
  const text = value.trim();
  if (!text) return fallback;
  return text.replaceAll('_', ' ');
}

function datetimeLocal(key: string): string {
  const value = str(key);
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

const opportunityId = $derived(str('id'));
const applicationId = $derived(str('applicationId'));
const factIntakeCount = $derived(Number(record.factIntakeCount ?? 0) || 0);
</script>

<div class="workflow-forms" class:compact>
  <section class="workflow-section" aria-label="Application package">
    <div class="section-head">
      <h3><FileText size={13} strokeWidth={2.2} /> Application</h3>
      {#if applicationId}
        <a
          class="section-link"
          href={`/admin/applications/${encodeURIComponent(applicationId)}`}
        >
          Open {humanize(str('applicationStatus'), 'draft').toLowerCase()} application
        </a>
      {/if}
    </div>
    <form method="POST" action={draftApplicationAction} class="stack-form grid-form">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <label>
        <span>Apply method</span>
        <select name="applyMethod" value={str('applicationApplyMethod') || 'company_site'}>
          {#each applyMethods as mode}
            <option value={mode}>{mode}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Resume</span>
        <select name="resumeMode" value={str('applicationResumeMode') || 'default'}>
          {#each resumeModes as mode}
            <option value={mode}>{mode}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Cover letter</span>
        <select name="coverLetterMode" value={str('applicationCoverLetterMode') || 'none'}>
          {#each coverLetterModes as mode}
            <option value={mode}>{mode}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Due at</span>
        <input type="datetime-local" name="dueAt" value={datetimeLocal('applicationDueAt')} />
      </label>
      <label class="wide">
        <span>Instructions</span>
        <textarea
          name="applicationInstructions"
          rows={compact ? 2 : 3}
          value={str('applicationInstructions')}
        ></textarea>
      </label>
      <label class="wide">
        <span>Required answers</span>
        <textarea
          name="requiredAnswers"
          rows={compact ? 2 : 3}
          value={str('applicationRequiredAnswers')}
        ></textarea>
      </label>
      <label class="wide">
        <span>Override inconclusive posting check</span>
        <input
          name="preflightOverrideReason"
          placeholder="Only after you personally verified the posting is open"
        />
      </label>
      <button type="submit" class="workflow-submit primary">
        {applicationId ? 'Update draft' : 'Create draft application'}
      </button>
    </form>
  </section>

  <section class="workflow-section" aria-label="Opportunity notes">
    <div class="section-head">
      <h3><MessageSquareText size={13} strokeWidth={2.2} /> Notes</h3>
      {#if factIntakeCount > 0}
        <span class="section-meta">{factIntakeCount} linked</span>
      {/if}
    </div>
    <form method="POST" action={factIntakeAction} class="stack-form">
      <input type="hidden" name="targetEntityType" value="Opportunity" />
      <input type="hidden" name="targetEntityId" value={opportunityId} />
      <input type="hidden" name="sourceKind" value="story" />
      <label class="wide">
        <span>Story, snippet, or brainstorm</span>
        <textarea name="rawText" rows={compact ? 3 : 4} required></textarea>
      </label>
      <label class="wide">
        <span>Context</span>
        <textarea
          name="intakeContext"
          rows={compact ? 1 : 2}
          value={`Opportunity: ${str('title')}`}
        ></textarea>
      </label>
      <button type="submit" class="workflow-submit">Extract fact candidates</button>
    </form>
  </section>
</div>

<style>
  .workflow-forms {
    display: grid;
    gap: 14px;
  }

  .workflow-section {
    display: grid;
    gap: 8px;
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
  }

  h3 {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .section-link,
  .section-meta {
    margin-left: auto;
    font-size: 12px;
    font-weight: 800;
  }

  .section-link {
    color: var(--smrt-color-primary);
    text-decoration: none;
  }

  .section-link:hover {
    text-decoration: underline;
  }

  .section-meta {
    color: var(--smrt-color-on-surface-variant);
  }

  .stack-form {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
  }

  .grid-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stack-form label {
    display: grid;
    gap: 4px;
    min-width: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .stack-form label.wide,
  .stack-form .workflow-submit {
    grid-column: 1 / -1;
  }

  .stack-form select,
  .stack-form input,
  .stack-form textarea {
    width: 100%;
    min-height: 30px;
    padding: 4px 8px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: 13px;
    text-transform: none;
  }

  .stack-form textarea {
    resize: vertical;
  }

  .workflow-submit {
    justify-self: start;
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

  .workflow-submit.primary {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .workflow-submit:hover,
  .workflow-submit:focus-visible {
    background: var(--smrt-color-primary-container);
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary-container);
  }

  .compact .stack-form {
    padding: 8px;
  }

  @media (max-width: 720px) {
    .grid-form {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
