<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Terminal Login — {data.appName}</title>
</svelte:head>

<section class="terminal-login">
  <header class="page-header">
    <div>
      <h1>Terminal login</h1>
    </div>
  </header>

  <form class="approval-panel" method="POST" action="?/approve">
    <label>
      <span>Code</span>
      <input value={form?.userCode ?? data.userCode} name="userCode" autocomplete="one-time-code" />
    </label>

    {#if form?.error}
      <p class="error">{form.error}</p>
    {:else if form?.approved}
      <p class="success">Terminal access approved.</p>
    {:else if data.requestStatus === 'expired'}
      <p class="error">This terminal login request has expired.</p>
    {:else if data.requestStatus === 'approved'}
      <p class="success">This terminal login request is already approved.</p>
    {/if}

    <button type="submit">Approve terminal access</button>
  </form>
</section>

<style>
  .terminal-login {
    display: grid;
    gap: 22px;
    max-width: 560px;
  }

  .page-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 16px;
  }

  h1 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-medium-font);
  }

  .approval-panel {
    display: grid;
    gap: 14px;
    padding: 18px;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
  }

  label {
    display: grid;
    gap: 6px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 800;
  }

  input {
    min-height: 42px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    padding: 0 11px;
    color: var(--smrt-color-on-surface);
    font: 800 15px/1 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  button {
    min-height: 40px;
    justify-self: start;
    border: 1px solid var(--smrt-color-error);
    border-radius: 6px;
    padding: 0 13px;
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
    font-weight: 800;
  }

  .error,
  .success {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
  }

  .error {
    color: var(--smrt-color-on-error-container);
  }

  .success {
    color: var(--smrt-color-on-success-container);
  }
</style>
