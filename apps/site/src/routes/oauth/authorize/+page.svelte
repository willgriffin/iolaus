<script lang="ts">
let { data, form } = $props();
</script>
<svelte:head><title>Connect your account</title><meta name="robots" content="noindex" /></svelte:head>
<main class="mx-auto max-w-xl p-8">
  <h1 class="text-2xl font-bold">Connect your account</h1>
  <p class="my-4">Client <code>{data.clientId}</code> requests access to your account.</p>
  <p class="break-all">Registered return address: {data.redirectUri}</p>
  <form method="POST" class="my-6 space-y-4">
    <input type="hidden" name="csrf" value={data.csrf} />
    {#each data.scopes as scope}
      <label class="block"><input type="checkbox" name="scope" value={scope.name} checked={scope.permitted} disabled={!scope.permitted} /> <strong>{scope.name}</strong> — {scope.description}{#if !scope.permitted} (Unavailable for your current permissions){/if}</label>
    {/each}
    <p>You can revoke this connection from account connections. Preparing drafts never approves or submits an application.</p>
    <button name="decision" value="approve" class="rounded border px-4 py-2">Allow selected access</button>
    <button name="decision" value="deny" class="rounded border px-4 py-2">Deny</button>
    {#if form?.denied}<p role="alert">Access was not granted. Start a new connection request to try again.</p>{/if}
  </form>
</main>
