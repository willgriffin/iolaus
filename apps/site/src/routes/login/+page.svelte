<script lang="ts">
import LogIn from '@lucide/svelte/icons/log-in';
import LegalLinks from '$lib/components/LegalLinks.svelte';

let { data, form } = $props();
</script>

<svelte:head>
  <title>Sign in — {data.appName}</title>
</svelte:head>

<main class="login-shell">
  <section class="login-panel">
    <p class="eyebrow">Admin</p>
    <h1>Sign in</h1>
    <p class="copy">
      {#if data.localDevLogin}
        Continue with the private local workspace on this computer.
      {:else if data.magicLink}
        Enter the email address you were invited with and we will send you a
        sign-in link.
      {:else}
        Sign in with your configured identity provider to continue.
      {/if}
    </p>
    {#if data.magicLink}
      {#if form?.sent}
        <p class="copy" role="status">
          If that address is invited, a sign-in link is on its way. Check your
          email; the link works once and expires in 15 minutes.
        </p>
      {:else}
        <form method="POST">
          <input type="hidden" name="next" value={data.next} />
          <label for="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autocomplete="email"
            required
            aria-invalid={form?.invalidEmail ? 'true' : undefined}
          />
          {#if form?.invalidEmail}
            <p class="error" role="alert">Enter a valid email address.</p>
          {/if}
          <button type="submit">
            <LogIn size={17} strokeWidth={2.2} />
            <span>Email me a sign-in link</span>
          </button>
        </form>
      {/if}
    {:else}
    <form method="POST">
      <input type="hidden" name="next" value={data.next} />
      <button type="submit">
        <LogIn size={17} strokeWidth={2.2} />
        <span>{data.localDevLogin ? 'Continue locally' : 'Continue securely'}</span>
      </button>
    </form>
    {/if}
    <LegalLinks links={data.links} />
  </section>
</main>

<style>
  .login-shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg, #f7f5ef);
    color: var(--ink, #1a1814);
  }

  .login-panel {
    --legal-links-gap: 22px;
    width: min(100%, 380px);
    border: 1px solid var(--border-strong, #ded8ca);
    background: var(--bg-elev, #fff);
    padding: 28px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--ink-3, #746f65);
    font: 700 11px/1.2 var(--font-mono, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font: 600 30px/1.1 var(--font-serif, Georgia, serif);
  }

  .copy {
    margin: 12px 0 22px;
    color: var(--ink-2, #5d574e);
  }

  label {
    display: block;
    margin-bottom: 6px;
    font-weight: 600;
  }

  input[type='email'] {
    width: 100%;
    min-height: 42px;
    margin-bottom: 14px;
    padding: 0 10px;
    border: 1px solid var(--border-strong, #ded8ca);
    border-radius: 6px;
    box-sizing: border-box;
    font: inherit;
  }

  .error {
    margin: -6px 0 14px;
    color: var(--danger, #b3261e);
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 42px;
    border: 1px solid var(--ink, #1a1814);
    background: var(--ink, #1a1814);
    color: var(--bg, #fff);
    border-radius: 6px;
    font-weight: 700;
  }
</style>
