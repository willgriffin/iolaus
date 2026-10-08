<script lang="ts">
import HostedLanding from '$lib/components/HostedLanding.svelte';
import PublicSkillMatch from '$lib/components/PublicSkillMatch.svelte';
import ResumeHome from '$lib/components/ResumeHome.svelte';
import type { HostedLandingData } from '$lib/public-links';
import type { PublicOpportunity } from '$lib/public-opportunity-contract';
import type { Experience, Profile, Skills } from '$lib/types';

type ResumeData = {
  experience: Experience;
  profile: Profile;
  skills: Skills;
};

let { data } = $props();

const landing = $derived(
  'mode' in data
    ? (data as unknown as HostedLandingData & {
        opportunities?: PublicOpportunity[];
        publicCatalogEnabled?: boolean;
        skillOptions?: { value: string; label: string; count: number }[];
      })
    : null,
);
</script>
<svelte:head>{#if landing?.publicCatalogEnabled}<title>{landing.appName} opportunity search</title><meta name="description" content="Find public job opportunities and compare your skills with posted requirements."/>{/if}</svelte:head>

{#if landing}
  {#if landing.publicCatalogEnabled}
  <main class="catalog"><header><a href="/">{landing.appName}</a><a href={landing.signedIn ? '/admin' : '/login'}>{landing.signedIn ? 'Your workspace' : 'Sign in'}</a></header><h1>Find your next opportunity</h1><p>Search public jobs by role and skills. Compare requirements before you apply.</p><form action="/opportunities" method="GET"><label for="home-keywords">Keywords</label><div class="search"><input id="home-keywords" name="q" maxlength="200" placeholder="Role, skill, or company"/><button>Search opportunities</button></div><label for="home-skill">Skill</label><input id="home-skill" name="skills" list="home-skills" placeholder="Start typing a skill"/><datalist id="home-skills">{#each landing.skillOptions ?? [] as skill}<option value={skill.value}>{skill.label}</option>{/each}</datalist></form><section aria-label="Latest opportunities"><h2>Latest opportunities</h2><ul>{#each landing.opportunities ?? [] as opportunity}<li><a href={`/opportunities/${opportunity.id}`}>{opportunity.title}</a><p>{opportunity.company?.name ?? 'Company'}</p></li>{/each}</ul>{#if !landing.opportunities?.length}<p>No public listings are available yet.</p>{/if}<a href="/opportunities">Browse all opportunities and filters</a></section><PublicSkillMatch skills={landing.skillOptions ?? []}/></main>
  {:else}
    <HostedLanding appName={landing.appName} links={landing.links} signedIn={landing.signedIn}/>
  {/if}
{:else}
  <ResumeHome data={data as unknown as ResumeData} />
{/if}

<style>.catalog{max-width:70rem;margin:auto;padding:1rem}header{display:flex;justify-content:space-between;gap:1rem}h1{margin-top:1.5rem;font-size:clamp(1.75rem,5vw,3rem)}label{display:block;margin:.5rem 0}.search{display:flex;gap:.5rem;flex-wrap:wrap}input,button{min-height:44px;padding:.5rem .75rem;max-width:100%}.search input{flex:1;min-width:10rem}ul{list-style:none;padding:0;display:grid;gap:.75rem}li{padding:.75rem;border:1px solid #ddd;border-radius:.5rem}li p{margin:.25rem 0 0}@media(min-width:42rem){.catalog{padding:2rem}ul{grid-template-columns:repeat(2,minmax(0,1fr))}}</style>
