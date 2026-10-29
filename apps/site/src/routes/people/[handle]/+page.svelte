<script lang="ts">
import PublicProfileResume from '$lib/components/PublicProfileResume.svelte';
import PublicSiteHeader from '$lib/components/PublicSiteHeader.svelte';

let { data } = $props();
let canonical = $derived(`/people/${encodeURIComponent(data.handle)}`);
</script>

<svelte:head>
  <title>{data.snapshot.name} · {data.snapshot.title}</title>
  <meta name="description" content={`${data.snapshot.name} — ${data.snapshot.title}`} />
  <meta name="robots" content="noindex, nofollow" />
  <link rel="canonical" href={canonical} />
  <meta property="og:title" content={`${data.snapshot.name} · ${data.snapshot.title}`} />
  <meta property="og:description" content={data.snapshot.title} />
</svelte:head>
<PublicSiteHeader signedIn={data.signedIn}/>


<div class="public-profile-page">
  <PublicProfileResume snapshot={data.snapshot} />
  <p class="download"><a href={`${canonical}/resume.pdf`}>Download resume as PDF</a></p>
</div>

<style>
  /* Mirrors the palette owned by PublicProfileResume so the page edge, the
     download link, and the resume surface agree in both colour schemes. */
  .public-profile-page { --profile-bg: #fbfaf7; --profile-accent: #8a3f1f; background: var(--profile-bg); min-height: 100vh; }
  @media (prefers-color-scheme: dark) { .public-profile-page { --profile-bg: #15140f; --profile-accent: #f0a880; } }
  :global(:root[data-color-scheme='dark']) .public-profile-page { --profile-bg: #15140f; --profile-accent: #f0a880; }
  :global(:root[data-color-scheme='light']) .public-profile-page { --profile-bg: #fbfaf7; --profile-accent: #8a3f1f; }
  @media print { .public-profile-page, :global(:root[data-color-scheme]) .public-profile-page { --profile-bg: #ffffff; --profile-accent: #1a1814; } }
  .download { width: min(100%, 48rem); margin: 0 auto; padding: 0 clamp(1rem, 4vw, 3rem) 2rem; }
  .download a { color: var(--profile-accent); text-decoration: underline; text-underline-offset: .15em; }
  a:focus-visible { outline: 2px solid var(--profile-accent); outline-offset: 3px; }
</style>
