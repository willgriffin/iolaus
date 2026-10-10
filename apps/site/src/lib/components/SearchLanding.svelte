<script lang="ts">
import { onMount } from 'svelte';
import PublicSiteHeader from '$lib/components/PublicSiteHeader.svelte';
import {
  loadSearchDiscoveryPreferences,
  saveSearchDiscoveryPreferences,
  searchDiscoveryBrowserStorage,
} from '$lib/search-discovery-preferences';
import { interpretOpportunitySearch } from '$lib/search-interpretation';
import { canonicalSkillSlug } from '$lib/skill-canonical';
import { CAREER_SKILL_CATEGORIES } from '$lib/skill-vocabulary-data';

const MAX_SKILLS = 50;
const careerCategories = CAREER_SKILL_CATEGORIES.map((category) => ({
  ...category,
  skills: category.skills.filter(
    (skill, index, skills) =>
      skills.findIndex(
        (candidate) =>
          canonicalSkillSlug(candidate) === canonicalSkillSlug(skill),
      ) === index,
  ),
}));
const labels = new Map<string, string>();
for (const category of careerCategories)
  for (const skill of category.skills) {
    const slug = canonicalSkillSlug(skill);
    if (!labels.has(slug)) labels.set(slug, skill);
  }

let { appName, signedIn }: { appName: string; signedIn: boolean } = $props();
let query = $state('');
let headerHeight = $state(0);
let category = $state('');
let manualSkills = $state<string[]>([]);
let excludedDerivedSkills = $state<string[]>([]);
let location = $state('');
let locationChosen = false;
let locationMessage = $state('');
let locationRevision = 0;
let locationRequestInFlight = $state(false);

const selectedCategory = $derived(
  careerCategories.find((item) => item.id === category) ?? null,
);
const interpretation = $derived(interpretOpportunitySearch(query));
const derivedSkills = $derived(interpretation.input.skills);
const selectedSkills = $derived(
  [...new Set([...manualSkills, ...derivedSkills])]
    .filter((skill) => !excludedDerivedSkills.includes(skill))
    .slice(0, MAX_SKILLS),
);
const activeChips = $derived(
  interpretation.chips.filter(
    (chip) => chip.kind !== 'skill' || selectedSkills.includes(chip.value),
  ),
);

function savePreferences() {
  saveSearchDiscoveryPreferences(searchDiscoveryBrowserStorage(), {
    category,
    skills: manualSkills,
    excludedDerivedSkills,
    location,
    locationChosen,
  });
}

function labelFor(skill: string): string {
  return labels.get(skill) ?? skill;
}

function toggleSkill(skill: string) {
  if (selectedSkills.includes(skill)) {
    manualSkills = manualSkills.filter((value) => value !== skill);
    if (derivedSkills.includes(skill))
      excludedDerivedSkills = [...new Set([...excludedDerivedSkills, skill])];
  } else if (selectedSkills.length < MAX_SKILLS) {
    manualSkills = [...new Set([...manualSkills, skill])];
    excludedDerivedSkills = excludedDerivedSkills.filter(
      (value) => value !== skill,
    );
  }
  savePreferences();
}

function chooseCategory(value: string) {
  category = value;
  savePreferences();
}

function resetSelectedSkills() {
  manualSkills = [];
  excludedDerivedSkills = [
    ...new Set([...excludedDerivedSkills, ...derivedSkills]),
  ];
  savePreferences();
}

function updateLocation(value: string) {
  location = value;
  locationChosen = true;
  locationRevision += 1;
  locationMessage = '';
  savePreferences();
}

async function useMyLocation() {
  if (locationRequestInFlight) return;
  if (!navigator.geolocation) {
    locationMessage =
      'Location is not available in this browser. Enter a city or region instead.';
    return;
  }
  locationRequestInFlight = true;
  locationMessage = 'Finding your location…';
  const revision = locationRevision;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 10_000,
        maximumAge: 300_000,
      }),
    );
    const response = await fetch(
      `/api/public/v1/location?latitude=${encodeURIComponent(position.coords.latitude)}&longitude=${encodeURIComponent(position.coords.longitude)}`,
      { signal: controller.signal },
    );
    const body = (await response.json()) as { location?: unknown };
    if (
      !response.ok ||
      typeof body.location !== 'string' ||
      !body.location.trim() ||
      body.location.trim().length > 120
    )
      throw new Error('Location lookup failed');
    if (locationRevision === revision) {
      location = body.location.trim();
      locationChosen = true;
      locationRevision += 1;
      savePreferences();
      locationMessage = 'Location added. You can edit it anytime.';
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 1
    )
      locationMessage =
        'Location permission was not granted. Enter a city or region instead.';
    else
      locationMessage =
        'We could not determine your location. Enter a city or region instead.';
  } finally {
    window.clearTimeout(timeout);
    locationRequestInFlight = false;
  }
}

onMount(() => {
  const preferences = loadSearchDiscoveryPreferences(
    searchDiscoveryBrowserStorage(),
  );
  category = careerCategories.some((item) => item.id === preferences.category)
    ? preferences.category
    : careerCategories[0].id;
  manualSkills = preferences.skills;
  excludedDerivedSkills = preferences.excludedDerivedSkills;
  location = preferences.location;
  locationChosen = preferences.locationChosen;

  const revision = locationRevision;
  if (!locationChosen && navigator.permissions?.query)
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((permission) => {
        if (
          permission.state === 'granted' &&
          !locationChosen &&
          locationRevision === revision &&
          !locationRequestInFlight
        )
          void useMyLocation();
      })
      .catch(() => undefined);
});
</script>

<div class="sticky-header" bind:clientHeight={headerHeight}><PublicSiteHeader {signedIn}/></div>
<main class="search-home" style={`--search-header-height: ${headerHeight}px`}>


  <section class="hero" aria-labelledby="search-title">
    <p class="eyebrow">A clearer way to search</p>
    <h1 id="search-title">Find work that fits your skills.</h1>
    <p>Start with a role, then fine-tune the skills and location that matter to you.</p>
    <form id="discovery-search" action="/opportunities" method="GET" class="search-form" aria-label="Opportunity search">
      <label for="search-query">What kind of work are you looking for?</label>
      <div class="query-row">
        <input id="search-query" name="search" type="search" bind:value={query} maxlength="1000" placeholder="e.g. remote welder, nurse, or data analyst" />
      </div>
      <div class="location-row">
        <label for="search-location">Location <span>optional</span></label>
        <div><input id="search-location" name="location" value={location} oninput={(event) => updateLocation(event.currentTarget.value)} placeholder="Anywhere" maxlength="120" /><button type="button" onclick={useMyLocation} disabled={locationRequestInFlight}>{locationRequestInFlight ? 'Finding location…' : 'Use my location'}</button></div>
        {#if location}<button class="clear-location" type="button" onclick={() => updateLocation('')}>Clear location</button>{/if}
        {#if locationMessage}<p class="location-message" aria-live="polite">{locationMessage}</p>{/if}
        <small class="location-credit">Location lookup: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a></small>
      </div>
      {#each selectedSkills as skill (skill)}
        <input type="hidden" name="skills" value={skill} />
      {/each}
      <input type="hidden" name="skills_mode" value="replace" />
      <input type="hidden" name="start" value="1" />
    </form>
  </section>

  <div class="search-action"><span>{selectedSkills.length ? `${selectedSkills.length} skills selected` : 'Search by role, skills, or both'}</span><button class="search-button" type="submit" form="discovery-search">Search opportunities</button></div>

  <section class="discovery" aria-labelledby="directory-title">
    <div class="section-heading"><p class="eyebrow">Browse by profession</p><h2 id="directory-title">Explore skills across careers</h2></div>
    <div class="category-directory" aria-label="Career categories">
      {#each careerCategories as item (item.id)}
        <button type="button" class:active={category === item.id} aria-pressed={category === item.id} onclick={() => chooseCategory(item.id)}>{item.label}</button>
      {/each}
    </div>
    {#if selectedCategory}
      <section class="skill-panel" aria-labelledby="skill-category-title">
        <div><h3 id="skill-category-title">{selectedCategory.label}</h3><p>Select up to {MAX_SKILLS} skills to focus your results.</p></div>
        <div class="skill-grid">
          {#each selectedCategory.skills as label (label)}
            {@const skill = canonicalSkillSlug(label)}
            <button type="button" aria-pressed={selectedSkills.includes(skill)} disabled={!selectedSkills.includes(skill) && selectedSkills.length >= MAX_SKILLS} onclick={() => toggleSkill(skill)}>{label}</button>
          {/each}
        </div>
      </section>
    {/if}
  </section>

  {#if selectedSkills.length}
    <section class="selected-skills" aria-labelledby="selected-skills-title">
      <div class="selected-heading"><h2 id="selected-skills-title">Your selected skills <span>{selectedSkills.length}/{MAX_SKILLS}</span></h2><button type="button" onclick={resetSelectedSkills}>Reset skills</button></div>
      <div class="skill-chips">{#each selectedSkills as skill (skill)}<button type="button" onclick={() => toggleSkill(skill)} aria-label={`Remove ${labelFor(skill)}`}>{labelFor(skill)} <span aria-hidden="true">×</span></button>{/each}</div>
    </section>
  {/if}

  {#if query.trim() && activeChips.length}
    <aside class="interpretation" aria-live="polite">
      <strong>We found:</strong>
      <span>{[...new Set(activeChips.map((chip) => chip.label))].join(', ')}</span>
      {#if interpretation.warnings.length}<span class="warning">{interpretation.warnings[0]}</span>{/if}
    </aside>
  {/if}

</main>

<style>
  .sticky-header { position:sticky; top:0; z-index:3; }
  .search-home { max-width: 76rem; margin: 0 auto; padding: 1rem; }
  .hero { padding: clamp(1.5rem, 5vw, 4rem); border-radius: 1.25rem; background: linear-gradient(135deg, var(--tag-bg), var(--accent-soft)); box-shadow: var(--shadow); }
  .eyebrow { margin: 0 0 .45rem; color: var(--ink-3); font-size: .78rem; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
  h1, h2, h3 { font-family: Georgia, 'Times New Roman', serif; } h1 { max-width: 18ch; margin: 0; font-size: clamp(2.25rem, 7vw, 4.6rem); line-height: .98; letter-spacing: -.045em; } h2 { margin: 0; font-size: clamp(1.65rem, 4vw, 2.5rem); letter-spacing: -.03em; }
  .hero > p:not(.eyebrow) { max-width: 38rem; font-size: 1.1rem; line-height: 1.55; }
  .search-form { display: grid; gap: .65rem; max-width: 62rem; margin-top: 1.5rem; } .search-form > label, .location-row > label { font-weight: 700; } .location-row label span, .selected-skills h2 span { color: var(--ink-3); font: 500 .85rem system-ui, sans-serif; }
  input, button { box-sizing: border-box; font: inherit; } button { cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .55; }
  input::placeholder { color: var(--ink-3); opacity: 1; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .query-row { display: grid; gap: .55rem; } .query-row input, .location-row input { width: 100%; min-width: 0; min-height: 3.25rem; padding: .75rem .9rem; border: 1px solid var(--border-strong); border-radius: .6rem; background: var(--bg-elev); color: var(--ink); }
  .search-action { position:sticky; top:var(--search-header-height, 0px); display:grid; gap:.4rem; padding:1rem 0; margin-top:1rem; background:var(--bg); z-index:1; }
  .search-action > span { font-size:.85rem; color:var(--ink-3); text-align:center; }
  .search-button { width:100%; min-height: 3.25rem; padding: .7rem 1.1rem; border: 1px solid var(--accent); border-radius: .6rem; background: var(--accent); color: var(--bg); font-weight: 800; }
  .location-row { display: grid; gap: .35rem; } .location-row > div { display: grid; gap: .5rem; } .location-row button { min-height: 2.75rem; padding: .5rem .75rem; border: 1px solid var(--border-strong); border-radius: .5rem; background: transparent; color: var(--ink-2); font-weight: 700; } .location-row .clear-location { justify-self: start; min-height: auto; padding: .15rem 0; border: 0; text-decoration: underline; } .location-message { margin: 0; color: var(--ink-2); font-size: .9rem; }
  .discovery { margin-top: clamp(2.5rem, 7vw, 5rem); } .section-heading { margin-bottom: 1.25rem; }
  .category-directory { display: flex; gap: .55rem; flex-wrap: wrap; } .category-directory button { min-height: 2.7rem; padding: .4rem .75rem; border: 1px solid var(--border-strong); border-radius: 2rem; background: var(--bg-elev); color: var(--ink-2); } .category-directory button.active { border-color: var(--tag-bg-active); background: var(--accent-soft); color: var(--accent-ink); font-weight: 800; }
  .skill-panel { margin-top: 1.25rem; padding: 1.25rem; border: 1px solid var(--border-strong); border-radius: 1rem; background: var(--bg-elev); color: var(--ink); } .skill-panel h3 { margin: 0; font-size: 1.35rem; } .skill-panel p { margin: .35rem 0 1rem; color: var(--ink-3); }
  .skill-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .55rem; } .skill-grid button { min-height: 3rem; padding: .5rem .65rem; border: 1px solid var(--border-strong); border-radius: .55rem; background: var(--bg-elev); text-align: left; } .skill-grid button[aria-pressed='true'] { border-color: var(--tag-bg-active); background: var(--accent-soft); color: var(--accent-ink); font-weight: 800; }
  .selected-skills { margin-top: 1.5rem; padding: 1.2rem; border-radius: 1rem; background: var(--tag-bg); } .selected-heading { display: flex; justify-content: space-between; align-items: center; gap: .75rem; margin-bottom: .8rem; } .selected-skills h2 { margin: 0; font-size: 1.35rem; } .selected-heading button { min-height: auto; padding: .2rem 0; border: 0; background: transparent; color: var(--accent-ink); text-decoration: underline; } .skill-chips { display: flex; gap: .5rem; flex-wrap: wrap; } .skill-chips button { min-height: 2.5rem; padding: .35rem .65rem; border: 1px solid var(--border-strong); border-radius: 2rem; background: var(--bg-elev); color: var(--ink); }
  .interpretation { display: flex; gap: .45rem; flex-wrap: wrap; margin-top: 1rem; padding: .8rem 1rem; border-left: 4px solid var(--accent); background: var(--accent-soft); color: var(--tag-bg-active); } .interpretation .warning { width: 100%; color: var(--accent-ink); }
  @media (min-width: 42rem) { .search-home { padding: 1.5rem 2rem 3rem; } .query-row { grid-template-columns: minmax(0, 1fr); } .location-row > div { grid-template-columns: minmax(0, 1fr) auto; } .location-row > div button { white-space: nowrap; } }
</style>
