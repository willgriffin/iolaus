<script lang="ts">
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import Clock3 from '@lucide/svelte/icons/clock-3';
import Heart from '@lucide/svelte/icons/heart';
import X from '@lucide/svelte/icons/x';
import type { PublicOpportunity } from '$lib/public-opportunity-contract';
import {
  opportunityLabel,
  postedCompensation,
} from '$lib/public-opportunity-presentation';

let {
  opportunity,
  decision,
  onReview,
  onChoice,
  busy = false,
}: {
  opportunity: PublicOpportunity;
  decision?: string;
  onReview: () => void;
  onChoice: (decision: 'passed' | 'later' | 'saved') => void;
  busy?: boolean;
} = $props();
const location = $derived(
  opportunity.location.text || opportunity.location.countries.join(', '),
);
const facts = $derived(
  [
    location,
    opportunityLabel(opportunity.work_mode),
    opportunityLabel(opportunity.employment_type),
    postedCompensation(opportunity.compensation),
  ].filter(Boolean),
);
const skills = $derived([
  ...new Map(
    [
      ...opportunity.skills.required,
      ...opportunity.skills.preferred,
      ...(opportunity.skills.mentioned ?? []),
    ].map((skill) => [skill.slug, skill]),
  ).values(),
]);
</script>
<article class="list-card">
<button id={`review-${opportunity.id}`} class="review" type="button" aria-label={`Review ${opportunity.title}`} onclick={onReview}>
  <span class="content">
    <span class="company">{opportunity.company?.name ?? 'Employer not listed'}</span>
    <strong class="title">{opportunity.title}</strong>
    {#if facts.length}<span class="facts">{facts.join(' · ')}</span>{/if}
    {#if skills.length}<span class="skills">{#each skills.slice(0, 4) as skill}<span>{skill.label}</span>{/each}{#if skills.length > 4}<span class="more">+{skills.length - 4} more</span>{/if}</span>{/if}
    {#if decision && decision !== 'seen'}<span class="decision">{decision === 'saved' ? 'Saved' : decision === 'later' ? 'For later' : 'Passed'}</span>{/if}
  </span>
  <ChevronRight size={20} aria-hidden="true" />
</button>
<div class="quick-choices" role="group" aria-label={`Choices for ${opportunity.title}`}>
  <button type="button" aria-label="Reject" title="Reject" disabled={busy} onclick={() => onChoice('passed')}><X size={18} aria-hidden="true"/></button>
  <button type="button" aria-label="Maybe" title="Maybe — save for later" disabled={busy} onclick={() => onChoice('later')}><Clock3 size={18} aria-hidden="true"/></button>
  <button type="button" aria-label="Love" title="Love — save to shortlist" disabled={busy} onclick={() => onChoice('saved')}><Heart size={18} aria-hidden="true"/></button>
</div>
</article>
<style>
.list-card { width:100%; border:1px solid var(--border-strong); border-radius:.65rem; background:var(--bg-elev); color:var(--ink); text-align:left; cursor:pointer; }
.list-card:hover { border-color:var(--accent); }
.review:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.review { display:flex; align-items:center; justify-content:space-between; gap:1rem; width:100%; padding:1rem 1rem .3rem; border:0; border-radius:.65rem; background:transparent; color:inherit; text-align:left; cursor:pointer; }
.quick-choices { display:flex; justify-content:flex-end; gap:.1rem; padding:0 .5rem .35rem; }
.quick-choices button { display:grid; place-items:center; width:44px; height:44px; padding:0; border:0; border-radius:50%; color:var(--ink-3); background:transparent; cursor:pointer; }
.quick-choices button:hover:not(:disabled) { background:var(--tag-bg); color:var(--ink); }
.quick-choices button:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.quick-choices button:disabled { opacity:.35; cursor:default; }
.content { display:grid; gap:.35rem; min-width:0; overflow-wrap:anywhere; }
.company, .facts { font-size:.85rem; color:var(--ink-3); }
.title { font-size:1.05rem; line-height:1.35; }
.skills { display:flex; flex-wrap:wrap; gap:.3rem; margin-top:.2rem; }
.skills span { border-radius:1rem; padding:.1rem .5rem; font-size:.75rem; background:var(--tag-bg); }
.skills .more { background:none; color:var(--ink-3); }
.decision { font-size:.8rem; font-weight:700; color:var(--accent); }
</style>
