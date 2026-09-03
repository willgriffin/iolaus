<script lang="ts">
import type { Achievement, FilterState, Skill } from '../types';
import { type GroupMap, matches } from '../utils/filter';
import Highlight from './Highlight.svelte';
import Tag from './Tag.svelte';

interface Props {
  ach: Achievement;
  skillMap: Record<string, Skill>;
  groupMap: GroupMap;
  filter: FilterState;
  toggleTag: (id: string) => void;
  search: string;
  showTitle?: boolean;
}

const {
  ach,
  skillMap,
  groupMap,
  filter,
  toggleTag,
  search,
  showTitle = true,
}: Props = $props();
const match = $derived(matches(ach.tags, filter.tags, groupMap, filter.mode));
</script>

<div class="ach" class:match class:hidden={!match}>
  {#if showTitle && ach.title}
    <h4 class="ach-title"><Highlight text={ach.title} query={search} /></h4>
  {/if}
  <p class="ach-body"><Highlight text={ach.body} query={search} /></p>
  {#if ach.metric}
    <div class="metric">{ach.metric}</div>
  {/if}
  {#if ach.tags.length > 0}
    <div class="tags">
      {#each ach.tags as tagId (tagId)}
        <Tag
          label={skillMap[tagId]?.label || tagId}
          active={filter.tags.has(tagId)}
          onclick={() => toggleTag(tagId)}
        />
      {/each}
    </div>
  {/if}
</div>
