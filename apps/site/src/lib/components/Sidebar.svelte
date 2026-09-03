<script lang="ts">
import { getThemeContext } from '@happyvertical/smrt-ui/themes';
import type { FilterStore } from '../stores/filter.svelte';
import type { Profile, Skills } from '../types';
import Icon from './icons/Icon.svelte';

interface Props {
  profile: Profile;
  skills: Skills;
  counts: Record<string, number>;
  groupCounts: Record<string, number>;
  activeMemberSkills: Set<string>;
  filter: FilterStore;
  search: string;
  setSearch: (s: string) => void;
  isMobileOpen: boolean;
  closeMobile?: () => void;
}

const {
  profile,
  skills,
  counts,
  groupCounts,
  activeMemberSkills,
  filter,
  search,
  setSearch,
  isMobileOpen,
  closeMobile,
}: Props = $props();

let collapsed = $state(new Set<string>());
const themeContext = getThemeContext();
const theme = $derived<'light' | 'dark'>(
  themeContext.state.isDark ? 'dark' : 'light',
);

function toggleGroup(id: string) {
  const next = new Set(collapsed);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed = next;
}

function toggleTheme() {
  themeContext.toggleColorScheme();
}

const sortedSkillGroups = $derived(
  [...skills.skillGroups].sort((a, b) => a.label.localeCompare(b.label)),
);
const sortedGroups = $derived(
  [...skills.groups].sort((a, b) => a.label.localeCompare(b.label)),
);
const q = $derived(search.toLowerCase());
function matchesSearch(label: string): boolean {
  return !q || label.toLowerCase().includes(q);
}
</script>

{#if isMobileOpen && closeMobile}
  <button
    type="button"
    class="sidebar-scrim"
    onclick={closeMobile}
    aria-label="Close sidebar overlay"
  ></button>
{/if}

<aside class="sidebar" class:mobile-open={isMobileOpen}>
  {#if closeMobile}
    <button class="sidebar-close-mobile" onclick={closeMobile} aria-label="Close sidebar">
      <Icon name="close" />
    </button>
  {/if}

  <div class="sidebar-header">
    <div class="brand"><span class="brand-name">{profile.name}</span></div>
    <div class="brand-role">{profile.title}</div>
    <ul class="contact-list">
      <li>
        <a
          class="contact-icon"
          href={`mailto:${profile.email}`}
          aria-label="Email {profile.email}"
          title={profile.email}
        >
          <Icon name="email" />
        </a>
      </li>
      {#each profile.links as l (l.href)}
        {@const kind = l.href.includes('linkedin')
          ? 'linkedin'
          : l.href.includes('github')
            ? 'github'
            : null}
        {#if kind}
          <li>
            <a
              class="contact-icon"
              href={l.href}
              target="_blank"
              rel="noopener"
              aria-label={l.label}
              title={l.label}
            >
              <Icon name={kind} />
            </a>
          </li>
        {/if}
      {/each}
    </ul>
  </div>

  <div class="sidebar-scroll">
    <div class="section-label">Skill Groups</div>
    <ul class="group-list">
      {#each sortedSkillGroups as g (g.id)}
        {@const active = filter.tags.has(g.id)}
        {@const count = groupCounts[g.id] || 0}
        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
        <li
          class="group-item"
          class:active
          class:dim={count === 0 && !active}
          onclick={() => filter.toggle(g.id)}
          onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && filter.toggle(g.id)}
          role="button"
          tabindex="0"
          title={g.blurb}
        >
          <div class="group-row">
            <span class="group-label">{g.label}</span>
            <span class="count">{count || ''}</span>
          </div>
          <div class="group-blurb">{g.blurb}</div>
        </li>
      {/each}
    </ul>

    <div class="section-label" style="margin-top: 22px">Individual Skills</div>
    <div class="search">
      <Icon name="search" />
      <input
        type="text"
        placeholder="Filter skills…"
        value={search}
        oninput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
      />
      {#if search}
        <button
          type="button"
          class="kbd-clear"
          onclick={() => setSearch('')}
          aria-label="Clear search"
        >
          <kbd>esc</kbd>
        </button>
      {/if}
    </div>

    <div class="filter-bar" class:empty={!filter.tags.size}>
      <div class="filter-status">
        <span class="filter-count">{filter.tags.size}</span>
        <span
          >{filter.tags.size
            ? `filter${filter.tags.size > 1 ? 's' : ''} active`
            : 'no filters'}</span
        >
      </div>
      {#if filter.tags.size > 1}
        <div class="mode-toggle" title="Match achievements that contain…">
          <button class:on={filter.mode === 'and'} onclick={() => filter.setMode('and')}
            >AND</button
          >
          <button class:on={filter.mode === 'or'} onclick={() => filter.setMode('or')}>OR</button>
        </div>
      {:else if filter.tags.size === 1}
        <button class="clear-btn" onclick={() => filter.clear()}>clear</button>
      {/if}
      {#if filter.tags.size > 1}
        <button class="clear-btn" onclick={() => filter.clear()}>clear</button>
      {/if}
    </div>

    {#each sortedGroups as group (group.id)}
      {@const filteredSkills = group.skills
        .filter((s) => matchesSearch(s.label))
        .slice()
        .sort((a, b) => a.label.localeCompare(b.label))}
      {#if !(q && filteredSkills.length === 0)}
        <div class="tree-group" class:collapsed={collapsed.has(group.id)}>
          <div
            class="tree-group-label"
            onclick={() => toggleGroup(group.id)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleGroup(group.id)}
            role="button"
            tabindex="0"
          >
            <span class="chev"><Icon name="chev" /></span>
            {group.label}
          </div>
          <ul>
            {#each filteredSkills as skill (skill.id)}
              {@const count = counts[skill.id] || 0}
              {@const active = filter.tags.has(skill.id)}
              {@const highlighted = !active && activeMemberSkills.has(skill.id)}
              {@const dim = !active && !highlighted && count === 0}
              <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
              <li
                class="tree-skill"
                class:active
                class:highlighted
                class:dim
                onclick={() => filter.toggle(skill.id)}
                onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && filter.toggle(skill.id)}
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

    <div class="sidebar-foot">
      <button type="button" class="print-link" onclick={() => window.print()}>
        ↓ Print
      </button>
      <button class="theme-toggle" onclick={toggleTheme}>
        {#if theme === 'light'}
          <Icon name="moon" /> dark mode
        {:else}
          <Icon name="sun" /> light mode
        {/if}
      </button>
    </div>
  </div>
</aside>

<style>
  .kbd-clear,
  .print-link {
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .print-link:hover {
    color: var(--accent-ink);
  }
  :global(.contact-list) {
    flex-direction: row !important;
    gap: 6px !important;
    margin-top: 4px;
  }
  :global(.contact-list li) {
    display: inline-flex;
  }
  .contact-icon {
    color: var(--ink-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    transition:
      color 0.15s,
      background 0.15s;
  }
  .contact-icon:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }
</style>
