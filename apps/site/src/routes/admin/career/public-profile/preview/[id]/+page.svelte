<script lang="ts">
import type { SubmitFunction } from '@sveltejs/kit';
import { applyAction, enhance } from '$app/forms';
import PublicProfileResume from '$lib/components/PublicProfileResume.svelte';

let { data } = $props();
let publishing = $state(false);
let publishError = $state('');
const publish: SubmitFunction = ({ cancel }) => {
  if (publishing) {
    cancel();
    return;
  }
  publishing = true;
  publishError = '';
  return async ({ result }) => {
    if (result.type === 'failure') {
      publishError =
        typeof result.data?.error === 'string'
          ? result.data.error
          : 'Could not publish this preview. Your currently published profile is unchanged.';
      publishing = false;
      return;
    }
    await applyAction(result);
    publishing = false;
  };
};
</script>

<svelte:head><title>Preview public profile</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<header class="toolbar"><a href="/admin/career/public-profile">Back to public profile settings</a><a href={`/admin/career/public-profile/preview/${encodeURIComponent(data.id)}/resume.pdf`} target="_blank" rel="noopener noreferrer">Open matching PDF</a></header>
<p class="notice">This is the exact prepared version. Publishing makes it available at /people/{data.handle}.</p>
<PublicProfileResume snapshot={data.snapshot} />
{#if publishError}<p class="error" role="alert">{publishError}</p>{/if}
<form method="POST" action="/admin/career/public-profile?/publish" use:enhance={publish} aria-busy={publishing}><input type="hidden" name="revisionId" value={data.id} /><input type="hidden" name="expectedRevision" value={data.baseRevision} /><button type="submit" disabled={publishing}>{publishing ? 'Publishing…' : 'Publish this version'}</button></form>

<style>.toolbar, form, .notice, .error { width: min(100%, 48rem); margin: 1rem auto; padding: 0 clamp(1rem, 4vw, 3rem); display: flex; flex-wrap: wrap; gap: 1rem; } .notice { display: block; } .error { display: block; color: var(--smrt-color-error, #b91c1c); } button { min-height: 44px; padding: .6rem 1rem; font: inherit; color: var(--smrt-color-on-primary, white); background: var(--smrt-color-primary, #075985); border: 0; border-radius: .35rem; cursor: pointer; } button:disabled { cursor: wait; opacity: .7; }</style>
