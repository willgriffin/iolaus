<script lang="ts">
import PublicSkillMatch from '$lib/components/PublicSkillMatch.svelte';

let { data } = $props();
const filters = [
  ['skills', 'Skill'],
  ['seniority', 'Seniority'],
  ['work_mode', 'Work mode'],
  ['employment_type', 'Employment type'],
  ['country', 'Country'],
] as const;
function nextPage() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    ...data.input,
    cursor: data.page.next_cursor,
  })) {
    if (value === undefined || value === null || value === '') continue;
    for (const item of Array.isArray(value) ? value : [value])
      params.append(key, String(item));
  }
  return `?${params}`;
}
</script>
<svelte:head><title>Opportunity search</title><meta name="description" content="Search public job opportunities by role, skills, location, and work mode."/><link rel="search" type="application/opensearchdescription+xml" title="Opportunity search" href="/opensearch.xml"/></svelte:head>
<main class="shell"><a href="/">Iolaus</a><h1>Find opportunities</h1><form method="GET" class="search"><label class="keywords">Keywords<input name="q" value={data.input.q} placeholder="Role, skill, or company"/></label>
{#each filters as [name,label]}
<label>{label}{#if name === 'skills'}<input name="skills" list="search-skills" value={data.input.skills[0]??''} placeholder="Start typing a skill"/><datalist id="search-skills">{#each data.page.facets.skills as facet}<option value={facet.value}>{facet.label}</option>{/each}</datalist>{:else}<select {name} value={data.input[name]?.[0]??''}><option value="">Any</option>{#each data.page.facets[name] as facet}<option value={facet.value}>{facet.label} ({facet.count})</option>{/each}</select>{/if}</label>
{/each}
<label>Sort<select name="sort" value={data.input.sort}><option value="relevance">Relevance</option><option value="newest">Newest</option></select></label><button>Search</button></form>
<p aria-live="polite">{data.page.total_estimate} opportunities</p><ol>{#each data.page.items as item}<li><article><p>{#if item.company}<a href={`/companies/${encodeURIComponent(item.company.slug)}`}>{item.company.name}</a>{:else}Company{/if} · {item.work_mode}</p><h2><a href={`/opportunities/${item.id}`}>{item.title}</a></h2><p>{item.location.text||item.location.countries.join(', ')}</p><ul>{#each [...item.skills.required,...item.skills.preferred].slice(0,6) as skill}<li><a href={`/skills/${encodeURIComponent(skill.slug)}`}>{skill.label}</a></li>{/each}</ul></article></li>{/each}</ol>{#if !data.page.items.length}<p>No opportunities match these filters.</p>{/if}{#if data.page.next_cursor}<a href={nextPage()}>Next page</a>{/if}<PublicSkillMatch skills={data.page.facets.skills}/></main>
<style>.shell{max-width:70rem;margin:auto;padding:1rem;overflow-wrap:anywhere}.search{display:grid;gap:.75rem}.search label{display:grid;gap:.25rem}.search input,.search select,.search button{min-height:44px;min-width:0;width:100%;padding:.5rem}ol{padding:0;list-style:none;display:grid;gap:1rem}article{border:1px solid #ddd;padding:1rem;border-radius:.5rem}article p{color:#655f57}article ul{display:flex;gap:.5rem;flex-wrap:wrap;padding:0;list-style:none}article ul a{display:inline-block;background:#eee;padding:.4rem .6rem;border-radius:2rem}@media(min-width:42rem){.shell{padding:2rem}.search{grid-template-columns:repeat(3,minmax(0,1fr));align-items:end}.keywords{grid-column:span 3}}</style>
