<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type { SubmitFunction } from '@sveltejs/kit';
import { tick } from 'svelte';
import { enhance } from '$app/forms';
import type { ScreeningQuestion } from '$lib/opportunity-screening-questions';

type Draft = Omit<ScreeningQuestion, 'id' | 'revision'>;
type Suggestion = Draft;
type InvalidQuestion = {
  id: string;
  label: string;
  errorCode: 'invalid_question_rule';
  revision: string;
};
let {
  data,
  form,
}: {
  data: {
    questions: ScreeningQuestion[];
    questionSetFingerprint: string;
    suggestions?: Suggestion[];
    invalidQuestions?: InvalidQuestion[];
    errors?: string[];
  };
  form?: { ok?: boolean; error?: string; message?: string } | null;
} = $props();
let editing = $state<string | null>(null);
let draft = $state<Draft>({
  text: '',
  kind: 'source',
  importance: 'preference',
  desiredAnswer: 'yes',
  weight: 3,
  active: true,
});
let saving = $state(false);
let localError = $state('');
let notice = $state('');
let triggerId = '';
let invalidLocator = $state<InvalidQuestion | null>(null);
const activeQuestion = $derived(
  data.questions.find((question) => question.id === editing),
);
const activeLocator = $derived(activeQuestion ?? invalidLocator);

async function begin(
  question: ScreeningQuestion | Suggestion | null,
  trigger: string,
  intent: 'edit' | 'create' = 'edit',
) {
  triggerId = trigger;
  invalidLocator = null;
  editing =
    intent === 'edit' && question && 'id' in question ? question.id : 'new';
  draft = question
    ? {
        text: question.text,
        kind: question.kind,
        importance: question.importance,
        desiredAnswer: question.desiredAnswer,
        weight: question.weight,
        active: question.active,
      }
    : {
        text: '',
        kind: 'source',
        importance: 'preference',
        desiredAnswer: 'yes',
        weight: 3,
        active: true,
      };
  localError = '';
  notice = '';
  await tick();
  document.getElementById('screening-question-text')?.focus();
}
async function repair(question: InvalidQuestion, trigger: string) {
  await begin(null, trigger);
  invalidLocator = question;
  editing = question.id;
  await tick();
  document.getElementById('screening-question-text')?.focus();
}
async function close() {
  editing = null;
  invalidLocator = null;
  localError = '';
  await tick();
  document.getElementById(triggerId)?.focus();
}
const submit: SubmitFunction = ({ cancel }) => {
  if (saving) {
    cancel();
    return;
  }
  saving = true;
  localError = '';
  notice = '';
  return async ({ result, update }) => {
    try {
      if (result.type === 'success' && result.data?.ok === true) {
        await update({ reset: false });
        notice =
          typeof result.data.message === 'string'
            ? result.data.message
            : 'Saved.';
        await close();
      } else if (result.type === 'failure') {
        localError =
          typeof result.data?.error === 'string'
            ? result.data.error
            : 'Unable to save. Your draft is still open.';
        await update({ reset: false, invalidateAll: false });
      } else {
        localError = 'Unable to save. Your draft is still open. Try again.';
      }
    } finally {
      saving = false;
    }
  };
};
const importanceLabel = (value: ScreeningQuestion['importance']) =>
  value === 'must_have'
    ? 'Must-have'
    : value === 'preference'
      ? 'Preference'
      : 'Informational';
</script>

<svelte:head><title>Screening Questions · Iolaus</title></svelte:head>
<section class="screening-preferences">
  <header><div><h1>Screening Questions</h1><p>Ask about the posting or how your supplied evidence fits. You choose the desired answer and how much it matters.</p></div><a href="/admin/opportunities">Opportunities</a></header>
  <p>Must-have conflicts and unknowns are shown separately. Unknown answers reduce recommendation points without establishing a mismatch. Informational questions do not contribute to recommendation.</p>
  {#if notice || form?.ok}<p role="status">{notice || form?.message}</p>{/if}
  {#if localError || form?.error}<p role="alert">{localError || form?.error}</p>{/if}
  {#each data.errors ?? [] as error}<p role="alert">{error} Screening is unavailable until this is resolved.</p>{/each}
  <Button id="add-screening-question" type="button" disabled={editing !== null || saving} onclick={() => begin(null, 'add-screening-question')}>Add question</Button>
  {#if !data.questions.length && !data.invalidQuestions?.length && editing === null}<p>No questions saved. Add a question or edit a suggestion below.</p>{/if}
  <div class="question-list">
    {#each data.invalidQuestions ?? [] as invalid (invalid.id)}
      <article class="question-card"><p role="alert">{invalid.label}: this saved question is invalid. Screening is unavailable until it is repaired or deleted.</p>{#if editing === invalid.id}{@render editor()}{:else}<Button id={`repair-question-${invalid.id}`} type="button" disabled={editing !== null || saving} onclick={() => repair(invalid, `repair-question-${invalid.id}`)}>Repair question</Button>{/if}</article>
    {/each}
    {#each data.questions as question (question.id)}
      <article class="question-card">
        {#if editing === question.id}
          {@render editor()}
        {:else}
          <h2>{question.text}</h2><p>{question.kind === 'source' ? 'Posting' : 'Candidate fit'} · {importanceLabel(question.importance)} · Desired answer: {question.desiredAnswer === 'yes' ? 'Yes' : 'No'} · {question.importance === 'informational' ? 'Not scored' : `Weight ${question.weight} of 10`} · {question.active ? 'Enabled' : 'Disabled'}</p>
          <Button id={`edit-question-${question.id}`} type="button" disabled={editing !== null || saving} onclick={() => begin(question, `edit-question-${question.id}`)}>Edit question</Button>
        {/if}
      </article>
    {/each}
    {#if editing === 'new'}<article class="question-card">{@render editor()}</article>{/if}
  </div>
  {#if data.suggestions?.length}
    <section aria-label="Suggested questions"><h2>Suggestions from your profile</h2><p>These are unsaved preferences. Edit and save a suggestion to enable it.</p>
      {#each data.suggestions as suggestion, index}<article class="question-card"><h3>{suggestion.text}</h3><Button id={`suggestion-${index}`} type="button" disabled={editing !== null || saving} onclick={() => begin({ ...suggestion, importance: 'preference' }, `suggestion-${index}`, 'create')}>Edit suggestion</Button></article>{/each}
    </section>
  {/if}
  <p>Screening runs only when you choose Run screening on an opportunity. Sol review is optional and does not run automatically.</p>
</section>

{#snippet editor()}
  <form method="POST" action="?/save" use:enhance={submit} aria-label="Edit screening question">
    <input type="hidden" name="id" value={activeLocator?.id ?? ''} />
    <input type="hidden" name="expectedRevision" value={activeLocator?.revision ?? ''} />
    <input type="hidden" name="active" value={String(draft.active)} />
    <label>Question<textarea id="screening-question-text" name="text" bind:value={draft.text} required maxlength="2000" rows="3" disabled={saving}></textarea></label>
    <div class="field-grid">
      <label>Question kind<select name="kind" bind:value={draft.kind} disabled={saving}><option value="source">Posting question</option><option value="fit">Candidate fit question</option></select></label>
      <label>Importance<select name="importance" bind:value={draft.importance} disabled={saving}><option value="must_have">Must-have</option><option value="preference">Preference</option><option value="informational">Informational</option></select></label>
      <label>Desired answer<select name="desiredAnswer" bind:value={draft.desiredAnswer} disabled={saving}><option value="yes">Yes</option><option value="no">No</option></select></label>
      <label>Weight (1–10)<input type="number" name="weight" bind:value={draft.weight} min="1" max="10" step="1" required disabled={saving} /></label>
    </div>
    <label class="enabled"><input type="checkbox" bind:checked={draft.active} disabled={saving} /> Enabled for screening</label>
    {#if draft.importance === 'informational'}<p>This answer will be shown without affecting recommendation.</p>{/if}
    <div class="editor-actions"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save question'}</Button><Button type="button" disabled={saving} onclick={close}>Cancel</Button></div>
  </form>
  {#if activeLocator}<form method="POST" action="?/delete" use:enhance={submit}><input type="hidden" name="id" value={activeLocator.id} /><input type="hidden" name="expectedRevision" value={activeLocator.revision} /><Button type="submit" disabled={saving}>Delete question</Button></form>{/if}
{/snippet}

<style>
.screening-preferences { max-width: 56rem; margin: 0 auto; padding: 1rem; }
header { display: flex; justify-content: space-between; gap: 1rem; align-items: start; }
h1 { margin: 0; } h2, h3 { font-size: 1rem; margin: 0 0 .5rem; overflow-wrap: anywhere; }
p { line-height: 1.5; }
.question-list { display: grid; gap: 1rem; margin-top: 1rem; }
.question-card { padding: 1rem; margin: .75rem 0; border: 1px solid var(--border-color, #d1d5db); border-radius: .5rem; }
label { display: grid; gap: .4rem; } .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }
textarea, select, input[type=number] { width: 100%; box-sizing: border-box; min-height: 2.75rem; padding: .6rem; color: inherit; background: var(--background-color, transparent); border: 1px solid var(--border-color, #d1d5db); border-radius: .3rem; font: inherit; }
.enabled { display: flex; align-items: center; gap: .5rem; } .screening-preferences :global(button), header a { min-height: 2.75rem; } .editor-actions { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
[role=alert] { color: var(--error-color, #b91c1c); }
@media (max-width: 600px) { header { flex-direction: column; } .field-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
