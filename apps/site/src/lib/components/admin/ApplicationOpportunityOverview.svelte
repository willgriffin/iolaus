<script lang="ts">
import OpportunityTriageModal from './OpportunityTriageModal.svelte';

type Posting = Record<string, unknown>;
let {
  opportunity,
  company,
}: { opportunity: Posting | null; company: Posting | null } = $props();
let postingOpen = $state(false);
function text(record: Posting | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}
function items(key: string): string[] {
  return text(opportunity, key)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
}
const postingUrl = $derived(
  text(opportunity, 'postingUrl') || text(opportunity, 'applyUrl'),
);
const compensation = $derived.by(() => {
  const number = (key: string) =>
    typeof opportunity?.[key] === 'number' && Number.isFinite(opportunity[key])
      ? (opportunity[key] as number)
      : null;
  const annual = [number('salaryMin'), number('salaryMax')];
  const hourly = [number('hourlyMin'), number('hourlyMax')];
  const values = (
    annual.some((value) => value !== null) ? annual : hourly
  ).filter((value): value is number => value !== null);
  if (!values.length) return 'Pay not stated';
  return `${text(opportunity, 'currency') || 'Currency not stated'} ${values.map((value) => value.toLocaleString('en-US')).join('–')}${annual.some((value) => value !== null) ? ' / year' : ' / hour'}`;
});
</script>

<section class="opportunity-overview" aria-label="Opportunity overview">
  <h2>Opportunity</h2>
  {#if !text(opportunity, 'title')}<p>Role not available.</p>{/if}
  <p>{text(company, 'name') || text(opportunity, 'companyName') || 'Company not stated'}</p>
  <dl>
    <div><dt>Location</dt><dd>{text(opportunity, 'locations') || text(opportunity, 'locationNotes') || 'Location not stated'}</dd></div>
    <div><dt>Work mode</dt><dd>{text(opportunity, 'workMode').replaceAll('_', ' ') || 'Work mode not stated'}</dd></div>
    <div><dt>Pay</dt><dd>{compensation}</dd></div>
  </dl>
  <h3>Posting summary</h3>
  <p class="posting-text">{text(opportunity, 'descriptionSummary') || 'No summary captured. Open the full posting for the original description.'}</p>
  {#each ['responsibilities', 'qualifications'] as key}
    <section aria-label={key === 'responsibilities' ? 'Responsibilities' : 'Qualifications'}>
      <h3>{key === 'responsibilities' ? 'Responsibilities' : 'Qualifications'}</h3>
      {#if items(key).length}
        <ul>{#each items(key) as item}<li>{item}</li>{/each}</ul>
      {:else}
        <p>No {key} captured separately. See the full posting.</p>
      {/if}
    </section>
  {/each}
  <div class="posting-actions">
    {#if opportunity}
      <button type="button" onclick={() => postingOpen = true}>View full posting</button>
    {/if}
    {#if postingUrl}
      <a href={postingUrl} target="_blank" rel="noopener noreferrer">Original posting ↗</a>
    {:else}
      <span>Original posting link not available.</span>
    {/if}
  </div>
</section>
{#if opportunity && postingOpen}
  <OpportunityTriageModal bind:open={postingOpen} singleOpportunity={opportunity} readOnly />
{/if}

<style>
.opportunity-overview { display: grid; gap: 1rem; padding: 1.25rem; color: var(--smrt-color-on-surface); }
h2, h3, p, ul, dl { margin: 0; }
h2 { font: var(--smrt-typography-headline-small-font); }
h3 { font: var(--smrt-typography-title-medium-font); }
dl { display: flex; flex-wrap: wrap; gap: 1rem 2rem; }
dt { color: var(--smrt-color-on-surface-variant); font-size: .85rem; }
dd { margin: .25rem 0 0; }
section { display: grid; gap: .5rem; }
li + li { margin-top: .35rem; }
.posting-text { white-space: pre-wrap; }
.posting-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; }
button { padding: .6rem 1rem; border: 1px solid var(--smrt-color-outline-variant); border-radius: .5rem; background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); cursor: pointer; }
a { color: var(--smrt-color-primary); }
</style>
