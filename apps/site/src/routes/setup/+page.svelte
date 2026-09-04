<script lang="ts">
import type { PageProps } from './$types';

let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Welcome to Iolaus</title></svelte:head>

<main>
  <h1>Welcome to Iolaus</h1>
  {#if !data.available}
    <p>This app is already set up.</p>
  {:else}
    <p>Enter your name and email to get started.</p>
    <p>Your information stays in your private workspace on this computer.</p>
    {#if form?.message}<p role="alert">{form.message}</p>{/if}
    <form method="POST">
      <input type="hidden" name="token" value={data.token} />
      <label>Name <input name="name" autocomplete="name" required /></label>
      <label>Email address <input name="email" type="email" autocomplete="email" required /></label>
      <button type="submit">Get started</button>
    </form>
  {/if}
</main>

<style>
  main { max-width: 36rem; margin: 4rem auto; padding: 1.5rem; }
  form { display: grid; gap: 1rem; }
  label { display: grid; gap: 0.35rem; }
  input { padding: 0.65rem; }
  button { width: fit-content; padding: 0.65rem 1rem; }
</style>
