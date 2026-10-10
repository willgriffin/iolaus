<script lang="ts">
import type { SubmitFunction } from '@sveltejs/kit';
import { enhance } from '$app/forms';

let { data, form } = $props();
let identity = $derived(data.identity);
let selectedProfile = $derived(
  identity?.candidateProfileId || data.profiles[0]?.id || '',
);
let feedback = $derived(form as { error?: string } | null);
let busy = $state<'prepare' | 'unpublish' | null>(null);
let localError = $state('');
const submit: SubmitFunction = ({ cancel, submitter }) => {
  const action =
    submitter?.getAttribute('value') === 'unpublish' ? 'unpublish' : 'prepare';
  if (busy) {
    cancel();
    return;
  }
  busy = action;
  localError = '';
  return async ({ result, update }) => {
    if (result.type === 'failure')
      localError =
        typeof result.data?.error === 'string'
          ? result.data.error
          : 'Could not save your public profile settings.';
    await update({ reset: false });
    busy = null;
  };
};
</script>

<svelte:head><title>Public profile</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<main>
  <header><h1>Public profile</h1><p>Choose what you share, then review the exact page and PDF before publishing.</p></header>
  {#if localError || feedback?.error}<p class="error" role="alert">{localError || feedback?.error}</p>{/if}
  {#if identity?.status === 'published'}
    <section class="status"><h2>Published</h2>{#if data.publicUrl}<p><a href={data.publicUrl} target="_blank" rel="noopener noreferrer">Open your public profile</a></p>{/if}<p>Private edits do not change this version. Prepare and publish a new preview when you are ready.</p><form method="POST" action="?/unpublish" use:enhance={submit}><input type="hidden" name="expectedRevision" value={identity.revision} /><button class="secondary" type="submit" value="unpublish" disabled={busy !== null}>{busy === 'unpublish' ? 'Unpublishing…' : 'Unpublish profile'}</button></form><p class="warning">Unpublishing removes this page and PDF. Copies people already downloaded cannot be recalled.</p></section>
  {:else if identity?.status === 'unpublished'}<p class="status">Your previous public profile is unpublished. Prepare a new version to share it again.</p>{/if}
  {#if data.prepared}<p class="status"><a href={`/admin/career/public-profile/preview/${data.prepared.id}`}>Continue reviewing your prepared version</a></p>{/if}
  {#if !data.profiles.length}<section><h2>Set up your resume first</h2><p>Add a profile and resume content before creating a public profile.</p><a href="/admin/career">Go to your resume</a></section>
  {:else}
    <form class="settings" method="POST" action="?/prepare" use:enhance={submit} aria-busy={busy === 'prepare'}>
      <h2>{identity ? 'Prepare an update' : 'Prepare your public profile'}</h2>
      <label>Public handle <input name="handle" required minlength="3" maxlength="63" pattern={'[a-z][a-z0-9\\-]*'} value={identity?.handle ?? ''} readonly={!!identity} aria-describedby="handle-help" /></label><p id="handle-help">Lowercase letters, numbers, and single hyphens. Your first reserved handle cannot be changed.</p>
      <label>Resume source <select name="profileId">{#each data.profiles as profile}<option value={profile.id} selected={profile.id === selectedProfile}>{profile.label}</option>{/each}</select></label>
      <fieldset><legend>Contact details</legend><label><input type="checkbox" name="email" /> Email</label><label><input type="checkbox" name="phone" /> Phone</label><label><input type="checkbox" name="location" /> Location</label><label><input type="checkbox" name="links" /> External links</label><p>Contact details are off by default.</p></fieldset>
      <fieldset><legend>Sections</legend><label><input type="checkbox" name="experience" checked /> Experience</label><label><input type="checkbox" name="education" checked /> Education</label><label><input type="checkbox" name="skills" checked /> Skills</label><label><input type="checkbox" name="other" checked /> Additional experience</label></fieldset>
      <button type="submit" disabled={busy !== null}>{busy === 'prepare' ? 'Generating preview…' : 'Generate preview'}</button>
    </form>
  {/if}
</main>

<style>main { max-width: 46rem; margin: 0 auto; padding: clamp(1rem, 4vw, 3rem); } h1,h2,p { margin: 0 0 .75rem; } h1 { font-size: clamp(2rem, 8vw, 2.75rem); } header { margin-bottom: 2rem; } .settings,.status,section { display: grid; gap: .75rem; padding: 1rem; margin: 1rem 0; border-radius: .5rem; background: var(--smrt-color-surface-container-low, #f8fafc); } label { display: grid; gap: .35rem; } fieldset label { display: flex; align-items: center; gap: .5rem; min-height: 2rem; } input,select { min-height: 44px; padding: .5rem; font: inherit; } input[type="checkbox"] { min-height: auto; } button { min-height: 44px; width: fit-content; padding: .6rem 1rem; font: inherit; border: 0; border-radius: .35rem; color: var(--smrt-color-on-primary, white); background: var(--smrt-color-primary, #075985); cursor: pointer; } .secondary { background: var(--smrt-color-error, #b91c1c); } .warning,.error { color: var(--smrt-color-error, #b91c1c); } a { color: var(--smrt-color-primary, #075985); overflow-wrap: anywhere; }</style>
