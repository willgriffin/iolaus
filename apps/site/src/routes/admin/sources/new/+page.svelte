<script lang="ts">
import {
  CheckboxInput,
  SelectInput,
  TextInput,
} from '@happyvertical/smrt-svelte/forms';

let { data, form } = $props();
</script>

<section class="source-setup" aria-labelledby="source-setup-title">
  <header>
    <a href="/admin/sources">← Sources</a>
    <h1 id="source-setup-title">Add a job source</h1>
    <p>
      Save a job board or careers page first. Iolaus will not contact it until
      you or your agent explicitly asks it to pull listings.
    </p>
  </header>

  <form method="POST" action="?/create">
    <TextInput
      name="name"
      required
      label="Name"
      placeholder="OpenAI Careers"
      description="A name you will recognize later."
      value=""
    />
    <SelectInput
      name="type"
      label="Source type"
      options={data.sourceTypes}
      value="job_board"
      description="Where these listings come from."
    />
    <SelectInput
      name="provider"
      required
      label="Provider"
      options={[
        { label: 'Ashby', value: 'ashby' },
        { label: 'Greenhouse', value: 'greenhouse' },
        { label: 'Lever', value: 'lever' },
        { label: 'Other supported provider', value: 'generic-careers' },
      ]}
      value="ashby"
      description="The job-board system that powers the source."
    />
    <TextInput
      name="url"
      required
      label="Root URL"
      placeholder="https://jobs.ashbyhq.com/openai"
      description="Use the careers or board address, not an individual job posting."
      value=""
    />
    <CheckboxInput
      name="active"
      label="Ready to pull listings"
      description="This makes the source available to your agent. Saving still does not pull anything."
      checked={false}
    />

    {#if form?.error}
      <p class="form-error" role="alert">{form.error}</p>
    {/if}

    <div class="actions">
      <button type="submit">Save source</button>
      <a href="/admin/sources">Cancel</a>
    </div>
  </form>
</section>

<style>
  .source-setup { max-width: 42rem; }
  header { margin-bottom: 1.5rem; }
  header a, .actions a { color: var(--color-primary-600, #2563eb); }
  h1 { margin: 0.65rem 0 0.35rem; }
  header p { color: var(--color-neutral-600, #525252); line-height: 1.5; }
  form { display: grid; gap: 1rem; }
  .actions { align-items: center; display: flex; gap: 1rem; margin-top: 0.5rem; }
  button { background: var(--color-primary-600, #2563eb); border: 0; border-radius: 0.4rem; color: white; cursor: pointer; font: inherit; padding: 0.7rem 1rem; }
  .form-error { color: var(--color-danger-600, #b91c1c); margin: 0; }
</style>
