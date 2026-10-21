<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Account connections</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="connections">
  <header>
    <h1>Account connections</h1>
    <p>Revoke an application's access at any time. Revocation also stops its refresh tokens.</p>
  </header>

  {#if form?.revoked}<p class="feedback" role="status">Connection revoked.</p>{/if}

  <div class="connection-list">
    {#each data.grants as grant}
      <section class="connection">
        <h2>Client {grant.clientId}</h2>
        <p>{grant.scopes.join(', ')}</p>
        {#if grant.revokedAt}
          <p class="muted">Revoked</p>
        {:else}
          <form method="POST" action="?/revoke">
            <input type="hidden" name="grantId" value={grant.id} />
            <button type="submit">Revoke access</button>
          </form>
        {/if}
      </section>
    {:else}
      <p class="muted">No connected applications.</p>
    {/each}
  </div>
</main>

<style>
  .connections { width:min(100% - 2rem, 46rem); margin:0 auto; padding:clamp(1.5rem, 5vw, 3rem) 0; }
  header { margin-bottom:2rem; }
  h1,h2,p { margin:0; overflow-wrap:anywhere; }
  h1 { font-size:clamp(1.75rem, 5vw, 2.25rem); }
  h2 { font-size:1rem; }
  header p,.muted { margin-top:.5rem; color:var(--smrt-color-on-surface-variant, #475569); line-height:1.5; }
  .feedback { margin-bottom:1rem; color:var(--smrt-color-primary, #075985); }
  .connection-list { display:grid; gap:.75rem; }
  .connection { display:grid; gap:.75rem; padding:1rem; border:1px solid var(--smrt-color-outline-variant, #cbd5e1); border-radius:var(--smrt-radius-large, .75rem); background:var(--smrt-color-surface-container-low, #f8fafc); }
  button { min-height:44px; padding:.55rem .9rem; border:1px solid var(--smrt-color-outline, #94a3b8); border-radius:var(--smrt-radius-medium, .5rem); background:transparent; color:inherit; font:inherit; cursor:pointer; }
  button:hover { background:var(--smrt-color-surface-container-high, #e2e8f0); }
  button:focus-visible { outline:2px solid var(--smrt-color-primary, #075985); outline-offset:3px; }
</style>
