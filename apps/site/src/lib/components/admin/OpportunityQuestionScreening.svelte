<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import { invalidateAll } from '$app/navigation';
import {
  getCurrentQuestionScreeningProjection,
  questionScreeningLabel,
} from '$lib/question-screening-projection';

let {
  opportunityId,
  projection,
  status,
  blockedReason,
  compact = false,
  disabled = false,
}: {
  opportunityId: string;
  projection?: unknown;
  status?: unknown;
  blockedReason?: unknown;
  compact?: boolean;
  disabled?: boolean;
} = $props();
const current = $derived(
  getCurrentQuestionScreeningProjection(projection, status),
);
const blocked = $derived(
  typeof blockedReason === 'string' && blockedReason.trim()
    ? blockedReason
    : '',
);
let running = $state(false);
let error = $state('');
let notice = $state('');
async function run(fullReview = false) {
  if (running || blocked || disabled) return;
  running = true;
  error = '';
  notice = '';
  try {
    const response = await fetch(
      `/api/admin/opportunities/${encodeURIComponent(opportunityId)}/screening-questions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullReview ? { fullReview: true } : {}),
      },
    );
    const result: unknown = await response.json();
    if (
      !response.ok ||
      !result ||
      typeof result !== 'object' ||
      !('ok' in result) ||
      result.ok !== true
    ) {
      error =
        result &&
        typeof result === 'object' &&
        'error' in result &&
        typeof result.error === 'string'
          ? result.error
          : 'Screening could not complete. Retry when ready.';
      return;
    }
    await invalidateAll();
    notice = 'Screening results refreshed.';
  } catch {
    error = 'Screening could not complete. Check your connection and retry.';
  } finally {
    running = false;
  }
}
</script>

<section class="question-screening" class:compact aria-label="Screening question results">
  {#if current}
    <p class="recommendation">{questionScreeningLabel(current)}</p>
    {#if current.rolePreScreen}
      <p>Title-only pre-screen: “{current.rolePreScreen.title}” is outside your target roles. Full questions have not been assessed. No recommendation percentage or rejection has been assigned.</p>
      <p>Target roles: {current.rolePreScreen.targetRoles.join(', ')}</p>
      <Button type="button" disabled={running || !!blocked || disabled} onclick={() => run(true)}>Run full screening anyway</Button>
    {:else}
    <p>Weighted alignment with your enabled questions. Unknowns earn no points; this is not hiring probability.</p>
    <p>Evidence coverage: {current.aggregate.evidenceCoveragePercent === null ? 'Unknown' : `${current.aggregate.evidenceCoveragePercent.toFixed(1)}%`} · Model: JEV ({current.model})</p>
    {#if current.aggregate.mustHaveConflictIds.length}<p class="constraint" role="status">{current.aggregate.mustHaveConflictIds.length} must-have conflicts. Review the cited answers before deciding.</p>{/if}
    {#if current.aggregate.unresolvedMustHaveIds.length}<p class="constraint" role="status">{current.aggregate.unresolvedMustHaveIds.length} unresolved must-haves; partial or unknown answers do not establish a conflict.</p>{/if}
    <details open={!compact}><summary>Questions, answers and evidence</summary>
      {#each current.questions.filter((question) => question.active) as question (question.id)}
        {@const answer = current.answers.find((item) => item.questionId === question.id)}
        <article><h3>{question.text}</h3><p>{question.importance === 'must_have' ? 'Must-have' : question.importance === 'preference' ? 'Preference' : 'Informational'} · Desired answer: {question.desiredAnswer === 'yes' ? 'Yes' : 'No'}{question.importance === 'informational' ? ' · Not scored' : ` · Weight ${question.weight}`}</p>
          {#if answer}<p>Answer: {answer.answer === 'partial' ? 'Partial — attributable evidence with unresolved qualifiers' : answer.answer === 'unknown' ? 'Unknown — evidence not established' : answer.answer === 'yes' ? 'Yes' : 'No'}</p>{#if question.importance !== 'informational'}<p>{answer.alignment === null ? 'Alignment points are unestablished.' : `${answer.alignment}/4 alignment points toward your desired answer.`}</p>{/if}{#if answer.uncertainty}<p>{answer.uncertainty}</p>{/if}
            {#each answer.sourceCitations as cite}<blockquote><p>{cite.text}</p><cite>Captured posting{cite.sourceFieldPath ? ` · ${cite.sourceFieldPath}` : ''}</cite></blockquote>{/each}
            {#each answer.candidateCitations as cite}<blockquote><p>{cite.text}</p><cite>{cite.title} · Supplied candidate evidence</cite></blockquote>{/each}
          {/if}
        </article>
      {/each}
    </details>
    {#if current.skillMatches?.length}
    <details><summary>Individual skill evidence</summary>
      <p>Each named capability is assessed separately. Direct experience describes documented capability use; the overall fit question assesses the full job requirements. Related, introductory and unknown evidence do not establish a missing skill. Up to eight skills are assessed per run, with required skills first. Fewer are assessed when the full evidence needs more request space; the rest stay unassessed.</p>
      {#each current.skillMatches as match}
        <article><h3>{match.requirement}</h3>{#if match.sourceOrigin === 'body_literal'}<p>Extracted posting skill, anchored to the exact captured body text.</p>{/if}<p>{match.sourceOrigin === 'body_literal' ? 'Extracted skill label' : match.sourceField === 'requiredSkills' ? 'Required' : 'Preferred'} · {!match.assessed ? 'Not assessed' : match.status === 'supported' ? match.meaning === 'named_capability' ? 'Direct experience' : 'Supported' : match.status === 'partial' ? match.meaning === 'named_capability' ? 'Related or introductory' : 'Partial support — qualifiers unresolved' : 'Unknown — evidence not established'}</p>
          <blockquote><p>{match.sourceCitation.text}</p><cite>Captured posting{match.sourceCitation.sourceFieldPath ? ` · ${match.sourceCitation.sourceFieldPath}` : ''}</cite></blockquote>
          {#each match.candidateCitations as cite}<blockquote><p>{cite.text}</p><cite>{cite.title} · Supplied candidate evidence</cite></blockquote>{/each}
        </article>
      {/each}
    </details>
    {/if}
    {/if}
  {:else if status === 'unknown'}<p>Screening needs refresh. Questions, captured source or candidate evidence may have changed.</p>
  {:else}<p>Screening questions have not been run for this opportunity.</p>{/if}
  {#if blocked}<p role="alert">{blocked}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  <div class="screening-actions"><Button type="button" disabled={running || !!blocked || disabled} onclick={() => run()}>{running ? 'Screening…' : 'Run screening'}</Button><a href="/admin/preferences/screening-questions">Edit Screening Questions</a></div>
  {#if running}<p role="status">Checking the title first, then the current enabled questions when relevant or uncertain. Activity is recorded in the activity feed.</p>{/if}
</section>
<style>
.question-screening { margin-top: .75rem; overflow-wrap: anywhere; } p { line-height: 1.45; } .recommendation, .constraint { font-weight: 600; } .screening-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; } article { margin-top: 1rem; } h3 { font-size: 1rem; } blockquote { padding-left: .75rem; margin: .5rem 0; border-left: 2px solid var(--border-color, #d1d5db); } cite { font-size: .8rem; } .compact { font-size: .85rem; } [role=alert] { color: var(--error-color, #b91c1c); }
</style>
