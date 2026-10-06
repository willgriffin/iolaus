<script lang="ts">
import HostedLanding from '$lib/components/HostedLanding.svelte';
import ResumeHome from '$lib/components/ResumeHome.svelte';
import type { HostedLandingData } from '$lib/public-links';
import type { Experience, Profile, Skills } from '$lib/types';

type ResumeData = {
  experience: Experience;
  profile: Profile;
  skills: Skills;
};

let { data } = $props();

const landing = $derived(
  'mode' in data ? (data as unknown as HostedLandingData) : null,
);
</script>

{#if landing}
  <HostedLanding
    appName={landing.appName}
    links={landing.links}
    signedIn={landing.signedIn}
  />
{:else}
  <ResumeHome data={data as unknown as ResumeData} />
{/if}
