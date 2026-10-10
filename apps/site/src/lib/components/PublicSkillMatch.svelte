<script lang="ts">
import {
  type PublicFacets,
  publicMatchInputSchema,
  publicMatchResultSchema,
} from '$lib/public-opportunity-contract.js';

let { skills = [] }: { skills?: PublicFacets['skills'] } = $props();
let input = $state('');
let selected = $state<string[]>([]);
let result = $state<ReturnType<typeof publicMatchResultSchema.parse> | null>(
  null,
);
let message = $state('');
let pending = $state(false);
let generation = 0;
let controller: AbortController | undefined;
function invalidate() {
  generation++;
  controller?.abort();
  pending = false;
  result = null;
  message = '';
}
function add(event: SubmitEvent) {
  event.preventDefault();
  const value = input.trim();
  if (!value || value.length > 100 || selected.length >= 100) return;
  invalidate();
  if (!selected.includes(value)) selected = [...selected, value];
  input = '';
}
async function match() {
  invalidate();
  const current = generation;
  controller = new AbortController();
  pending = true;
  try {
    const body = publicMatchInputSchema.parse({ skills: selected });
    const response = await fetch('/api/public/v1/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? 'Please wait a minute before matching again.'
          : 'Matching is temporarily unavailable.',
      );
    const parsed = publicMatchResultSchema.parse(await response.json());
    if (generation === current) result = parsed;
  } catch (error) {
    if (generation === current)
      message =
        error instanceof Error
          ? error.message
          : 'Matching is temporarily unavailable.';
  } finally {
    if (generation === current) pending = false;
  }
}
</script>
<section class="match" aria-labelledby="skill-match-title"><h2 id="skill-match-title">Match your skills</h2><p>Compare skills with public job requirements. Your inputs stay in this page and are sent only when you select Match skills. They are not saved.</p>
<form onsubmit={add}><label for="match-skill">Add a skill</label><div class="controls"><input id="match-skill" list="match-skill-options" bind:value={input} maxlength="100" placeholder="Start typing a skill" autocomplete="off"/><datalist id="match-skill-options">{#each skills as skill}<option value={skill.value}>{skill.label}</option>{/each}</datalist><button disabled={!input.trim() || selected.length >= 100}>Add skill</button></div></form>
<ul class="selected">{#each selected as skill}<li><button aria-label={`Remove ${skill}`} onclick={() => { invalidate(); selected = selected.filter(value => value !== skill); }}>{skill} ×</button></li>{/each}</ul>
<button onclick={match} disabled={!selected.length || pending}>{pending ? 'Matching…' : 'Match skills'}</button><button class="clear" onclick={() => { invalidate(); selected = []; input = ''; }}>Clear skills</button>
<div aria-live="polite">{#if message}<p role="alert">{message}</p>{/if}{#if result}<p>Model calls: {result.model_calls}. Coverage reflects the skills you submitted; other requirements may remain unknown.</p>{#if !result.items.length}<p>No public opportunities are available to compare.</p>{/if}<ol>{#each result.items as item}<li><h3><a href={`/opportunities/${item.opportunity.id}`}>{item.opportunity.title}</a></h3><p>Skill coverage: {Math.round(item.score)}%</p><p>Matched: {item.matched_skills.join(', ') || 'None'}</p><p>Missing: {item.missing_skills.join(', ') || 'None'}</p><p>Unknown requirements: {item.requirements.filter(requirement => requirement.decision === 'unknown').length}</p>{#each item.eligibility_notes as note}<p>{note}</p>{/each}</li>{/each}</ol>{/if}</div></section>
<style>.match{margin-top:2rem;padding-top:1rem;border-top:1px solid #ddd}.controls{display:flex;gap:.5rem;flex-wrap:wrap}input{flex:1;min-width:10rem}input,button{min-height:44px;padding:.5rem .75rem}label{display:block;margin-bottom:.4rem}.selected{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;padding:0}.clear{margin-left:.5rem}ol{padding-left:1.5rem}li{overflow-wrap:anywhere}</style>
