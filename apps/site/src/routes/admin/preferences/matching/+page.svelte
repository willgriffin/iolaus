<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import { enhance } from '$app/forms';
import { keepFormValues } from '$lib/admin/form-enhance';

let { data, form } = $props();
const workModeLabels = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};
</script>

<section class="matching-preferences">
  <h1>Matching preferences</h1>
  <p>Choose the roles and locations you want to see in Opportunities. Add one entry per line.</p>
  {#if data.preferences === null}
    <p role="alert">Your saved matching preferences could not be read. Saving this form will replace them.</p>
  {/if}
  {#if form?.message}<p role="status">{form.message}</p>{/if}
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  <form method="POST" use:enhance={keepFormValues}>
    <label for="targetRoles">Target roles</label>
    <textarea id="targetRoles" name="targetRoles" rows="3" placeholder="Senior Backend Engineer" value={data.preferences?.targetRoles.join('\n') ?? ''}></textarea>

    <label for="locations">Target locations</label>
    <textarea id="locations" name="locations" rows="3" placeholder="Canada" value={data.preferences?.locations.join('\n') ?? ''}></textarea>

    <fieldset>
      <legend>Work arrangements</legend>
      {#each data.workModes as mode (mode)}
        <label>
          <input type="checkbox" name="workModes" value={mode} checked={data.preferences?.workModes.includes(mode) ?? false} />
          {workModeLabels[mode]}
        </label>
      {/each}
    </fieldset>

    <label for="remoteCountries">Countries for remote work (optional)</label>
    <textarea id="remoteCountries" name="remoteCountries" rows="3" aria-describedby="remote-help" placeholder="Canada" value={data.preferences?.remoteCountries.join('\n') ?? ''}></textarea>
    <p id="remote-help">List countries you can work from. If blank, matching uses your target locations.</p>

    <Button type="submit">Save matching preferences</Button>
  </form>
  <p><a href="/admin/preferences/screening-questions">Update your screening questions or skill experience</a></p>
</section>

<style>
.matching-preferences { max-width: 56rem; margin: 0 auto; padding: 1rem; }
form { display: grid; gap: .75rem; }
label, legend { font-weight: 600; }
fieldset { display: flex; flex-wrap: wrap; gap: .75rem; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: .6rem; color: inherit; background: transparent; border: 1px solid var(--border-color, #d1d5db); border-radius: .3rem; font: inherit; }
form :global(button) { justify-self: start; }
[role=alert] { color: var(--error-color, #b91c1c); }
</style>
