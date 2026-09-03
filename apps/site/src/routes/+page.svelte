<script lang="ts">
import { onMount } from 'svelte';
import { base } from '$app/paths';
import FilterModal from '$lib/components/FilterModal.svelte';
import InterviewPanel from '$lib/components/InterviewPanel.svelte';
import Icon from '$lib/components/icons/Icon.svelte';
import MobileRail from '$lib/components/MobileRail.svelte';
import OtherCard from '$lib/components/OtherCard.svelte';
import Position from '$lib/components/Position.svelte';
import Sidebar from '$lib/components/Sidebar.svelte';
import { FilterStore } from '$lib/stores/filter.svelte';
import type {
  Achievement,
  Experience,
  Profile,
  Position as ResumePosition,
  Skill,
  Skills,
} from '$lib/types';
import { detectBuiltInAI } from '$lib/utils/ai';
import { matches } from '$lib/utils/filter';

let { data } = $props<{
  data: {
    experience: Experience;
    profile: Profile;
    skills: Skills;
  };
}>();

let profile: Profile = $derived(data.profile);
let experience: Experience = $derived(data.experience);
let skills: Skills = $derived(data.skills);

const filter = new FilterStore();
let search = $state('');
let interviewOpen = $state(false);
let filtersOpen = $state(false);
let mobileSidebarOpen = $state(false);
let aiAvailable = $state(false);

onMount(() => {
  const unsub = filter.bindHashListener();
  detectBuiltInAI().then((d) => {
    aiAvailable = !!d;
  });
  return () => unsub();
});

const skillMap = $derived.by(() => {
  const m: Record<string, Skill> = {};
  for (const g of skills.groups) for (const s of g.skills) m[s.id] = s;
  return m;
});

const groupMap = $derived.by(() => {
  const m: Record<string, (typeof skills.skillGroups)[number]> = {};
  for (const g of skills.skillGroups) m[g.id] = g;
  return m;
});

function labelFor(id: string): string {
  return groupMap[id]?.label || skillMap[id]?.label || id;
}

function positionAchievements(position: ResumePosition): Achievement[] {
  return [
    ...position.achievements,
    ...(position.projects ?? []).flatMap((project) => project.achievements),
  ];
}

const activeMemberSkills = $derived.by(() => {
  const s = new Set<string>();
  for (const id of filter.tags) {
    if (groupMap[id]) for (const sk of groupMap[id].skills) s.add(sk);
  }
  return s;
});

const counts = $derived.by(() => {
  const c: Record<string, number> = {};
  const tally = (tags: string[]) => {
    for (const t of tags) c[t] = (c[t] || 0) + 1;
  };
  for (const p of experience.positions)
    for (const a of positionAchievements(p)) tally(a.tags);
  for (const o of experience.other) tally(o.tags || []);
  return c;
});

const groupCounts = $derived.by(() => {
  const c: Record<string, number> = {};
  const allAch: string[][] = [
    ...experience.positions.flatMap((p) =>
      positionAchievements(p).map((a) => a.tags),
    ),
    ...experience.other.map((o) => o.tags || []),
  ];
  for (const g of skills.skillGroups) {
    const set = new Set(g.skills);
    c[g.id] = allAch.filter((tags) => tags.some((t) => set.has(t))).length;
  }
  return c;
});

function toggleTag(id: string) {
  filter.toggle(id);
}

const totalMatches = $derived(
  experience.positions.reduce(
    (sum, p) =>
      sum +
      positionAchievements(p).filter((a) =>
        matches(a.tags, filter.tags, groupMap, filter.mode),
      ).length,
    0,
  ),
);
const anyFilter = $derived(filter.tags.size > 0);

const sortedPositions = $derived(
  [...experience.positions].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)),
);
</script>

<svelte:head>
  <title>{profile.name} — {profile.title}</title>
  <meta name="description" content={profile.summary} />
</svelte:head>

<div class="app">
  <Sidebar
    {profile}
    {skills}
    {counts}
    {groupCounts}
    {activeMemberSkills}
    {filter}
    {search}
    setSearch={(s) => (search = s)}
    isMobileOpen={mobileSidebarOpen}
    closeMobile={() => (mobileSidebarOpen = false)}
  />
  <MobileRail
    {skills}
    {groupCounts}
    {filter}
    openFilters={() => (filtersOpen = true)}
    openFull={() => (mobileSidebarOpen = true)}
  />
  <FilterModal
    open={filtersOpen}
    onClose={() => (filtersOpen = false)}
    {skills}
    {counts}
    {filter}
  />

  <main class="main">
    {#if aiAvailable}
      <button
        class="interview-btn"
        onclick={() => (interviewOpen = true)}
        title="Ask the resume questions, powered by Chrome's on-device AI"
      >
        <span class="interview-btn-dot"></span>
        Interview {profile.name.split(' ')[0]}
        <span class="interview-btn-kbd">↵</span>
      </button>
    {/if}

    <div class="bar bar-crumbs">
      <div class="crumbs">
        <span>resume</span>
        <span class="sep">/</span>
        <a class="crumb-email" href={`mailto:${profile.email}`}>
          {profile.name} &lt;{profile.email}&gt;
        </a>
        <a
          class="crumb-pdf"
          href="{base}/resume.pdf"
          download="resume.pdf"
          aria-label="Download resume PDF"
          title="Download resume PDF"
        >
          <Icon name="pdf" />
        </a>
        {#if anyFilter}
          <span class="sep">·</span>
          <span style="color: var(--ink-4)">
            {totalMatches} match{totalMatches === 1 ? '' : 'es'}
          </span>
        {/if}
      </div>
    </div>

    <div class="summary-wrap" class:is-collapsed={anyFilter} aria-hidden={anyFilter}>
      <div class="summary-inner">
        <p class="summary">{profile.summary}</p>
      </div>
    </div>

    <div class="bar bar-section" class:bar-last={!anyFilter}>
      <div class="section-head section-head-bar">
        <h2>Experience</h2>
        <span class="anchor">#experience</span>
      </div>
    </div>

    {#if anyFilter}
      <div class="bar bar-filters bar-last">
        <div class="active-filters" role="status">
          <span class="active-filters-label">Filtered by</span>
          <div class="active-filters-list">
            {#each [...filter.tags] as t (t)}
              <span class="tag-mini" class:is-group={groupMap[t]}>
                {#if groupMap[t]}<span class="tag-mini-kind">group:</span>{/if}
                {labelFor(t)}
                <button onclick={() => toggleTag(t)} aria-label="remove filter">×</button>
              </span>
            {/each}
          </div>
          <button class="active-filters-clear" onclick={() => filter.clear()}>clear</button>
        </div>
      </div>
    {/if}

    {#if anyFilter && totalMatches === 0}
      <div class="empty-state">
        <h3>No achievements match this combination.</h3>
        <p>Try switching to OR, or removing a filter.</p>
      </div>
    {/if}

    <section class="section" id="experience" data-screen-label="Experience">
      {#each sortedPositions as p (p.id)}
        <Position
          position={p}
          {skillMap}
          {groupMap}
          {filter}
          {toggleTag}
          {search}
        />
      {/each}
    </section>

    {#if experience.other.some((o) => matches(o.tags || [], filter.tags, groupMap, filter.mode))}
      <section class="section" id="other" data-screen-label="Other Experience">
        <div class="section-head">
          <h2>Other Experience</h2>
          <span class="anchor">#other</span>
        </div>
        <div class="other-grid">
          {#each experience.other as item, i (i)}
            <OtherCard
              {item}
              {skillMap}
              {groupMap}
              {filter}
              {toggleTag}
              {search}
            />
          {/each}
        </div>
      </section>
    {/if}

    <section class="section" id="education" data-screen-label="Education">
      <div class="section-head">
        <h2>Education & Certifications</h2>
        <span class="anchor">#education</span>
      </div>
      <ul class="edu-list">
        {#each experience.education as e, i (i)}
          <li class="edu-item">
            <div>
              <div class="edu-title">{e.title}</div>
              {#if e.institution}<div class="edu-inst">{e.institution}</div>{/if}
            </div>
            <div class="edu-detail">{e.detail}</div>
          </li>
        {/each}
      </ul>
    </section>
  </main>

  <InterviewPanel
    open={interviewOpen}
    onClose={() => (interviewOpen = false)}
    {profile}
    {experience}
    {skills}
  />
</div>

<style>
  .crumb-pdf {
    color: var(--ink-4);
    margin-left: 8px;
    padding: 2px 4px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    transition: color 0.1s, background 0.1s;
  }
  .crumb-pdf:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }
</style>
