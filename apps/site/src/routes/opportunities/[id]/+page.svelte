<script lang="ts">
import PublicSiteHeader from '$lib/components/PublicSiteHeader.svelte';
import { jsonLdScript } from '$lib/public-job-posting.js';

let { data } = $props();
const opportunity = $derived(data.opportunity);
</script>
<svelte:head><title>{opportunity.title} at {opportunity.company?.name ?? 'company'}</title><meta name="description" content={opportunity.summary_bullets.join(' ').slice(0,160)} />{@html jsonLdScript(data.structuredData)}</svelte:head>
<PublicSiteHeader signedIn={data.signedIn}/>

<main class="opportunity">
  <a class="back" href="/opportunities">All opportunities</a>
  <header>
    {#if opportunity.company?.name}<p class="company">{opportunity.company.name}</p>{/if}
    <h1>{opportunity.title}</h1>
    <p class="location">{[opportunity.location.text, opportunity.work_mode === 'unknown' ? '' : opportunity.work_mode].filter(Boolean).join(' · ')}</p>
  </header>
  <a class="apply" href={opportunity.posting_url} target="_blank" rel="noopener noreferrer">View original posting</a>

  <section>
    <h2>Derived summary</h2>
    {#if !opportunity.summary_bullets.length}<p>No derived summary is available. See the original posting for full details.</p>{/if}
    <ul>{#each opportunity.summary_bullets as item}<li>{item}</li>{/each}</ul>
  </section>
  {#if opportunity.skills.required.length}<section><h2>Required skills</h2><p>{opportunity.skills.required.map(skill=>skill.label).join(', ')}</p></section>{/if}
  {#if opportunity.skills.preferred.length}<section><h2>Preferred skills</h2><p>{opportunity.skills.preferred.map(skill=>skill.label).join(', ')}</p></section>{/if}
  {#if opportunity.skills.mentioned?.length}<section><h2>Skills mentioned in the posting</h2><p>{opportunity.skills.mentioned.map(skill=>skill.label).join(', ')}</p><p class="note">A mention alone does not establish a requirement. Check the original posting for context.</p></section>{/if}
</main>

<style>
  .opportunity { width:min(100% - 2rem, 48rem); margin:0 auto; padding:clamp(1.5rem, 5vw, 3rem) 0; }
  .back { color:var(--smrt-color-primary, #075985); }
  header { margin:1.25rem 0; }
  h1,h2,p { margin:0; overflow-wrap:anywhere; }
  h1 { font-size:clamp(2rem, 6vw, 3rem); line-height:1.08; }
  h2 { font-size:1.2rem; }
  .company { margin-bottom:.35rem; font-weight:700; }
  .location,.note { margin-top:.5rem; color:var(--smrt-color-on-surface-variant, #475569); line-height:1.5; }
  .apply { display:inline-flex; align-items:center; min-height:44px; padding:.55rem .9rem; border-radius:var(--smrt-radius-medium, .5rem); background:var(--smrt-color-primary, #075985); color:var(--smrt-color-on-primary, white); font-weight:700; text-decoration:none; }
  section { margin-top:2rem; }
  section p,li { line-height:1.6; }
  ul { padding-left:1.25rem; }
</style>
