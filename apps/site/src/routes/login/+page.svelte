<script lang="ts">
import LogIn from '@lucide/svelte/icons/log-in';

let { data } = $props();
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
      {:else}
        Sign in with your configured identity provider to continue.
      {/if}
    </p>
    <form method="POST">
      <input type="hidden" name="next" value={data.next} />
      <button type="submit">
        <LogIn size={17} strokeWidth={2.2} />
        <span>{data.localDevLogin ? 'Continue locally' : 'Continue securely'}</span>
      </button>
    </form>
  </section>
</main>

<style>
  .login-shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #f7f5ef;
    color: #1a1814;
  }

  .login-panel {
    width: min(100%, 380px);
    border: 1px solid #ded8ca;
    background: #fff;
    padding: 28px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: #746f65;
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
    color: #5d574e;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 42px;
    border: 1px solid #1a1814;
    background: #1a1814;
    color: #fff;
    border-radius: 6px;
    font-weight: 700;
  }
</style>
