<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import { keepFormValues } from '$lib/admin/form-enhance';
import ScreeningQuestionsEditor from '$lib/components/admin/ScreeningQuestionsEditor.svelte';

let { data, form } = $props();
const skillFeedback = $derived(
  form?.action === 'skillExperience' ? form : null,
);
</script>

<ScreeningQuestionsEditor {data} form={skillFeedback ? null : form} />

<section class="skill-preferences" aria-labelledby="skill-experience-heading">
  <h2 id="skill-experience-heading">Skill experience</h2>
  <p><a href="/admin/resume/skill-discovery">Discover skills from career evidence</a></p>
  <p id="skill-experience-help">Describe your primary skills and any introductory experience. This private, user-verified note helps assess fit and does not change your public resume.</p>
  {#if skillFeedback?.ok}<p role="status">{skillFeedback.message}</p>{/if}
  {#if skillFeedback?.error}<p role="alert">{skillFeedback.error}</p>{/if}
  <form use:enhance={keepFormValues} method="POST" action="?/saveSkillExperience">
    <label for="skillExperience">Your experience</label>
    <textarea id="skillExperience" name="skillExperience" aria-describedby="skill-experience-help" rows="4" maxlength="4000" value={data.skillExperience}></textarea>
    <Button type="submit">Save skill experience</Button>
  </form>
</section>

<style>
.skill-preferences { max-width: 56rem; margin: 0 auto; padding: 1rem; box-sizing: border-box; }
h2 { font-size: 1.25rem; margin: 0; }
p { line-height: 1.5; }
form { display: grid; gap: .75rem; justify-items: start; }
label { font-weight: 600; }
textarea { width: 100%; box-sizing: border-box; min-height: 7rem; resize: vertical; padding: .6rem; color: inherit; background: var(--background-color, transparent); border: 1px solid var(--border-color, #d1d5db); border-radius: .3rem; font: inherit; }
.skill-preferences :global(button) { min-height: 2.75rem; }
[role=alert] { color: var(--error-color, #b91c1c); }
</style>
