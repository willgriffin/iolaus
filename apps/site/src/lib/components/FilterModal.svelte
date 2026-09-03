<script lang="ts">
import type { FilterStore } from '../stores/filter.svelte';
import type { FilterMode, Skills } from '../types';
import Icon from './icons/Icon.svelte';

interface Props {
  open: boolean;
  onClose: () => void;
  skills: Skills;
  counts: Record<string, number>;
  filter: FilterStore;
}

const { open, onClose, skills, counts, filter }: Props = $props();

let stagedTags = $state(new Set<string>());
let stagedMode = $state<FilterMode>('or');
let search = $state('');
let collapsed = $state(new Set<string>());

$effect(() => {
  if (open) {
    stagedTags = new Set(filter.tags);
    stagedMode = filter.mode;
    search = '';
  }
});

function toggleSkill(id: string) {
  const next = new Set(stagedTags);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  stagedTags = next;
}

function toggleCollapse(id: string) {
  const next = new Set(collapsed);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed = next;
}

const q = $derived(search.toLowerCase());
function matchesSearch(label: string): boolean {
  return !q || label.toLowerCase().includes(q);
}

const sortedSkillGroups = $derived(
  [...skills.skillGroups].sort((a, b) => a.label.localeCompare(b.label)),
);
const sortedGroups = $derived(
  [...skills.groups].sort((a, b) => a.label.localeCompare(b.label)),
);

function apply() {
  filter.setTags(stagedTags);
  filter.setMode(stagedMode);
  onClose();
}
function clearAll() {
  stagedTags = new Set();
}
</script>

{#if open}
  <button
    type="button"
    class="modal-scrim"
    onclick={onClose}
    aria-label="Close filters overlay"
  ></button>
  <div class="filter-modal" role="dialog" aria-label="Filters">
    <header class="filter-modal-head">
      <div>
        <div class="filter-modal-title">Filters</div>
        <div class="filter-modal-sub">
          {stagedTags.size === 0 ? 'Tap to add filters' : `${stagedTags.size} selected`}
        </div>
      </div>
      <button class="filter-modal-close" onclick={onClose} aria-label="Close">
        <Icon name="close" />
      </button>
    </header>

    <div class="filter-modal-search">
      <Icon name="search" />
      <input
        type="text"
        placeholder="Search skills…"
        value={search}
        oninput={(e) => (search = (e.currentTarget as HTMLInputElement).value)}
      />
    </div>

    <div class="filter-modal-scroll">
      {#if stagedTags.size > 1}
        <div class="filter-modal-mode">
          <span>Match achievements with</span>
          <div class="mode-toggle">
            <button class:on={stagedMode === 'and'} onclick={() => (stagedMode = 'and')}
              >ALL</button
            >
            <button class:on={stagedMode === 'or'} onclick={() => (stagedMode = 'or')}>ANY</button>
          </div>
        </div>
      {/if}

      <div class="section-label">Skill Groups</div>
      <ul class="group-list">
        {#each sortedSkillGroups.filter((g) => matchesSearch(g.label)) as g (g.id)}
          {@const active = stagedTags.has(g.id)}
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
          <li
            class="group-item"
            class:active
            onclick={() => toggleSkill(g.id)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSkill(g.id)}
            role="button"
            tabindex="0"
          >
            <div class="group-row">
              <span class="group-label">{g.label}</span>
            </div>
            <div class="group-blurb">{g.blurb}</div>
          </li>
        {/each}
      </ul>

      <div class="section-label" style="margin-top: 18px">Individual Skills</div>
      {#each sortedGroups as group (group.id)}
        {@const filtered = group.skills
          .filter((s) => matchesSearch(s.label))
          .slice()
          .sort((a, b) => a.label.localeCompare(b.label))}
        {#if !(q && filtered.length === 0)}
          <div class="tree-group" class:collapsed={collapsed.has(group.id)}>
            <div
              class="tree-group-label"
              onclick={() => toggleCollapse(group.id)}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleCollapse(group.id)}
              role="button"
              tabindex="0"
            >
              <span class="chev"><Icon name="chev" /></span>
              {group.label}
            </div>
            <ul>
              {#each filtered as skill (skill.id)}
                {@const active = stagedTags.has(skill.id)}
                {@const count = counts[skill.id] || 0}
                {@const dim = !active && count === 0}
                <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                <li
                  class="tree-skill"
                  class:active
                  class:dim
                  onclick={() => toggleSkill(skill.id)}
                  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSkill(skill.id)}
                  role="button"
                  tabindex="0"
                >
                  <span>{skill.label}</span>
                  <span class="count">{count || ''}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      {/each}
    </div>

    <footer class="filter-modal-foot">
      <button class="footer-btn ghost" onclick={clearAll} disabled={stagedTags.size === 0}
        >Clear all</button
      >
      <button class="footer-btn primary" onclick={apply}>
        Apply{stagedTags.size > 0 ? ` (${stagedTags.size})` : ''}
      </button>
    </footer>
  </div>
{/if}
