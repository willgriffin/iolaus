<script lang="ts">
import { jsonLdScript } from '$lib/public-job-posting.js';

let { data } = $props();
const opportunity = $derived(data.opportunity);
</script>
<svelte:head><title>{opportunity.title} at {opportunity.company?.name ?? 'company'}</title><meta name="description" content={opportunity.summary_bullets.join(' ').slice(0,160)} />{@html jsonLdScript(data.structuredData)}</svelte:head>
<main class="shell"><a href="/opportunities">← All opportunities</a><p>{opportunity.company?.name}</p><h1>{opportunity.title}</h1><p>{[opportunity.location.text, opportunity.work_mode === 'unknown' ? '' : opportunity.work_mode].filter(Boolean).join(' · ')}</p><a class="apply" href={opportunity.posting_url} target="_blank" rel="noopener noreferrer">View original posting</a><h2>Derived summary</h2>{#if !opportunity.summary_bullets.length}<p>No derived summary is available. See the original posting for full details.</p>{/if}<ul>{#each opportunity.summary_bullets as item}<li>{item}</li>{/each}</ul><h2>Skills</h2><p>{[...opportunity.skills.required,...opportunity.skills.preferred].map(skill=>skill.label).join(', ')}</p></main><style>.shell{max-width:48rem;margin:auto;padding:1rem}.apply{display:inline-block;padding:.75rem 1rem;background:#151515;color:white;text-decoration:none;border-radius:.35rem}@media(min-width:42rem){.shell{padding:2rem}}</style>
