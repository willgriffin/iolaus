<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type { SubmitFunction } from '@sveltejs/kit';
import { enhance } from '$app/forms';
import type { CandidateSkillDiscoverySnapshot } from '$lib/candidate-skill-discovery';

let {
  snapshot,
  form,
}: {
  snapshot: CandidateSkillDiscoverySnapshot;
  form?: {
    ok?: boolean;
    message?: string;
    error?: string;
    snapshot?: CandidateSkillDiscoverySnapshot;
  } | null;
} = $props();
const current = $derived(form?.snapshot ?? snapshot);
const pending = $derived(
  current.proposals.filter((proposal) => proposal.status === 'pending'),
);
let saving = $state(false);
let localError = $state('');
const submit: SubmitFunction = ({ cancel }) => {
  if (saving) {
    cancel();
    return;
  }
  saving = true;
  localError = '';
  return async ({ result, update }) => {
    try {
      if (result.type === 'success' || result.type === 'failure')
        await update({ reset: false });
      else
        localError =
          'Unable to finish this request. Your proposals remain available; try again.';
    } finally {
      saving = false;
    }
  };
};
const aliasDiffers = (label: string, canonical: string) =>
  label.toLowerCase().replace(/[^a-z0-9]/g, '') !==
  canonical.toLowerCase().replace(/[^a-z0-9]/g, '');
const classificationLabel = (classification: string) =>
  classification === 'direct'
    ? 'Direct experience'
    : classification === 'introductory'
      ? 'Introductory experience'
      : 'Unknown — evidence not established';
</script>

<svelte:head><title>Discover skills · Iolaus</title></svelte:head>
<section class="skill-discovery">
  <header><div><h1>Discover skills</h1><p>Find skills evidenced by your private career records. Review every proposal before adding it.</p></div><a href="/admin/career">Back to resume</a></header>
  <p>Direct experience means documented hands-on or primary use. Introductory experience keeps that limitation; unknown evidence is not a missing skill. Confirming adds private skill data and does not publish your resume.</p>
  {#if form?.ok}<p role="status">{form.message}</p>{/if}
  {#if form?.error || localError}<p role="alert">{localError || form?.error}</p>{/if}
  <form method="POST" action="?/discover" use:enhance={submit}><Button type="submit" disabled={saving || current.status === 'complete'}>{saving ? 'Working…' : current.status === 'complete' ? 'Discovery complete' : current.status === 'partial' ? 'Continue skill discovery' : 'Discover skills from career evidence'}</Button></form>
  <p class="scope">{current.scope.description}</p>
  <dl class="counts"><div><dt>Career evidence</dt><dd>{current.scope.candidateEvidenceCount}</dd></div><div><dt>Skills assessed</dt><dd>{current.scope.assessedCount} of {current.scope.vocabularyCount}</dd></div><div><dt>Remaining</dt><dd>{current.scope.remainingCount}</dd></div><div><dt>Awaiting review</dt><dd>{pending.length}</dd></div></dl>
  {#if current.status === 'stale'}<p role="alert">Career evidence has changed. Run discovery again before confirming these proposals.</p>{/if}
  {#if current.status === 'partial'}<p>This discovery is partial. Remaining skills have not been assessed.</p>{/if}
  {#if !current.proposals.length}<p>{current.status === 'idle' ? 'No discovery run yet. Choose Discover skills to begin.' : 'No skill proposals found in this discovery scope.'}</p>{/if}
  <div class="proposals">
    {#each current.proposals as proposal (proposal.id)}
      <article class="proposal" aria-labelledby={`skill-${proposal.id}`}>
        <h2 id={`skill-${proposal.id}`}>{proposal.label}</h2>
        {#if aliasDiffers(proposal.label, proposal.canonicalLabel)}<p>Alias: {proposal.label} → {proposal.canonicalLabel}</p>{/if}
        <p class="classification">{classificationLabel(proposal.classification)}</p>
        {#if proposal.status === 'duplicate'}<p>Already in your canonical skills. No duplicate will be added.</p>{:else if proposal.status === 'confirmed'}<p>Confirmed privately</p>{:else if proposal.status === 'dismissed'}<p>Dismissed</p>{/if}
        {#if proposal.confidence !== null}<p class="muted">Evidence confidence: {(proposal.confidence * 100).toFixed(0)}%</p>{/if}
        <details><summary>Review evidence ({proposal.evidence.length})</summary>{#each proposal.evidence as evidence (evidence.id)}<blockquote><h3>{evidence.title}</h3><p>{evidence.text}</p></blockquote>{/each}{#if !proposal.evidence.length}<p>No attributable evidence supplied.</p>{/if}</details>
        {#if proposal.status === 'pending'}
          <div class="review-actions">
            {#if proposal.classification !== 'unknown'}<form method="POST" action="?/confirm" use:enhance={submit}><input type="hidden" name="id" value={proposal.id} /><input type="hidden" name="expectedRevision" value={proposal.revision} /><Button type="submit" disabled={saving || current.status === 'stale'}>{proposal.classification === 'introductory' ? 'Add as introductory' : 'Add skill'}</Button></form>{:else}<p>Review or clarify your career evidence before adding this skill.</p>{/if}
            <form method="POST" action="?/dismiss" use:enhance={submit}><input type="hidden" name="id" value={proposal.id} /><input type="hidden" name="expectedRevision" value={proposal.revision} /><Button type="submit" disabled={saving}>Dismiss proposal</Button></form>
          </div>
        {/if}
      </article>
    {/each}
  </div>
  <details class="canonical"><summary>Current canonical skills ({current.canonicalSkills.length})</summary><p>{current.canonicalSkills.length ? current.canonicalSkills.join(', ') : 'No canonical skills saved.'}</p></details>
</section>

<style>
.skill-discovery { max-width: 56rem; margin: 0 auto; padding: 1rem; color: var(--smrt-color-on-surface, inherit); }
header { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
h1 { margin: 0; } h2 { font-size: 1.15rem; margin: 0; } h3 { font-size: 1rem; margin: 0; }
p { line-height: 1.5; overflow-wrap: anywhere; } a { color: var(--smrt-color-primary, inherit); }
.counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; margin: 1.5rem 0; } dt { font-size: .85rem; } dd { margin: .3rem 0 0; font-weight: 600; }
.proposals { display: grid; gap: 1rem; } .proposal { border: 1px solid var(--smrt-color-outline-variant, #d1d5db); border-radius: .5rem; padding: 1rem; background: var(--smrt-color-surface-container-low, transparent); min-width: 0; }
.classification { font-weight: 600; } .muted { font-size: .85rem; } summary { cursor: pointer; min-height: 2.75rem; display: flex; align-items: center; }
blockquote { border-left: 3px solid var(--smrt-color-outline-variant, #d1d5db); margin: .5rem 0; padding: .5rem .75rem; } blockquote p { white-space: pre-wrap; }
.review-actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-top: 1rem; } .skill-discovery :global(button) { min-height: 2.75rem; }
[role=alert] { color: var(--smrt-color-error, #b91c1c); } .canonical { margin-top: 1.5rem; }
@media (max-width: 600px) { header { flex-direction: column; } .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .review-actions { align-items: stretch; flex-direction: column; } .review-actions :global(button) { width: 100%; } }
</style>
