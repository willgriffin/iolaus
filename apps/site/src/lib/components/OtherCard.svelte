<script lang="ts">
import type { FilterState, OtherRole, Skill } from '../types';
import { type GroupMap, matches } from '../utils/filter';
import Highlight from './Highlight.svelte';
import Tag from './Tag.svelte';

interface Props {
  item: OtherRole;
  skillMap: Record<string, Skill>;
  groupMap: GroupMap;
  filter: FilterState;
  toggleTag: (id: string) => void;
  search: string;
}

const { item, skillMap, groupMap, filter, toggleTag, search }: Props = $props();
const match = $derived(
  matches(item.tags || [], filter.tags, groupMap, filter.mode),
);
</script>

<div class="other-card" class:dimmed={!match}>
  <h4 class="other-role">{item.role}</h4>
  <div class="other-co">
    <span>{item.company}</span> <span class="period">· {item.period}</span>
  </div>
  {#if item.body}
    <p class="other-body"><Highlight text={item.body} query={search} /></p>
  {/if}
  {#if item.tags && item.tags.length > 0}
    <div class="tags">
      {#each item.tags as tagId (tagId)}
        <Tag
          label={skillMap[tagId]?.label || tagId}
          active={filter.tags.has(tagId)}
          onclick={() => toggleTag(tagId)}
        />
      {/each}
    </div>
  {/if}
</div>
