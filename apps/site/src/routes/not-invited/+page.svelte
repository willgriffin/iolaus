<script lang="ts">
let { data } = $props();
</script>

<svelte:head>
  <title>Not invited yet — {data.appName}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="invite-shell">
  <section class="invite-panel">
    <p class="eyebrow">Invite only</p>
    <h1>You're not invited yet</h1>
    <p class="copy">
      {data.appName} is currently open by invitation only, and this account
      hasn't been invited.
    </p>
    {#if data.contact}
      <p class="copy">
        To request an invite, contact
        <a href={data.contact.href}>{data.contact.label}</a>.
      </p>
    {:else}
      <p class="copy">To request an invite, contact the site operator.</p>
    {/if}
    <p class="copy"><a href="/">Back to the homepage</a></p>
  </section>
</main>

<style>
  .invite-shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #f7f5ef;
    color: #1a1814;
  }

  .invite-panel {
    width: min(100%, 420px);
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
    margin: 12px 0 0;
    color: #5d574e;
  }

  a {
    color: inherit;
    font-weight: 700;
  }
</style>
