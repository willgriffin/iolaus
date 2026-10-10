<script lang="ts">
import type { PublicOpportunity } from '$lib/public-opportunity-contract';
import {
  opportunityLabel,
  postedCompensation,
  postedDate,
  postingLink,
} from '$lib/public-opportunity-presentation';

let {
  opportunity,
  onOriginalOpen,
  showOriginal = true,
}: {
  opportunity: PublicOpportunity;
  onOriginalOpen?: () => void;
  showOriginal?: boolean;
} = $props();
const location = $derived(
  opportunity.location.text || opportunity.location.countries.join(', '),
);
const pay = $derived(postedCompensation(opportunity.compensation));
const posted = $derived(postedDate(opportunity.posted_at));
const original = $derived(postingLink(opportunity.posting_url));
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
<article class="opportunity-card">
  <p class="company">{#if opportunity.company}<a href={`/companies/${encodeURIComponent(opportunity.company.slug)}`}>{opportunity.company.name}</a>{:else}Employer not listed{/if}</p>
  <h2><a href={`/opportunities/${encodeURIComponent(opportunity.id)}`}>{opportunity.title}</a></h2>
  <dl>
    {#if location}<div><dt>Location</dt><dd>{location}</dd></div>{/if}
    {#if opportunityLabel(opportunity.work_mode)}<div><dt>Work arrangement</dt><dd>{opportunityLabel(opportunity.work_mode)}</dd></div>{/if}
    {#if opportunityLabel(opportunity.employment_type)}<div><dt>Employment</dt><dd>{opportunityLabel(opportunity.employment_type)}</dd></div>{/if}
    {#if opportunityLabel(opportunity.seniority)}<div><dt>Level</dt><dd>{opportunityLabel(opportunity.seniority)}</dd></div>{/if}
    {#if pay}<div class="pay"><dt>Posted pay</dt><dd>{pay}</dd></div>{/if}
    {#if posted}<div><dt>Posted</dt><dd><time datetime={opportunity.posted_at ?? undefined}>{posted}</time></dd></div>{/if}
  </dl>
  {#if skills.length}<ul class="skills" aria-label="Listed skills">{#each skills as skill}<li><a href={`/skills/${encodeURIComponent(skill.slug)}`}>{skill.label}</a></li>{/each}</ul>{/if}
  <footer><a class="details" href={`/opportunities/${encodeURIComponent(opportunity.id)}`}>View details</a>{#if showOriginal && original}<a class="original" href={original.href} target="_blank" rel="noopener noreferrer" onclick={onOriginalOpen}>View original posting <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a><span class="source">{original.host}</span>{/if}</footer>
</article>
<style>
.opportunity-card { border: 1px solid var(--border-strong); padding: 1.25rem; border-radius: .65rem; overflow-wrap: anywhere;  box-sizing: border-box; }
.company { margin: 0 0 .35rem; color: var(--ink-3); }
h2 { font-size: 1.2rem; line-height: 1.4; margin: 0 0 1rem; }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem 1rem; margin: 0; }
dl div { min-width: 0; }
dt { font-size: .8rem; color: var(--ink-3); }
dd { margin: .15rem 0 0; }
.pay { grid-column: 1 / -1; }
.pay dd { font-weight: 600; }
.skills { display: flex; gap: .5rem; flex-wrap: wrap; padding: 0; list-style: none; }
.skills a { display: inline-block; background: var(--tag-bg); color: var(--ink); padding: .4rem .6rem; border-radius: 2rem; }
footer { display: flex; gap: .5rem 1rem; flex-wrap: wrap; align-items: center; margin-top: 1rem; }
.details, .original { display: inline-flex; align-items: center; min-height: 44px; }
.original { gap: .35rem; font-weight: 600; }
.source { flex-basis: 100%; color: var(--ink-3); font-size: .8rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
</style>
