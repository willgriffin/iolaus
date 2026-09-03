<script lang="ts">
import type { FilterStore } from '../stores/filter.svelte';
import type { Skills } from '../types';
import GroupIcon from './icons/GroupIcon.svelte';
import Icon from './icons/Icon.svelte';

interface Props {
  skills: Skills;
  groupCounts: Record<string, number>;
  filter: FilterStore;
  openFilters: () => void;
  openFull: () => void;
}

const { skills, groupCounts, filter, openFilters, openFull }: Props = $props();
const sortedGroups = $derived(
  [...skills.skillGroups].sort((a, b) => a.label.localeCompare(b.label)),
);
</script>

<nav class="mobile-rail" aria-label="Skill filters">
  <button class="rail-menu" onclick={openFull} aria-label="Open full sidebar" title="Open sidebar">
    <Icon name="menu" />
  </button>
  <div class="rail-groups">
    {#each sortedGroups as g (g.id)}
      {@const active = filter.tags.has(g.id)}
      {@const count = groupCounts[g.id] || 0}
      <button
        class="rail-tile"
        class:active
        class:dim={count === 0 && !active}
        onclick={() => filter.toggle(g.id)}
        title={g.label}
      >
        <span class="rail-tile-ico"><GroupIcon id={g.id} /></span>
        <span class="rail-tile-label">{g.label}</span>
      </button>
    {/each}
  </div>
  <button
    class="rail-filters"
    class:has-active={filter.tags.size}
    onclick={openFilters}
    aria-label="Open filters"
    title="More filters"
  >
    <Icon name="sliders" />
    <span class="rail-tile-label">Filters</span>
    {#if filter.tags.size > 0}
      <span class="rail-badge">{filter.tags.size}</span>
    {/if}
  </button>
</nav>
