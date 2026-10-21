<script lang="ts">
import HostedLanding from '$lib/components/HostedLanding.svelte';
import ResumeHome from '$lib/components/ResumeHome.svelte';
import SearchLanding from '$lib/components/SearchLanding.svelte';
import type { HostedLandingData } from '$lib/public-links';
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
        publicCatalogEnabled?: boolean;
      })
    : null,
);
</script>
<svelte:head>{#if landing?.publicCatalogEnabled}<title>{landing.appName} opportunity search</title><meta name="description" content="Find public job opportunities and compare your skills with posted requirements."/>{/if}</svelte:head>

{#if landing}
  {#if landing.publicCatalogEnabled}
    <SearchLanding appName={landing.appName} signedIn={landing.signedIn}/>
  {:else}
    <HostedLanding appName={landing.appName} links={landing.links} signedIn={landing.signedIn}/>
  {/if}
{:else}
  <ResumeHome data={data as unknown as ResumeData} />
{/if}
