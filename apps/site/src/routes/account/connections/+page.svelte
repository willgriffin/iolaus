<script lang="ts">let { data, form } = $props();
</script>
<svelte:head><title>Account connections</title><meta name="robots" content="noindex" /></svelte:head>
<main class="mx-auto max-w-2xl p-8">
<h1 class="text-2xl font-bold">Account connections</h1>
<p class="my-4">Revoke an application's access at any time. Revocation also stops its refresh tokens.</p>
{#if form?.revoked}<p role="status">Connection revoked.</p>{/if}
{#each data.grants as grant}
<section class="my-4 rounded border p-4"><h2 class="break-all">Client {grant.clientId}</h2><p>{grant.scopes.join(', ')}</p>
{#if grant.revokedAt}<p>Revoked</p>{:else}<form method="POST" action="?/revoke"><input type="hidden" name="grantId" value={grant.id} /><button class="mt-2 rounded border px-4 py-2">Revoke access</button></form>{/if}</section>
{:else}<p>No connected applications.</p>{/each}
</main>
