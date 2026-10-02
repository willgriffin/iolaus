<script module lang="ts">
import type { OpportunityPartialAssessmentProjection } from '$lib/server/opportunity-assessment-partial-projection';

export function getCurrentPartialOpportunityAssessmentProjection(
  projection: unknown,
): OpportunityPartialAssessmentProjection | null {
  if (
    !projection ||
    typeof projection !== 'object' ||
    Array.isArray(projection)
  )
    return null;
  const value = projection as OpportunityPartialAssessmentProjection;
  return value.version === 'opportunity-assessment-partial-projection/v1' &&
    value.mode === 'partial' &&
    value.sourceStatus === 'current' &&
    Number.isSafeInteger(value.criterionCount) &&
    value.criterionCount > 0 &&
    Number.isSafeInteger(value.supportedCriterionCount) &&
    value.supportedCriterionCount >= 0 &&
    value.supportedCriterionCount <= value.criterionCount &&
    Number.isSafeInteger(value.unresolvedSourceClauseCount) &&
    value.unresolvedSourceClauseCount >= 0 &&
    Array.isArray(value.requirements) &&
    value.requirements.length === value.criterionCount &&
    value.requirements.every((row) => row && typeof row === 'object') &&
    value.requirements.filter((row) => row.support === 'supported').length ===
      value.supportedCriterionCount &&
    value.requirements.every(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.text === 'string' &&
        ['supported', 'uncertain'].includes(row.support) &&
        Array.isArray(row.postingCitations) &&
        Array.isArray(row.candidateCitations) &&
        row.postingCitations.every(
          (citation) =>
            citation &&
            typeof citation === 'object' &&
            typeof citation.excerpt === 'string' &&
            typeof citation.clauseId === 'string' &&
            Number.isSafeInteger(citation.start) &&
            Number.isSafeInteger(citation.end) &&
            citation.start >= 0 &&
            citation.end > citation.start,
        ) &&
        row.candidateCitations.every(
          (citation) =>
            citation &&
            typeof citation === 'object' &&
            typeof citation.sourceId === 'string' &&
            typeof citation.title === 'string' &&
            typeof citation.excerpt === 'string',
        ),
    )
    ? value
    : null;
}
</script>

<script lang="ts">
let { projection, compact = false } = $props<{
  projection?: unknown;
  compact?: boolean;
}>();
const current = $derived(getCurrentPartialOpportunityAssessmentProjection(projection));
</script>

{#if current}
  <div class="partial-evidence" class:compact role="group" aria-label="Partial requirement evidence">
    <p class="partial-label">Partial evidence · {current.supportedCriterionCount} supported {current.supportedCriterionCount === 1 ? 'criterion' : 'criteria'} of {current.criterionCount} assessed</p>
    <p>{current.unresolvedSourceClauseCount} unresolved source {current.unresolvedSourceClauseCount === 1 ? 'clause' : 'clauses'}. No overall fit conclusion.</p>
    <details open={!compact}>
      <summary>Criteria and exact citations</summary>
      <ul>
        {#each current.requirements as requirement (requirement.id)}
          <li>
            <p class="criterion">{requirement.text}</p>
            <p>{requirement.support === 'supported' ? 'Candidate evidence supports this criterion.' : 'Candidate support remains uncertain.'}</p>
            {#each requirement.postingCitations as citation}
              <blockquote><p>{citation.excerpt}</p><cite>Captured posting</cite><details><summary>Citation details</summary><p>Clause {citation.clauseId}, characters {citation.start}–{citation.end}</p></details></blockquote>
            {/each}
            {#each requirement.candidateCitations as citation}
              <blockquote><p>{citation.excerpt}</p><cite>{citation.title}</cite>{#if citation.recordId || citation.sectionId}<details><summary>Citation details</summary><p>{citation.recordId ? `Record ${citation.recordId}` : ''}{citation.sectionId ? ` · Section ${citation.sectionId}` : ''}</p></details>{/if}</blockquote>
            {/each}
          </li>
        {/each}
      </ul>
    </details>
  </div>
{/if}

<style>
.partial-evidence { min-width: 0; margin-top: 0.75rem; font-size: 0.875rem; line-height: 1.45; overflow-wrap: anywhere; }
.partial-evidence p { margin: 0.35rem 0; }
.partial-label, .criterion { font-weight: 600; }
.partial-evidence details { margin-top: 0.5rem; }
.partial-evidence summary { cursor: pointer; }
.partial-evidence ul { padding-left: 1rem; margin: 0.75rem 0 0; }
.partial-evidence li + li { margin-top: 1rem; }
.partial-evidence blockquote { margin: 0.5rem 0; padding-left: 0.75rem; border-left: 2px solid var(--border-color, #d1d5db); }
.partial-evidence cite { font-style: normal; font-size: 0.75rem; opacity: 0.8; }
.compact { font-size: 0.75rem; }
</style>
