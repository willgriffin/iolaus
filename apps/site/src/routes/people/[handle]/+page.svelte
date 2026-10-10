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


<PublicProfileResume snapshot={data.snapshot} />
<p class="download"><a href={`${canonical}/resume.pdf`}>Download resume as PDF</a></p>

<style>.download { width: min(100%, 48rem); margin: 0 auto 2rem; padding: 0 clamp(1rem, 4vw, 3rem); } a:focus-visible { outline: 2px solid var(--smrt-color-primary, #075985); outline-offset: 3px; }</style>
