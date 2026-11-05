<script lang="ts">
import { discoveryEvidenceGaps } from '$lib/discovery-match';

let { reasons, compact = false }: { reasons: unknown; compact?: boolean } =
  $props();
const gaps = $derived(discoveryEvidenceGaps(reasons));
</script>

{#snippet gapList()}
  <p>Your evidence supports some requirements. The following still need confirmation:</p>
  {#if gaps.length}
    <ul>
      {#each gaps as gap}
        <li>{gap}</li>
      {/each}
    </ul>
  {:else}
    <p>Check the posting’s requirements before applying.</p>
  {/if}
{/snippet}

{#if compact}
  <details class="evidence-gaps">
    <summary>Review evidence gaps</summary>
    {@render gapList()}
  </details>
{:else}
  <section class="evidence-gaps" aria-label="Candidate evidence gaps">
    <h3>Evidence gaps</h3>
    {@render gapList()}
  </section>
{/if}

<style>
  .evidence-gaps { min-inline-size: 0; overflow-wrap: anywhere; }
  p, ul { margin-block: var(--smrt-spacing-2); }
  summary { cursor: pointer; }
</style>
