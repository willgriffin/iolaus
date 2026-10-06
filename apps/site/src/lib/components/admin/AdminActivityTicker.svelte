<script lang="ts">
import {
  type ShellActivity,
  SystemStatusChips,
} from '@happyvertical/smrt-svelte/workspace';

let {
  activities,
  statuses = ['queued', 'running'],
  label = 'Active processes',
}: {
  activities: ShellActivity[];
  statuses?: ShellActivity['status'][];
  label?: string;
} = $props();

// The authenticated layout feed owns these activities. This only presents them.
const active = $derived(
  activities.filter((activity) => statuses.includes(activity.status)),
);
const chips = $derived(
  active.map((activity) => ({
    id: activity.id,
    label: activity.label,
    value:
      typeof activity.progress === 'number'
        ? `${activity.status} · ${Math.round(activity.progress)}%`
        : activity.status,
    ...(activity.detailHref ? { href: activity.detailHref } : {}),
  })),
);
</script>

<div class="activity-ticker" aria-label={label}>
  {#if chips.length}
    <SystemStatusChips {chips} />
  {:else}
    <span>No active processes</span>
  {/if}
</div>

<style>
.activity-ticker { min-inline-size: 0; flex: 1; font-size: 0.75rem; }
</style>
