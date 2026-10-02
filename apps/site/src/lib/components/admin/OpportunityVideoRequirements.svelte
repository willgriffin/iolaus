<script lang="ts">
import type {
  OpportunityVideoRequirements,
  VideoRequirementFinding,
} from '$lib/server/opportunity-video-requirements';

let { requirements, compact = false } = $props<{
  requirements?: unknown;
  compact?: boolean;
}>();
const current = $derived.by(() => {
  if (
    !requirements ||
    typeof requirements !== 'object' ||
    Array.isArray(requirements)
  )
    return null;
  const value = requirements as OpportunityVideoRequirements;
  return value.version === 'opportunity-video-requirements/v2' &&
    value.recordedSubmission &&
    value.liveInterview &&
    [value.recordedSubmission, value.liveInterview].every(
      (finding) =>
        ['required', 'optional', 'explicitly_not_required', 'unknown'].includes(
          finding.status,
        ) &&
        Array.isArray(finding.evidence) &&
        finding.evidence.every(
          (citation) =>
            typeof citation.quote === 'string' &&
            Number.isSafeInteger(citation.spanStart) &&
            Number.isSafeInteger(citation.spanEnd) &&
            citation.spanStart >= 0 &&
            citation.spanEnd > citation.spanStart,
        ),
    )
    ? value
    : null;
});
function status(finding: VideoRequirementFinding): string {
  if (
    !current?.provenance ||
    !Array.isArray(finding.evidence) ||
    !finding.evidence.length ||
    !finding.evidence.every(
      (citation) =>
        citation.decision === finding.status &&
        citation.probability >= 0.85 &&
        citation.confidence >= 0.85,
    )
  )
    return 'Unknown';
  switch (finding.status) {
    case 'required':
      return 'Required';
    case 'optional':
      return 'Optional';
    case 'explicitly_not_required':
      return 'Explicitly not required';
    default:
      return 'Unknown';
  }
}
</script>
{#if current}
  <div class="video-requirements" class:compact role="group" aria-label="Video application steps">
    <p>Recorded application video: <strong>{status(current.recordedSubmission)}</strong></p>
    <p>Live video interview: <strong>{status(current.liveInterview)}</strong></p>
    {#if !compact}
      {#each [current.recordedSubmission, current.liveInterview] as finding}
        {#if status(finding) === 'Unknown'}<p>The captured posting does not give a verified answer for this video step.</p>{/if}
        {#if current.provenance}
          {#each finding.evidence as citation}
            <blockquote>{citation.quote}<cite>Captured posting</cite><details><summary>Citation details</summary><p>Characters {citation.spanStart}–{citation.spanEnd}</p></details></blockquote>
          {/each}
        {/if}
      {/each}
    {/if}
  </div>
{/if}
<style>
.video-requirements { min-width: 0; margin-top: 0.75rem; font-size: 0.875rem; line-height: 1.45; overflow-wrap: anywhere; }
.video-requirements p { margin: 0.35rem 0; }
.video-requirements blockquote { margin: 0.5rem 0; padding-left: 0.75rem; border-left: 2px solid var(--border-color, #d1d5db); }
.video-requirements cite { display: block; font-style: normal; font-size: 0.75rem; opacity: 0.8; }
.compact { font-size: 0.75rem; }
</style>
