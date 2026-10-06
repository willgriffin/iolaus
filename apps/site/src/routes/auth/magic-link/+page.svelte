<script lang="ts">
import LogIn from '@lucide/svelte/icons/log-in';

let { data, form } = $props();
</script>

<svelte:head>
  <title>Sign in — {data.appName}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="shell">
  <section class="panel">
    <h1>Finish signing in</h1>
    {#if form?.invalid || !data.token}
      <p class="copy" role="alert">
        This sign-in link is invalid, has expired, or was already used.
        <a href="/login">Request a new link</a>.
      </p>
    {:else}
      <p class="copy">Continue to {data.appName} with this one-time link.</p>
      <form method="POST">
        <input type="hidden" name="token" value={data.token} />
        <button type="submit">
          <LogIn size={17} strokeWidth={2.2} />
          <span>Sign in</span>
        </button>
      </form>
    {/if}
  </section>
</main>

<style>
  .shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg, #f7f5ef);
    color: var(--ink, #1a1814);
  }

  .panel {
    width: min(100%, 380px);
    border: 1px solid var(--border-strong, #ded8ca);
    background: var(--bg-elev, #fff);
    padding: 28px;
  }

  h1 {
    margin: 0;
    font: 600 26px/1.1 var(--font-serif, Georgia, serif);
  }

  .copy {
    margin: 12px 0 22px;
    color: var(--ink-2, #5d574e);
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
