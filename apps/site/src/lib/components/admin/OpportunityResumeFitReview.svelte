<script module lang="ts">
export { getCurrentOpportunityResumeFitReviewProjection } from '$lib/opportunity-resume-fit-review-projection';
</script>

<script lang="ts">
import { completeReviewLabel, getCurrentOpportunityResumeFitReviewProjection } from '$lib/opportunity-resume-fit-review-projection';
let { projection, compact = false } = $props<{ projection?: unknown; compact?: boolean }>();
const current = $derived(getCurrentOpportunityResumeFitReviewProjection(projection));
const strengths = $derived(current?.requirements.filter((row) => row.status === 'strength').length ?? 0);
</script>

{#if current}
  <div class="resume-fit-review" class:compact role="group" aria-label={current.mode === 'complete_material' ? 'Complete material review' : 'Advisory resume review'}>
    {#if current.mode === 'complete_material'}
      {#if current.evidenceFit}
        <p class="review-label">{completeReviewLabel(current)}</p>
        {#if current.advisoryRelevance}
          <p>Supplied-evidence relevance mean: {current.advisoryRelevance.weightedMean === null ? 'Unestablished' : current.advisoryRelevance.weightedMean.toFixed(3)} (0–1), across {current.advisoryRelevance.denominator} considered criteria. Context units are excluded.</p>
          <p>{current.advisoryRelevance.criterionProbabilityPairs.filter((pair) => pair.evidenceStatus === 'unestablished').length} criteria have unestablished supplied evidence. This describes the supplied evidence, not candidate ability or overall fit.</p>
          <details><summary>Guarded criteria counts and source uncertainty</summary>{#if current.verification?.version === 'opportunity-review-strength-verification/v2-partial-relevance'}<p>{current.verification.verifiedPartialCount} high-confidence partial confirmations across {current.evidenceFit.consideredCriterionCount} considered criteria. These confirmations do not establish full criteria or imply absence of relevant evidence.</p>{/if}<p>{current.evidenceFit.supportedCriterionCount} supported of {current.evidenceFit.consideredCriterionCount} considered criteria · {current.evidenceFit.uncertainCriterionCount} uncertain · {current.evidenceFit.sourceUnknownCriterionCount} source-unknown</p><p>{current.evidenceFit.contextUnitCount} context units excluded from criteria counts. {current.evidenceFit.sourceClassificationUnknownCount} source classifications remain uncertain.</p></details>
        {:else}
          <p>{current.evidenceFit.supportedCriterionCount} supported of {current.evidenceFit.consideredCriterionCount} considered criteria · {current.evidenceFit.uncertainCriterionCount} uncertain · {current.evidenceFit.sourceUnknownCriterionCount} source-unknown</p><p>{current.evidenceFit.contextUnitCount} context units excluded from criteria counts. {current.evidenceFit.sourceClassificationUnknownCount} source classifications remain uncertain.</p>
        {/if}
      {/if}
      <p>All {current.completion?.catalogClauseCount} captured material units considered; {current.completion?.reviewedMaterialClauseCount} material units reviewed. Full candidate catalog supplied: {current.coverage.candidateSourceCount} sources.</p>
      <p>Complete material review. Eligibility is shown separately.</p>
      {#if current.coverage.metadataConsideration?.length}
        <details><summary>Captured field coverage</summary><ul>{#each current.coverage.metadataConsideration as field (field.fieldId)}<li>{field.path}: {field.status === 'represented_in_body' ? `Entire literal value is represented in captured body clauses ${field.bodyClauseIds.join(', ')}.` : 'Considered as a separate material unit; source classification remains uncertain.'}</li>{/each}</ul></details>
      {/if}
    {:else}
      <p class="review-label">Resume review · {strengths} {strengths === 1 ? 'strength' : 'strengths'} · {current.requirements.length - strengths} uncertain</p>
    {/if}
    <p>Model: {current.model === 'openai/gpt-6-luna' ? 'Luna' : 'Sol'} ({current.model})</p>
    {#if current.verification}
      {#if current.verification.version === 'opportunity-review-strength-verification/v2-partial-relevance' && !current.advisoryRelevance}
        <p>{current.verification.verifiedPartialCount} high-confidence partial confirmations across {current.evidenceFit?.consideredCriterionCount} considered criteria. These confirmations do not establish full criteria or imply absence of relevant evidence.</p>
      {/if}
      {#if current.verification.version === 'opportunity-review-strength-verification/v2-partial-relevance'}
        <p>JEV claim verification · {current.verification.strengthClaimCount + current.verification.seniorityClaimCount} strength/tenure claims · {current.verification.partialClaimCount} partial evidence checks ({current.verification.model})</p>
      {:else}
        <p>JEV claim verification · {current.verification.strengthClaimCount + current.verification.seniorityClaimCount} asserted claims ({current.verification.model})</p>
      {/if}
      <p>{current.verification.verifiedStrengthCount} of {current.verification.strengthClaimCount} strength claims established · {current.verification.verifiedSeniorityCount} of {current.verification.seniorityClaimCount} tenure/seniority claims established.</p>
      <p>Verification covers these cited claims. Eligibility is shown separately.</p>
    {/if}
    {#if current.mode === 'advisory'}
      <p>Advisory review of {current.requirements.length} {current.requirements.length === 1 ? 'criterion' : 'criteria'} using {current.coverage.candidateSourceCount} candidate {current.coverage.candidateSourceCount === 1 ? 'source' : 'sources'}. Overall fit remains unknown.</p>
      <p>{current.coverage.sourceComplete ? 'Captured source coverage is complete for this review.' : `Source coverage is incomplete: ${current.coverage.unresolvedClauseIds.length} unresolved source ${current.coverage.unresolvedClauseIds.length === 1 ? 'clause' : 'clauses'}.`}</p>
    {/if}
    <details open={!compact}>
      <summary>Strengths, uncertainty and seniority citations</summary>
      <ul>
        {#each current.requirements as requirement (requirement.id)}
          <li>
            <p class="criterion">{requirement.text}</p>
            {#if current.mode === 'complete_material'}<p>{requirement.sourceDisposition === 'context' ? 'Context clause; excluded from criteria counts.' : requirement.sourceClassification === 'possible_requirement_unknown' ? 'Possible requirement; source classification remains uncertain.' : 'Confirmed source requirement.'}</p>{/if}
            <p>{requirement.status === 'strength' ? 'Candidate evidence supports a strength for this criterion.' : current.verification?.partialSupportedRequirementIds?.includes(requirement.id) ? 'Partial evidence found; full criterion unverified.' : 'Candidate support remains uncertain.'}</p>
            <p>{requirement.seniority === 'supported' ? 'Seniority evidence is supported.' : requirement.seniority === 'uncertain' ? 'Seniority remains uncertain.' : 'Seniority is not applicable to this criterion.'}</p>
            <p>{requirement.note}</p>
            {#if current.advisoryRelevance}
              {@const relevance = current.advisoryRelevance.criterionProbabilityPairs.find((pair) => pair.requirementId === requirement.id)}
              {#if relevance}<p>{relevance.evidenceStatus === 'cited' ? `Supplied-evidence relevance: ${relevance.probability.toFixed(3)} (0–1). Full-criterion status is shown separately.` : 'Supplied evidence is unestablished for this criterion; candidate ability remains unknown.'}</p>{/if}
            {/if}
            {#if requirement.originalSolSuggestion}
              <details><summary>Original Sol model suggestion: {requirement.originalSolSuggestion.status === 'strength' ? 'strength' : 'uncertain'}{requirement.originalSolSuggestion.seniority === 'supported' ? ' · tenure supported' : ''}</summary><p>{requirement.originalSolSuggestion.note}</p><p>Model-suggested reasoning; current guarded support and uncertainty are shown above.</p></details>
            {/if}
            {#each requirement.postingCitations as cite}
              <blockquote><p>{cite.quote}</p><cite>{current.mode === 'complete_material' ? (cite.citationMode === 'whole_field' ? 'Captured posting field · whole field' : 'Captured posting · whole source clause') : 'Captured posting'}</cite><details><summary>Citation details</summary><p>{cite.citationMode === 'whole_field' ? `Field ${cite.sourceFieldPath}` : `Clause ${cite.clauseId}`}, characters {cite.start}–{cite.end}</p></details></blockquote>
            {/each}
            {#each requirement.candidateCitations as cite}
              <blockquote><p>{cite.quote}</p><cite>{cite.title}{current.mode === 'complete_material' ? ' · whole candidate fact' : ''}</cite><details><summary>Citation details</summary><p>Source {cite.sourceId} ({cite.kind}), characters {cite.start}–{cite.end}</p></details></blockquote>
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
