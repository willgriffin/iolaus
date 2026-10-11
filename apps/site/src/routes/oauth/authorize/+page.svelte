<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Connect your account</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="authorization">
  <header>
    <h1>Connect your account</h1>
    <p>Client <code>{data.clientId}</code> requests access to your account.</p>
  </header>
  <p class="return-address">Registered return address: {data.redirectUri}</p>
  <form method="POST">
    <input type="hidden" name="csrf" value={data.csrf} />
    {#each data.scopes as scope}
      <label class="scope">
        <input type="checkbox" name="scope" value={scope.name} checked={scope.permitted} disabled={!scope.permitted} />
        <span><strong>{scope.name}</strong> — {scope.description}{#if !scope.permitted} (Unavailable for your current permissions){/if}</span>
      </label>
    {/each}
    <p class="help">You can revoke this connection from account connections. Preparing drafts never approves or submits an application.</p>
    <div class="actions">
      <button name="decision" value="approve">Allow selected access</button>
      <button class="secondary" name="decision" value="deny">Deny</button>
    </div>
    {#if form?.denied}<p class="error" role="alert">Access was not granted. Start a new connection request to try again.</p>{/if}
  </form>
</main>

<style>
  .authorization { width:min(100% - 2rem, 42rem); margin:0 auto; padding:clamp(1.5rem, 5vw, 3rem) 0; }
  header { margin-bottom:1rem; }
  h1,p { margin:0; overflow-wrap:anywhere; }
  h1 { font-size:clamp(1.75rem, 5vw, 2.25rem); }
  header p,.help,.return-address { margin-top:.65rem; color:var(--smrt-color-on-surface-variant, #475569); line-height:1.5; }
  .return-address { padding:.75rem 1rem; border-left:3px solid var(--smrt-color-outline-variant, #cbd5e1); }
  form { display:grid; gap:1rem; margin-top:1.5rem; }
  .scope { display:flex; align-items:flex-start; gap:.65rem; line-height:1.5; }
  .scope input { margin-top:.25rem; }
  .actions { display:flex; flex-wrap:wrap; gap:.75rem; }
  button { min-height:44px; padding:.55rem .9rem; border:1px solid var(--smrt-color-primary, #075985); border-radius:var(--smrt-radius-medium, .5rem); background:var(--smrt-color-primary, #075985); color:var(--smrt-color-on-primary, white); font:inherit; cursor:pointer; }
  .secondary { border-color:var(--smrt-color-outline, #94a3b8); background:transparent; color:inherit; }
  button:focus-visible { outline:2px solid var(--smrt-color-primary, #075985); outline-offset:3px; }
  .error { color:var(--smrt-color-error, #b91c1c); }
</style>
