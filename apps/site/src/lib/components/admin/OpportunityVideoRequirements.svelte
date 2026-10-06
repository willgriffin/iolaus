<script lang="ts">
import Clapperboard from '@lucide/svelte/icons/clapperboard';
import Video from '@lucide/svelte/icons/video';
import type {
  OpportunityVideoRequirements,
  VideoRequirementFinding,
} from '$lib/server/opportunity-video-requirements';

let { requirements, compact = false } = $props<{
  requirements?: unknown;
  compact?: boolean;
}>();
const present = $derived.by(() => {
  if (
    !requirements ||
    typeof requirements !== 'object' ||
    Array.isArray(requirements)
  )
    return [];
  const value = requirements as OpportunityVideoRequirements;
  if (
    value.version !== 'opportunity-video-requirements/v2' ||
    !value.provenance ||
    typeof value.provenance.model !== 'string' ||
    !value.provenance.model ||
    typeof value.provenance.provider !== 'string' ||
    !value.provenance.provider
  )
    return [];
  return [
    { finding: value.recordedSubmission, kind: 'recorded_application_video' },
    { finding: value.liveInterview, kind: 'live_video_interview' },
  ].flatMap(({ finding, kind }) => {
    if (
      !finding ||
      finding.kind !== kind ||
      !['required', 'optional'].includes(finding.status) ||
      !Array.isArray(finding.evidence) ||
      !finding.evidence.length ||
      !finding.evidence.every(
        (citation) =>
          citation &&
          typeof citation.quote === 'string' &&
          citation.quote.length > 0 &&
          Number.isSafeInteger(citation.spanStart) &&
          Number.isSafeInteger(citation.spanEnd) &&
          citation.spanStart >= 0 &&
          citation.spanEnd > citation.spanStart &&
          citation.decision === finding.status &&
          Number.isFinite(citation.probability) &&
          citation.probability >= 0.85 &&
          citation.probability <= 1 &&
          Number.isFinite(citation.confidence) &&
          citation.confidence >= 0.85 &&
          citation.confidence <= 1,
      )
    )
      return [];
    return [finding];
  });
});
function indicatorLabel(finding: VideoRequirementFinding): string {
  return `${finding.kind === 'recorded_application_video' ? 'Recorded application video' : 'Live video interview'}: ${finding.status === 'optional' ? 'optional' : 'required'}`;
}
</script>

{#if present.length}
  <div class="video-requirements" class:compact role="group" aria-label="Video application steps">
    {#each present as finding (finding.kind)}
      {#if compact}
        <span class="compact-indicator" role="img" title={indicatorLabel(finding)} aria-label={indicatorLabel(finding)}>
          {#if finding.kind === 'recorded_application_video'}
            <Clapperboard size={18} strokeWidth={2} />
          {:else}
            <Video size={18} strokeWidth={2} />
          {/if}
        </span>
      {:else}
        <details class="video-indicator">
          <!-- svelte-ignore a11y_no_redundant_roles (The triage drag guard requires an explicit button role.) -->
          <summary role="button" title={indicatorLabel(finding)} aria-label={indicatorLabel(finding)}>
            {#if finding.kind === 'recorded_application_video'}
              <Clapperboard size={18} strokeWidth={2} />
            {:else}
              <Video size={18} strokeWidth={2} />
            {/if}
          </summary>
          {#each finding.evidence as citation}
            <blockquote>{citation.quote}<cite>Captured posting</cite><details><!-- svelte-ignore a11y_no_redundant_roles (The triage drag guard requires an explicit button role.) --><summary role="button">Citation details</summary><p>Characters {citation.spanStart}–{citation.spanEnd}</p></details></blockquote>
          {/each}
        </details>
      {/if}
    {/each}
  </div>
{/if}

<style>
.video-requirements { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.5rem; min-width: 0; margin-top: 0.5rem; font-size: 0.875rem; line-height: 1.45; overflow-wrap: anywhere; }
.video-indicator { min-width: 0; }
.compact-indicator { display: inline-flex; align-items: center; padding: 0.25rem; }
.video-indicator > summary { display: inline-flex; align-items: center; cursor: pointer; list-style: none; border-radius: 0.25rem; padding: 0.25rem; }
.video-indicator > summary::-webkit-details-marker { display: none; }
.video-indicator > summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.video-requirements blockquote { margin: 0.5rem 0; padding-left: 0.75rem; border-left: 2px solid var(--border-color, #d1d5db); }
.video-requirements cite { display: block; font-style: normal; font-size: 0.75rem; opacity: 0.8; }
.compact { font-size: 0.75rem; }
</style>
