<script module lang="ts">
export { getCurrentPartialOpportunityAssessmentProjection } from '$lib/opportunity-partial-projection';
</script>

<script lang="ts">
import { getCurrentPartialOpportunityAssessmentProjection } from '$lib/opportunity-partial-projection';
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
