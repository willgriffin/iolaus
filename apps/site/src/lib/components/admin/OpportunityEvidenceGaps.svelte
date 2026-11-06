<script lang="ts">
import {
  type DiscoveryEvidenceExplanation,
  type DiscoveryEvidenceItem,
  discoveryEvidenceGaps,
} from '$lib/discovery-match';

let {
  reasons,
  explanation,
  compact = false,
  qualified = false,
  showPrivateExcerpts = false,
}: {
  reasons: unknown;
  explanation?: unknown;
  compact?: boolean;
  qualified?: boolean;
  showPrivateExcerpts?: boolean;
} = $props();

const evidence = $derived(
  explanation as DiscoveryEvidenceExplanation | undefined,
);
const gaps = $derived(
  evidence?.gaps ??
    discoveryEvidenceGaps(reasons).map((message) => ({ message })),
);
</script>

{#snippet evidenceList(items: DiscoveryEvidenceItem[])}
  <ul>
    {#each items as item}
      <li>
        {item.message}
        {#if showPrivateExcerpts && item.excerpts?.length}
          {#each item.excerpts as excerpt}
            <blockquote>{excerpt}</blockquote>
          {/each}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet explanationContent()}
  {#if evidence?.interpretation}
    <p class="interpretation">{evidence.interpretation} Evidence gaps reflect the material checked so far.</p>
  {/if}
  {#if evidence?.supported.length}
    <h3>Recognized support</h3>
    {@render evidenceList(evidence.supported)}
  {:else if qualified}
    <p>The posting meets your confirmed matching criteria.</p>
  {/if}
  {#if !qualified}
    <h3>Still needs confirmation</h3>
    {#if gaps.length}
      {@render evidenceList(gaps)}
    {:else}
      <p>Check the posting’s requirements before applying.</p>
    {/if}
  {/if}
  {#if evidence?.applicationSteps?.length}
    <h3>Application steps</h3>
    {@render evidenceList(evidence.applicationSteps)}
  {/if}
{/snippet}

{#if compact}
  <details class="evidence-gaps">
    <summary>Review evidence gaps</summary>
    {@render explanationContent()}
  </details>
{:else}
  <section class="evidence-gaps" aria-label={qualified ? 'Candidate evidence' : 'Candidate evidence gaps'}>
    {@render explanationContent()}
  </section>
{/if}

<style>
  .evidence-gaps { min-inline-size: 0; overflow-wrap: anywhere; font-size: var(--text-body, 16px); }
  h3 { font-size: var(--text-title, 18px); }
  p, ul { margin-block: var(--smrt-spacing-2); }
  blockquote { margin: var(--smrt-spacing-2) 0; padding-inline-start: var(--smrt-spacing-3); border-inline-start: 2px solid currentColor; }
  .interpretation { font-size: var(--text-secondary, 14px); }
  summary { cursor: pointer; }
</style>
