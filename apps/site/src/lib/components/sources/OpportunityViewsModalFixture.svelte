<script lang="ts">
import type { AdminRecord } from '$lib/admin/dock';

let {
  open = $bindable(false),
  singleOpportunity,
}: { open?: boolean; singleOpportunity?: AdminRecord | null } = $props();
</script>
{#if open}<div role="dialog" aria-label="Opportunity review">{singleOpportunity?.title}</div>{/if}
