<script lang="ts">
import { type Snippet, untrack } from 'svelte';
import { canonicalSkillSlug } from '$lib/skill-canonical';
import { CAREER_SKILL_CATEGORIES } from '$lib/skill-vocabulary-data';

let {
  q = '',
  queryName = 'q',
  skills = [],
  selectedSkills = [],
  children,
  filterMode = false,
}: {
  q?: string;
  queryName?: string;
  skills?: { value: string; label: string; count: number }[];
  selectedSkills?: string[];
  children?: Snippet;
  filterMode?: boolean;
} = $props();
let query = $state(untrack(() => q));
$effect(() => {
  query = q;
});
let selected = $state<string[]>([...new Set(untrack(() => selectedSkills))]);
$effect(() => {
  selected = [...new Set(selectedSkills)];
});
let dialog: HTMLDialogElement;
let draft = $state<string[]>([]);
let catalogQuery = $state('');
let category = $state('all');
const catalog = CAREER_SKILL_CATEGORIES.flatMap((group) =>
  group.skills.map((label) => ({
    value: canonicalSkillSlug(label),
    label,
    category: group.id,
    count: 0,
  })),
);
const options = $derived.by(() => {
  const entries = new Map<
    string,
    { value: string; label: string; category: string; count: number }
  >();
  for (const skill of catalog)
    if (!entries.has(skill.value)) entries.set(skill.value, skill);
  for (const skill of skills)
    entries.set(skill.value, {
      ...skill,
      category: entries.get(skill.value)?.category ?? 'other',
    });
  for (const value of [...selectedSkills, ...selected, ...draft]) {
    if (!entries.has(value))
      entries.set(value, { value, label: value, category: 'other', count: 0 });
  }
  return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label));
});
const visible = $derived(
  options.filter(
    (skill) =>
      (category === 'all' || skill.category === category) &&
      `${skill.label} ${skill.value}`
        .toLowerCase()
        .includes(catalogQuery.trim().toLowerCase()),
  ),
);
const label = (value: string) =>
  options.find((skill) => skill.value === value)?.label ?? value;
function openCatalog() {
  draft = [...selected];
  catalogQuery = '';
  category = 'all';
  dialog.showModal();
}
function applySkills() {
  selected = [...draft];
  dialog.close();
}
</script>

<form action="/opportunities" method="GET" class="opportunity-search" class:filter-mode={filterMode} aria-label="Opportunity search">
  <label class="search-label" for="opportunity-query">Search opportunities</label>
  <div class="search-row">
    <input id="opportunity-query" type="search" name={queryName} bind:value={query} maxlength={queryName === 'search' ? 1000 : 200} placeholder="Role, skill, or company" />
    {#if !filterMode}<button type="submit">Search</button>{/if}
  </div>
  <div class="skill-filters">
    <button type="button" aria-haspopup="dialog" onclick={openCatalog}>Add skills</button>
    {#each selected as skill (skill)}
      <input type="hidden" name="skills" value={skill} />
      <button class="skill-chip" type="button" aria-label={`Remove skill ${label(skill)}`} onclick={() => { selected = selected.filter(value => value !== skill); }}>{label(skill)} <span aria-hidden="true">×</span></button>
    {/each}
  </div>
  {#if children}<div class="other-filters">{@render children()}</div>{/if}
  {#if filterMode}<div class="filter-footer"><a href="/opportunities/?start=1&view=list">Clear all filters</a><button class="apply" type="submit">Apply filters</button></div>{/if}
</form>

<dialog bind:this={dialog} aria-labelledby="skill-catalog-title">
  <div class="catalog-header"><div><h2 id="skill-catalog-title">Skill catalog</h2><p>Browse skills across industries. Select up to 50 to filter opportunities.</p></div><button type="button" aria-label="Close skill catalog" onclick={() => dialog.close()}>×</button></div>
  <div class="catalog-controls">
    <div><label for="catalog-query">Find a skill</label><input id="catalog-query" type="search" bind:value={catalogQuery} placeholder="Try patient care, welding, or bookkeeping" /></div>
    <div><label for="catalog-category">Category</label><select id="catalog-category" bind:value={category}><option value="all">All categories</option>{#each CAREER_SKILL_CATEGORIES as group}<option value={group.id}>{group.label}</option>{/each}<option value="other">Other listed skills</option></select></div>
  </div>
  <p class="catalog-note">Counts show jobs in the current results. Some catalog skills may have no listings yet.</p>
  <fieldset class="catalog-list"><legend>Choose skills</legend>
    {#each visible as skill (skill.value)}
      <label class="skill-option"><input type="checkbox" value={skill.value} checked={draft.includes(skill.value)} onchange={(event) => { draft = event.currentTarget.checked ? [...new Set([...draft, skill.value])] : draft.filter(value => value !== skill.value); }} disabled={draft.length >= 50 && !draft.includes(skill.value)} /><span>{skill.label}</span><small>{skill.count} jobs</small></label>
    {/each}
    {#if !visible.length}<p>No skills found. Try another term or category.</p>{/if}
  </fieldset>
  <footer><span aria-live="polite">{draft.length} selected</span><button type="button" onclick={() => dialog.close()}>Cancel</button><button class="apply" type="button" onclick={applySkills}>Apply skills</button></footer>
</dialog>

<style>
.opportunity-search { display: grid; gap: .75rem; margin-block: 1rem; }
.search-label { font-weight: 600; }
.search-row { display: flex; gap: .5rem; }
.search-row input { flex: 1; min-width: 0; width: 100%; }
input, button, select { font: inherit; }
.search-row input, button, select { min-height: 44px; padding: .5rem .75rem; }
button { cursor: pointer; }
.skill-filters { display: flex; gap: .5rem; flex-wrap: wrap; align-items: start; }
.skill-option { display: flex; gap: .5rem; align-items: center; min-height: 44px; padding: .25rem; overflow-wrap: anywhere; }
.skill-option input { width: 1.1rem; height: 1.1rem; flex-shrink: 0; }
.skill-chip { border: 1px solid var(--border-strong); border-radius: 2rem; background: var(--tag-bg); overflow-wrap: anywhere; max-width: 100%; }
.other-filters { display: grid; gap: .75rem; }
@media(min-width:42rem) { .other-filters { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
dialog { width: min(46rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); margin: auto; padding: 1.25rem; border: 1px solid var(--border-strong); border-radius: .75rem; background: var(--bg-elev); color: var(--ink); box-sizing: border-box; }
dialog::backdrop { background: rgb(0 0 0 / .45); }
.catalog-header { display: flex; gap: 1rem; align-items: start; justify-content: space-between; }
.catalog-header h2 { margin: 0; }
.catalog-header p, .catalog-note { color: var(--ink-3); font-size: .9rem; }
.catalog-controls { display: grid; gap: .75rem; }
.catalog-controls > div { display: grid; gap: .25rem; min-width: 0; }
.catalog-controls input, .catalog-controls select { width: 100%; min-width: 0; min-height: 44px; padding: .5rem; box-sizing: border-box; }
.catalog-list { min-width: 0; margin: .75rem 0; padding: .5rem; border: 1px solid var(--border-strong); border-radius: .5rem; max-height: 40dvh; overflow-y: auto; }
.skill-option span { flex: 1; }
.skill-option small { color: var(--ink-3); white-space: nowrap; }
footer { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
footer span { flex: 1; }
.apply { background: var(--accent); color: var(--bg); border-radius: .4rem; }
@media(min-width:42rem) { .catalog-controls { grid-template-columns: 1fr 1fr; } }
.filter-mode { margin:0; gap:1rem; }
.filter-mode .other-filters { grid-template-columns:1fr; gap:1.5rem; }
.filter-mode input { color:var(--ink); background:var(--bg); border:1px solid var(--border-strong); border-radius:.5rem; }
.filter-mode .skill-filters > button:first-child { border:1px dashed var(--border-strong); border-radius:2rem; }
.filter-footer { position:sticky; bottom:-1.25rem; display:flex; justify-content:space-between; align-items:center; gap:1rem; background:var(--bg-elev); padding:1rem 0; border-top:1px solid var(--border-strong); }
.filter-footer a { min-height:44px; display:flex; align-items:center; color:var(--ink-3); }
.filter-footer .apply { font-weight:700; padding:.65rem 1.25rem; }
</style>
