<script lang="ts">
import { assessmentEligibilityLabels } from '$lib/opportunity-assessment-projection';
import type { SourceEligibilityUiProjection } from '$lib/server/opportunity-source-eligibility-projection';

let {
  projection,
  sourceContentFingerprint,
  sourceContentVersion,
  compact = false,
} = $props<{
  projection?: unknown;
  sourceContentFingerprint?: unknown;
  sourceContentVersion?: unknown;
  compact?: boolean;
}>();
const capturedLocation = $derived.by(() => {
  if (
    !projection ||
    typeof projection !== 'object' ||
    Array.isArray(projection)
  )
    return null;
  const captured = (projection as SourceEligibilityUiProjection)
    .capturedPostingLocation;
  if (
    !captured ||
    captured.sourceStatus !== 'current' ||
    typeof sourceContentFingerprint !== 'string' ||
    !sourceContentFingerprint ||
    !Number.isSafeInteger(sourceContentVersion) ||
    Number(sourceContentVersion) < 1 ||
    captured.sourceContentFingerprint !== sourceContentFingerprint ||
    captured.sourceContentVersion !== sourceContentVersion ||
    (captured.locationNotes !== null &&
      (typeof captured.locationNotes !== 'string' ||
        !captured.locationNotes.trim())) ||
    (captured.workMode !== null &&
      (typeof captured.workMode !== 'string' || !captured.workMode.trim())) ||
    (!captured.locationNotes && !captured.workMode)
  )
    return null;
  return captured;
});
const current = $derived.by(() => {
  if (
    !projection ||
    typeof projection !== 'object' ||
    Array.isArray(projection)
  )
    return null;
  const value = projection as SourceEligibilityUiProjection;
  if (
    value.sourceStatus !== 'current' ||
    typeof sourceContentFingerprint !== 'string' ||
    !sourceContentFingerprint ||
    !Number.isSafeInteger(sourceContentVersion) ||
    Number(sourceContentVersion) < 1 ||
    value.sourceContentFingerprint !== sourceContentFingerprint ||
    value.sourceContentVersion !== sourceContentVersion ||
    ![
      'eligible',
      'sponsorship_possible',
      'location_restriction',
      'unknown',
      'conflicting',
    ].includes(value.eligibilityBucket) ||
    !Array.isArray(value.conditionalPaths)
  )
    return null;
  if (
    !value.conditionalPaths.every(
      (path) =>
        path &&
        path.kind === 'sponsorship' &&
        ['offered', 'denied', 'conflicting'].includes(path.status) &&
        Array.isArray(path.facts) &&
        path.facts.length > 0 &&
        path.facts.every(
          (fact) =>
            fact &&
            typeof fact.key === 'string' &&
            fact.key &&
            Array.isArray(fact.citations) &&
            fact.citations.length > 0 &&
            fact.citations.every(
              (citation) =>
                citation &&
                typeof citation.quote === 'string' &&
                citation.quote.length > 0 &&
                typeof citation.hash === 'string' &&
                citation.hash &&
                Number.isSafeInteger(citation.start) &&
                Number.isSafeInteger(citation.end) &&
                citation.start >= 0 &&
                citation.end > citation.start &&
                citation.quote.length === citation.end - citation.start,
            ),
        ),
    )
  )
    return null;
  return compact &&
    value.eligibilityBucket === 'unknown' &&
    !value.conditionalPaths.length
    ? null
    : value;
});
function pathLabel(status: 'offered' | 'denied' | 'conflicting'): string {
  return status === 'offered'
    ? 'Sponsorship stated for this role'
    : status === 'denied'
      ? 'Sponsorship explicitly denied'
      : 'Sponsorship statements conflict';
}
</script>

{#if current || capturedLocation}
  <div class="source-eligibility" class:compact role="group" aria-label="Posting eligibility and conditional paths">
    {#if capturedLocation}
      {#if capturedLocation.locationNotes}<p>Captured posting location: <strong>{capturedLocation.locationNotes}</strong></p>{/if}
      {#if capturedLocation.workMode}<p>Captured work arrangement: <strong>{capturedLocation.workMode}</strong></p>{/if}
      <p>Captured location does not establish work authorization or candidate eligibility.</p>
    {/if}
    {#if current}
    <p>Posting work-location eligibility: <strong>{assessmentEligibilityLabels[current.eligibilityBucket]}</strong></p>
    {#if !compact && typeof current.reason === 'string' && current.reason}<p>{current.reason}</p>{/if}
    {#each current.conditionalPaths as path}
      <p class="path-label">{pathLabel(path.status)}</p>
      {#if !compact}<p>This statement does not establish work authorization or relocation approval.</p>{/if}
      <details open={!compact}>
        <summary>Posting citations</summary>
        {#each path.facts as fact}
          {#each fact.citations as citation}
            <blockquote>{citation.quote}<cite>Captured posting</cite><details><summary>Citation details</summary><p>Characters {citation.start}–{citation.end}</p></details></blockquote>
          {/each}
        {/each}
      </details>
    {/each}
    {/if}
  </div>
{/if}

<style>
.source-eligibility { min-width: 0; margin-top: 0.5rem; font-size: 0.875rem; line-height: 1.45; overflow-wrap: anywhere; }
.source-eligibility p { margin: 0.35rem 0; }
.path-label { font-weight: 600; }
.source-eligibility details { margin-top: 0.5rem; }
.source-eligibility summary { cursor: pointer; }
.source-eligibility blockquote { margin: 0.5rem 0; padding-left: 0.75rem; border-left: 2px solid var(--border-color, #d1d5db); }
.source-eligibility cite { display: block; font-style: normal; font-size: 0.75rem; opacity: 0.8; }
.compact { font-size: 0.75rem; }
</style>
