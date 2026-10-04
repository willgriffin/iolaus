<script module lang="ts">
import type { OpportunityResumeFitReviewProjection } from '$lib/server/opportunity-resume-fit-review-projection';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}
function citation(value: unknown): value is Record<string, unknown> {
  return object(value) && text(value.quote) && Number.isInteger(value.start) && Number.isInteger(value.end)
    && Number(value.start) >= 0 && Number(value.end) > Number(value.start)
    && value.quote.length === Number(value.end) - Number(value.start);
}
/** Presentation validation only; the server's actual private receipt reader establishes authority. */
export function getCurrentOpportunityResumeFitReviewProjection(value: unknown): OpportunityResumeFitReviewProjection | null {
  if (!object(value) || value.version !== 'opportunity-resume-fit-review-projection/v1'
    || value.mode !== 'advisory' || value.sourceStatus !== 'current' || !object(value.coverage)
    || value.coverage.fullFit !== 'unknown' || !Number.isInteger(value.coverage.candidateSourceCount)
    || Number(value.coverage.candidateSourceCount) < 1 || typeof value.coverage.sourceComplete !== 'boolean'
    || !ids(value.coverage.reviewedRequirementIds) || !ids(value.coverage.unresolvedClauseIds)
    || (value.coverage.sourceComplete && value.coverage.unresolvedClauseIds.length > 0)
    || !Array.isArray(value.requirements) || value.requirements.length === 0) return null;
  const requirementIds: string[] = [];
  for (const row of value.requirements) {
    if (!object(row) || !text(row.id) || !text(row.text) || typeof row.note !== 'string'
      || !['strength', 'uncertain'].includes(String(row.status))
      || !['supported', 'uncertain', 'not_applicable'].includes(String(row.seniority))
      || !Array.isArray(row.candidateCitations) || !Array.isArray(row.postingCitations)
      || !row.candidateCitations.every((item) => citation(item) && text(item.sourceId) && text(item.title) && text(item.kind))
      || !row.postingCitations.every((item) => citation(item) && text(item.clauseId))
      || (row.status === 'strength' && (!row.candidateCitations.length || !row.postingCitations.length))) return null;
    requirementIds.push(row.id);
  }
  const reviewedIds = value.coverage.reviewedRequirementIds;
  if (new Set(requirementIds).size !== requirementIds.length
    || requirementIds.length !== reviewedIds.length
    || requirementIds.some((id) => !reviewedIds.includes(id))) return null;
  return value as unknown as OpportunityResumeFitReviewProjection;
}
</script>

<script lang="ts">
let { projection, compact = false } = $props<{ projection?: unknown; compact?: boolean }>();
const current = $derived(getCurrentOpportunityResumeFitReviewProjection(projection));
const strengths = $derived(current?.requirements.filter((row) => row.status === 'strength').length ?? 0);
</script>

{#if current}
  <div class="resume-fit-review" class:compact role="group" aria-label="Advisory resume review">
    <p class="review-label">Resume review · {strengths} {strengths === 1 ? 'strength' : 'strengths'} · {current.requirements.length - strengths} uncertain</p>
    <p>Advisory review of {current.requirements.length} {current.requirements.length === 1 ? 'criterion' : 'criteria'} using {current.coverage.candidateSourceCount} candidate {current.coverage.candidateSourceCount === 1 ? 'source' : 'sources'}. Overall fit remains unknown.</p>
    <p>{current.coverage.sourceComplete ? 'Captured source coverage is complete for this review.' : `Source coverage is incomplete: ${current.coverage.unresolvedClauseIds.length} unresolved source ${current.coverage.unresolvedClauseIds.length === 1 ? 'clause' : 'clauses'}.`}</p>
    <details open={!compact}>
      <summary>Strengths, uncertainty and seniority citations</summary>
      <ul>
        {#each current.requirements as requirement (requirement.id)}
          <li>
            <p class="criterion">{requirement.text}</p>
            <p>{requirement.status === 'strength' ? 'Candidate evidence supports a strength for this criterion.' : 'Candidate support remains uncertain.'}</p>
            <p>{requirement.seniority === 'supported' ? 'Seniority evidence is supported.' : requirement.seniority === 'uncertain' ? 'Seniority remains uncertain.' : 'Seniority is not applicable to this criterion.'}</p>
            <p>{requirement.note}</p>
            {#each requirement.postingCitations as cite}
              <blockquote><p>{cite.quote}</p><cite>Captured posting</cite><details><summary>Citation details</summary><p>Clause {cite.clauseId}, characters {cite.start}–{cite.end}</p></details></blockquote>
            {/each}
            {#each requirement.candidateCitations as cite}
              <blockquote><p>{cite.quote}</p><cite>{cite.title}</cite><details><summary>Citation details</summary><p>Source {cite.sourceId} ({cite.kind}), characters {cite.start}–{cite.end}</p></details></blockquote>
            {/each}
          </li>
        {/each}
      </ul>
    </details>
  </div>
{/if}

<style>
.resume-fit-review { min-width: 0; margin-top: 0.75rem; font-size: 0.875rem; line-height: 1.45; overflow-wrap: anywhere; }
.resume-fit-review p { margin: 0.35rem 0; }
.review-label, .criterion { font-weight: 600; }
.resume-fit-review details { margin-top: 0.5rem; }
.resume-fit-review summary { cursor: pointer; }
.resume-fit-review ul { padding-left: 1rem; margin: 0.75rem 0 0; }
.resume-fit-review li + li { margin-top: 1rem; }
.resume-fit-review blockquote { margin: 0.5rem 0; padding-left: 0.75rem; border-left: 2px solid var(--border-color, #d1d5db); }
.resume-fit-review cite { font-style: normal; font-size: 0.75rem; opacity: 0.8; }
.compact { font-size: 0.75rem; }
</style>
