<script lang="ts">
import HostedLanding from '$lib/components/HostedLanding.svelte';
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
      })
    : null,
);
</script>

{#if landing}
  <HostedLanding
    appName={landing.appName}
    links={landing.links}
    signedIn={landing.signedIn}
  />
  {#if landing.opportunities?.length}
    <section aria-label="Latest opportunities"><h2>Latest opportunities</h2><ul>{#each landing.opportunities as opportunity}<li><a href={`/opportunities/${opportunity.id}`}>{opportunity.title}</a> at {opportunity.company}</li>{/each}</ul><a href="/opportunities">Search all opportunities</a></section>
  {/if}
{:else}
  <ResumeHome data={data as unknown as ResumeData} />
{/if}
