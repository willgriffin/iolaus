<script lang="ts">
import { detectUrlIntake, type UrlIntakeKind } from '$lib/url-intake';
import { ADMIN_RESOURCE_REFRESH_EVENT } from './admin-resource-hydration';

let dialog: HTMLDialogElement;
let url = $state('');
let kind = $state<'auto' | UrlIntakeKind>('auto');
let busy = $state(false);
let error = $state('');
let result = $state<{ status: string; message: string; href?: string } | null>(
  null,
);
const detection = $derived.by(() => {
  try {
    return url.trim() ? detectUrlIntake(url) : null;
  } catch {
    return null;
  }
});

function open() {
  url = '';
  kind = 'auto';
  error = '';
  result = null;
  if (!dialog.open) dialog.showModal();
}
async function add(event: SubmitEvent) {
  event.preventDefault();
  if (busy) return;
  error = '';
  result = null;
  try {
    detectUrlIntake(url);
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : 'Enter a public HTTPS URL.';
    return;
  }
  busy = true;
  try {
    const response = await fetch('/api/admin/url-intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, kind }),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        typeof payload.error === 'string'
          ? payload.error
          : 'Unable to add this URL.',
      );
    if (
      !payload ||
      !['needs_choice', 'queued', 'saved'].includes(payload.status) ||
      typeof payload.message !== 'string'
    )
      throw new Error(
        'The URL intake returned an unexpected response. Try again.',
      );
    if (payload.status === 'needs_choice') {
      kind = 'auto';
      error = payload.message;
      return;
    }
    result = {
      status: payload.status,
      message: payload.message,
      ...(typeof payload.href === 'string' &&
      /^\/admin\/(?:opportunities|sources)\/[\w-]+$/u.test(payload.href)
        ? { href: payload.href }
        : {}),
    };
    window.dispatchEvent(new Event(ADMIN_RESOURCE_REFRESH_EVENT));
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'Unable to add this URL. Try again.';
  } finally {
    busy = false;
  }
}
</script>

<button type="button" class="add-url-button" onclick={open}>Add URL</button>
<dialog bind:this={dialog} aria-labelledby="url-intake-title" oncancel={(event) => {if(busy) event.preventDefault();}}>
  <header>
    <h2 id="url-intake-title">Add a URL</h2>
    <button type="button" class="close" aria-label="Close Add URL" disabled={busy} onclick={() => dialog.close()}>×</button>
  </header>
  <p>Paste one job posting, a job board, or a company careers page.</p>
  {#if result}
    <div role="status" class="result">
      <p>{result.message}</p>
      {#if result.href}<a href={result.href}>Open {detection?.kind === 'source' || kind === 'source' ? 'source' : 'opportunity'}</a>{/if}
    </div>
    <div class="actions"><button type="button" onclick={() => dialog.close()}>Done</button><button type="button" class="secondary" onclick={open}>Add another URL</button></div>
  {:else}
    <form onsubmit={add}>
      <label for="url-intake-url">Public URL</label>
      <input id="url-intake-url" name="url" type="url" required maxlength="2048" autocomplete="off" placeholder="https://jobs.ashbyhq.com/company" bind:value={url} disabled={busy} oninput={() => {kind='auto';error='';}} />
      {#if detection?.kind === 'choice'}
        <fieldset disabled={busy}>
          <legend>What does this page contain?</legend>
          <label><input type="radio" name="kind" value="opportunity" bind:group={kind} /> One opportunity</label>
          <label><input type="radio" name="kind" value="source" bind:group={kind} /> A job board or careers page</label>
        </fieldset>
        <p class="hint">This URL does not identify the page type. Choose what you found.</p>
      {:else if detection}
        <p class="hint">{detection.kind === 'source' ? 'Job board detected. Save it and pull up to 25 listings once.' : 'Job posting detected. Import it and queue processing.'}</p>
      {/if}
      <p class="hint">Public pages only. Sign-in links cannot be imported.</p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="actions"><button type="submit" disabled={busy || detection?.kind === 'choice' && kind === 'auto'}>{busy ? 'Adding…' : 'Add URL'}</button><button type="button" class="secondary" disabled={busy} onclick={() => dialog.close()}>Cancel</button></div>
    </form>
  {/if}
</dialog>

<style>
  button {font:inherit;cursor:pointer;border:1px solid var(--smrt-color-outline-variant);border-radius:.4rem;padding:.45rem .75rem;background:var(--smrt-color-surface);color:var(--smrt-color-on-surface);}
  button:disabled {opacity:.6;cursor:wait;}
  dialog {width:min(32rem,calc(100vw - 2rem));box-sizing:border-box;border:1px solid var(--smrt-color-outline-variant);border-radius:.65rem;padding:1.25rem;background:var(--smrt-color-surface);color:var(--smrt-color-on-surface);}
  dialog::backdrop {background:rgb(0 0 0 / .55);}
  header {display:flex;align-items:center;justify-content:space-between;gap:1rem;}
  h2 {font-size:1.15rem;margin:0;}
  .close {font-size:1.3rem;line-height:1;padding:.2rem .45rem;}
  p {line-height:1.5;}
  form {display:grid;gap:.6rem;}
  input[type='url'] {min-width:0;width:100%;box-sizing:border-box;padding:.6rem;border:1px solid var(--smrt-color-outline-variant);border-radius:.35rem;background:var(--smrt-color-surface-container);color:inherit;font:inherit;}
  fieldset {margin:0;padding:.75rem;border:1px solid var(--smrt-color-outline-variant);border-radius:.35rem;}
  fieldset label {display:flex;align-items:center;gap:.5rem;margin:.55rem 0;}
  .hint {font-size:.85rem;color:var(--smrt-color-on-surface-variant);margin:.1rem 0;}
  .actions {display:flex;flex-wrap:wrap;gap:.6rem;margin-top:.65rem;}
  .secondary {background:transparent;}
  .error {color:var(--smrt-color-error);margin:.25rem 0;}
  a {color:var(--smrt-color-primary);}
</style>
