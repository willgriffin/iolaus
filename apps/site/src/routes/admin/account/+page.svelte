<script lang="ts">
import { enhance } from '$app/forms';
import { keepFormValues } from '$lib/admin/form-enhance';

let { data, form } = $props();

let confirming = $state(false);
let acknowledged = $state(false);
let typedEmail = $state('');
let typedPhrase = $state('');

const matches = $derived(
  acknowledged &&
    typedEmail.trim().toLowerCase() === data.email.trim().toLowerCase() &&
    data.email.trim().length > 0 &&
    typedPhrase.trim() === data.confirmationPhrase,
);
</script>

<svelte:head>
  <title>Account — {data.appName}</title>
</svelte:head>

<section class="account">
  <header class="page-header">
    <h1>Your account and data</h1>
    {#if data.email}<p class="muted">Signed in as {data.email}</p>{/if}
  </header>

  <div class="panel">
    <h2>Download your data</h2>
    <p>
      Download a JSON file of everything in your workspace: profile, evidence, preferences,
      applications, materials, screening questions and decisions, plus a manifest of your
      generated files with links to download them. It contains only your own data.
    </p>
    <p class="muted">
      File download links need you to be signed in and stop working after your account is
      deleted, so save any files you want to keep first.
    </p>
    <a class="button" href="/api/account/export" download>Download my data (JSON)</a>
  </div>

  <div class="panel danger">
    <h2>Delete your account</h2>
    {#if !data.deletionEnabled}
      <p>{data.deletionDisabledMessage}</p>
    {:else}
      <p>
        This permanently deletes your workspace, your uploaded and generated files, your
        sign-in sessions, terminal and MCP access and any queued work, and removes your invitation.
        It cannot be undone. AI usage totals are kept for platform cost accounting but are
        detached from you.
      </p>

      {#if !confirming}
        <button type="button" class="danger-button" onclick={() => (confirming = true)}>
          Delete my account…
        </button>
      {:else}
        <form method="POST" action="?/delete" use:enhance={keepFormValues} class="confirm">
          <p><strong>Final confirmation.</strong> Download your data first if you want a copy.</p>
          <label class="check">
            <input type="checkbox" name="acknowledge" bind:checked={acknowledged} />
            <span>I understand this permanently deletes my account and data.</span>
          </label>
          <label>
            <span>Type your email address ({data.email})</span>
            <input
              name="confirmEmail"
              type="email"
              autocomplete="off"
              bind:value={typedEmail}
            />
          </label>
          <label>
            <span>Type <code>{data.confirmationPhrase}</code></span>
            <input name="confirmPhrase" autocomplete="off" bind:value={typedPhrase} />
          </label>
          {#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
          <div class="actions">
            <button type="submit" class="danger-button" disabled={!matches}>
              Permanently delete my account
            </button>
            <button type="button" class="button" onclick={() => (confirming = false)}>Cancel</button>
          </div>
        </form>
      {/if}
    {/if}
  </div>
</section>

<style>
  .account { display: grid; gap: var(--smrt-spacing-6); max-width: 640px; min-width: 0; }
  h1, h2, p { margin: 0; }
  h1 { font-size: 1.75rem; }
  h2 { font-size: 1.2rem; }
  p { color: var(--smrt-color-on-surface-variant); line-height: 1.5; margin-top: var(--smrt-spacing-2); }
  .muted { font-size: .9rem; }
  .panel { display: grid; gap: var(--smrt-spacing-3); padding: var(--smrt-spacing-5); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-large); background: var(--smrt-color-surface-container-low); }
  .panel.danger { border-color: var(--smrt-color-error); }
  .confirm { display: grid; gap: var(--smrt-spacing-3); }
  label { display: grid; gap: 6px; color: var(--smrt-color-on-surface-variant); font-size: .85rem; font-weight: 700; }
  label.check { display: flex; align-items: flex-start; gap: var(--smrt-spacing-2); font-weight: 600; }
  input[type='email'], input:not([type]) { min-height: 44px; border: 1px solid var(--smrt-color-outline-variant); border-radius: 6px; padding: 0 11px; color: var(--smrt-color-on-surface); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-3); }
  .button, .danger-button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; justify-self: start; padding: 0 var(--smrt-spacing-4); border-radius: 6px; font-weight: 800; text-decoration: none; cursor: pointer; border: 1px solid var(--smrt-color-outline-variant); background: var(--smrt-color-surface); color: var(--smrt-color-primary); }
  .danger-button { border-color: var(--smrt-color-error); background: var(--smrt-color-error); color: var(--smrt-color-on-error); }
  .danger-button:disabled { opacity: .5; cursor: not-allowed; }
  .error { color: var(--smrt-color-error); font-weight: 700; }
</style>
