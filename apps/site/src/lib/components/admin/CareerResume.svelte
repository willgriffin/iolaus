<script lang="ts">
import { ChevronDown, ChevronUp, Eye, EyeOff, Pencil } from '@lucide/svelte';
import type { SubmitFunction } from '@sveltejs/kit';
import { tick } from 'svelte';
import { enhance } from '$app/forms';
import { beforeNavigate } from '$app/navigation';
import type {
  CareerEditorSection,
  CareerManagementData,
  CareerSectionKey,
} from '$lib/server/career-management';

let { data }: { data: CareerManagementData } = $props();
const tabs = [
  { id: 'details', label: 'Details', groups: ['summary', 'education'] },
  { id: 'experience', label: 'Experience', groups: ['experience', 'other'] },
  { id: 'skills', label: 'Skills', groups: ['skills'] },
] as const;
let selectedTab = $state('details');
async function selectTab(id: string) {
  if (id === selectedTab) return;
  if (active && !(await closeEditor())) return;
  selectedTab = id;
  await tick();
  document.getElementById(`resume-tab-${id}`)?.focus();
}
function tabKey(event: KeyboardEvent, index: number) {
  let next: number;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft')
    next = (index + tabs.length - 1) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  void selectTab(tabs[next].id);
}
let active = $state<string | null>(null);
let draft = $state<Record<string, string>>({});
let baseline = $state('');
let saving = $state(false);
let localError = $state('');
let notice = $state('');
let showHidden = $state<Record<string, boolean>>({});
let expandedChildren = $state<Record<string, boolean>>({});
let trigger: HTMLButtonElement | null = null;
let triggerId = '';
let activeGroup = 'summary';
const dirty = $derived(active !== null && JSON.stringify(draft) !== baseline);
const sections: Array<{ id: string; label: string; keys: CareerSectionKey[] }> =
  [
    { id: 'summary', label: 'Summary & contact', keys: ['profile', 'links'] },
    { id: 'skills', label: 'Skills', keys: ['skillGroups', 'skillCategories'] },
    {
      id: 'experience',
      label: 'Experience',
      keys: ['experiences', 'projects', 'achievements', 'duties'],
    },
    { id: 'other', label: 'Other experience', keys: ['other'] },
    { id: 'education', label: 'Education', keys: ['education'] },
  ];
type Entry = {
  section: CareerEditorSection;
  record: CareerEditorSection['records'][number];
};
const entries = $derived(
  data.sections.flatMap((section) =>
    section.records.map((record) => ({ section, record })),
  ),
);
const keyFor = (entry: Entry) => entry.section.key + ':' + entry.record.id;
const visible = (entry: Entry, group: string) =>
  entry.record.presentation?.inResume !== false || showHidden[group];
function restoreFocus() {
  const currentTrigger = document.getElementById(triggerId);
  if (currentTrigger) currentTrigger.focus();
  else if (trigger?.isConnected) trigger.focus();
  else document.getElementById(`resume-hidden-${activeGroup}`)?.focus();
}
function mayLeave() {
  if (saving) return false;
  return (
    !dirty ||
    window.confirm(
      'Discard your unsaved changes? Choose Cancel to keep editing.',
    )
  );
}
async function closeEditor() {
  if (!mayLeave()) return false;
  active = null;
  draft = {};
  baseline = '';
  localError = '';
  await tick();
  restoreFocus();
  return true;
}
async function openEditor(entry: Entry, event: MouseEvent) {
  if (active === keyFor(entry)) {
    await closeEditor();
    return;
  }
  if (!mayLeave()) return;
  trigger = event.currentTarget as HTMLButtonElement;
  triggerId = trigger.id;
  activeGroup =
    sections.find((group) => group.keys.includes(entry.section.key))?.id ||
    'summary';
  active = keyFor(entry);
  draft = { ...entry.record.values };
  baseline = JSON.stringify(draft);
  localError = '';
  notice = '';
  await tick();
  document
    .getElementById('resume-inline-editor')
    ?.querySelector<HTMLElement>('input:not([type="hidden"]),textarea')
    ?.focus();
}
async function toggleHidden(group: string) {
  if (active && !(await closeEditor())) return;
  showHidden[group] = !showHidden[group];
  await tick();
  document.getElementById(`resume-hidden-${group}`)?.focus();
}
async function toggleChildren(id: string) {
  if (active && !(await closeEditor())) return;
  expandedChildren[id] = !expandedChildren[id];
  await tick();
  document.getElementById(`resume-children-${id}`)?.focus();
}
beforeNavigate(({ cancel }) => {
  if (!mayLeave()) cancel();
});
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty || saving) {
    event.preventDefault();
    event.returnValue = '';
  }
}
const submit: SubmitFunction = ({ cancel, formElement }) => {
  if (saving) {
    cancel();
    return;
  }
  saving = true;
  localError = '';
  notice = '';
  return async ({ result, update }) => {
    try {
      if (result.type === 'success' && result.data?.ok === true) {
        await update({ reset: false });
        notice =
          typeof result.data.message === 'string'
            ? result.data.message
            : 'Saved.';
        const savedEntry = entries.find((entry) => keyFor(entry) === active);
        if (
          savedEntry?.record.presentation?.inResume === false &&
          !showHidden[activeGroup]
        )
          notice +=
            ' This entry is now hidden from the canonical resume. Use Show hidden to edit it again.';
        saving = false;
        active = null;
        draft = {};
        baseline = '';
        await tick();
        restoreFocus();
      } else {
        localError =
          result.type === 'failure' && typeof result.data?.error === 'string'
            ? result.data.error
            : 'Could not save. Your changes are still here; please try again.';
        saving = false;
        await tick();
        (
          formElement.querySelector<HTMLElement>(':invalid') ??
          formElement.querySelector<HTMLElement>(
            'input:not([type="hidden"]),textarea',
          )
        )?.focus();
      }
    } catch {
      localError =
        'Could not save. Your changes are still here; please try again.';
    } finally {
      saving = false;
    }
  };
};
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#snippet editor(entry: Entry)}
  {#if active === keyFor(entry)}
    <form id="resume-inline-editor" method="POST" action="?/save" use:enhance={submit} aria-label={'Edit ' + (entry.record.presentation?.title || entry.section.label)} aria-busy={saving}>
      <input type="hidden" name="section" value={entry.section.key} />
      <input type="hidden" name="id" value={entry.record.id} />
      {#each entry.section.fields as field (field.key)}
        <label for={'resume-field-' + field.key}>{field.label}</label>
        {#if field.multiline}
          <textarea id={'resume-field-' + field.key} name={field.key} rows="4" maxlength="50000" bind:value={draft[field.key]} disabled={saving} aria-describedby={localError ? 'resume-editor-error' : undefined}></textarea>
        {:else}
          <input id={'resume-field-' + field.key} name={field.key} type={field.type ?? 'text'} maxlength="50000" bind:value={draft[field.key]} disabled={saving} aria-describedby={localError ? 'resume-editor-error' : undefined} />
        {/if}
      {/each}
      {#if localError}<p id="resume-editor-error" class="error" role="alert">{localError}</p>{/if}
      <div class="editor-actions"><button class="save" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button><button type="button" onclick={closeEditor} disabled={saving}>Cancel</button></div>
      <a href={entry.section.href}>Manage detailed {entry.section.label.toLowerCase()} records</a>
    </form>
  {/if}
{/snippet}

{#snippet row(entry: Entry, child = false)}
  {@const presentation = entry.record.presentation}
  <div class:record-card={!child} class:related-row={child} class:editing={active === keyFor(entry)}>
    {#if active === keyFor(entry)}
      <div class="edit-heading"><strong>{presentation?.title || entry.section.label}</strong>{#if presentation?.context}<span class="context">{presentation.context}</span>{/if}</div>
      {@render editor(entry)}
    {:else}
    <button id={'resume-record-' + entry.section.key + '-' + entry.record.id} class="record-trigger" type="button" aria-expanded="false" onclick={(event) => openEditor(entry, event)} disabled={saving}>
      <span class="record-copy"><strong>{presentation?.title || 'Record details unavailable'}</strong>
        {#if presentation?.context}<span class="context">{presentation.context}</span>{/if}
        <span class="preview">{presentation?.preview || (entry.section.key === 'profile' ? 'Add a summary' : 'Add details')}</span>
        {#if presentation?.inResume === false}<span class="membership"><EyeOff size={14} /> Hidden from canonical resume</span>
        {:else if presentation?.inResume === null || !presentation}<span class="membership">Canonical details unavailable</span>{/if}
      </span><Pencil size={18} aria-hidden="true" />
    </button>
    {#if presentation?.hiddenReason}<p class="reason">{presentation.hiddenReason}</p>{/if}
    {/if}
  </div>
{/snippet}

<div class="resume-manager">
  <div class="resume-tabs" role="tablist" aria-label="Resume sections">
    {#each tabs as tab, index}<button type="button" role="tab" id={`resume-tab-${tab.id}`} aria-selected={selectedTab === tab.id} aria-controls={`resume-panel-${tab.id}`} tabindex={selectedTab === tab.id ? 0 : -1} disabled={saving} onclick={() => selectTab(tab.id)} onkeydown={(event) => tabKey(event, index)}>{tab.label}</button>{/each}
  </div>
  <div role="tabpanel" id={`resume-panel-${selectedTab}`} aria-labelledby={`resume-tab-${selectedTab}`}>
  <p class="feedback" role="status" aria-live="polite">{notice}</p>
  {#if !data.loadedComplete}<p class="load-notice">Only part of the available data is loaded. Counts describe loaded entries; unavailable entries are not classified as hidden. Open detailed records to see more.</p>{/if}
  {#each sections.filter(group => tabs.find(tab => tab.id === selectedTab)?.groups.some(id => id === group.id)) as group (group.id)}
    {@const groupEntries = entries.filter((entry) => group.keys.includes(entry.section.key))}
    {@const hiddenCount = groupEntries.filter((entry) => entry.record.presentation?.inResume === false).length + (group.id === 'skills' ? data.skillExclusions.length : 0)}
    {@const resumeCount = groupEntries.filter((entry) => entry.record.presentation?.inResume === true).length}
    <section aria-labelledby={'resume-' + group.id}>
      <div class="section-heading"><div><h2 id={'resume-' + group.id}>{group.label}</h2><p class="counts">{resumeCount} in resume · {groupEntries.length + (group.id === 'skills' ? data.skillExclusions.length : 0)} loaded{#if hiddenCount} · {hiddenCount} hidden{/if}</p></div>
        <button id={'resume-hidden-' + group.id} class="hidden-toggle" type="button" aria-label={(showHidden[group.id] ? 'Hide' : 'Show') + ' hidden ' + group.label.toLowerCase()} aria-pressed={Boolean(showHidden[group.id])} onclick={() => toggleHidden(group.id)} disabled={saving} title="Show or hide loaded entries excluded from the canonical resume">
          {#if showHidden[group.id]}<Eye size={20} />{:else}<EyeOff size={20} />{/if}<span>{hiddenCount}</span>
        </button>
      </div>
      <div class="records">
        {#each groupEntries.filter((entry) => visible(entry, group.id) && (group.id !== 'experience' || entry.section.key === 'experiences' || !entry.record.presentation?.parentExperienceId || !groupEntries.some((parent) => parent.section.key === 'experiences' && parent.record.id === entry.record.presentation?.parentExperienceId && visible(parent, group.id)))) as entry (keyFor(entry))}
          {@render row(entry)}
          {#if entry.section.key === 'experiences'}
            {@const children = groupEntries.filter((child) => child.record.presentation?.parentExperienceId === entry.record.id)}
            {@const shownChildren = children.filter((child) => visible(child, group.id))}
            {#if children.length}
              <div class="related">
                <button id={'resume-children-' + entry.record.id} class="children-toggle" type="button" aria-expanded={Boolean(expandedChildren[entry.record.id])} aria-controls={expandedChildren[entry.record.id] ? 'resume-related-' + entry.record.id : undefined} onclick={() => toggleChildren(entry.record.id)} disabled={saving}>
                  {#if expandedChildren[entry.record.id]}<ChevronUp size={18} />{:else}<ChevronDown size={18} />{/if}
                  {children.filter((child) => child.section.key === 'projects').length} projects · {children.filter((child) => child.section.key !== 'projects').length} bullets{#if children.some((child) => child.record.presentation?.inResume === false)} · {children.filter((child) => child.record.presentation?.inResume === false).length} hidden{/if}
                </button>
                {#if expandedChildren[entry.record.id]}<div id={'resume-related-' + entry.record.id}>{#each shownChildren as child (keyFor(child))}{@render row(child, true)}{:else}<p>No related entries on your resume. Show hidden to review excluded entries.</p>{/each}</div>{/if}
              </div>
            {/if}
          {/if}
        {:else}<p class="empty">No entries on your resume.{#if hiddenCount} Show hidden to review excluded entries.{/if}</p>{/each}
        {#if group.id === 'skills' && showHidden.skills}
          {#each data.skillExclusions as skill (skill.id)}<div class="related-row readonly"><strong>{skill.title}</strong><p>{skill.context} · Excluded skill membership</p><a href={skill.href}>Manage inclusion in detailed records</a></div>{/each}
        {/if}
      </div>
      <div class="manage-links">{#each data.sections.filter((section) => group.keys.includes(section.key)) as section (section.key)}<a href={section.href}>Manage {section.label.toLowerCase()}</a>{/each}{#if group.id === 'skills'}<a href="/admin/skills">Manage skills and memberships</a>{/if}</div>
    </section>
  {/each}
  </div>
</div>

<style>
:global(.admin-content:has(.resume-manager) .smrt-breadcrumbs) { display:none; }
.resume-tabs { display:flex; gap:.25rem; border-bottom:1px solid var(--border-strong); }
.resume-tabs button { padding:.8rem 1.2rem; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--ink-3); font:inherit; cursor:pointer; }
.resume-tabs button[aria-selected="true"] { color:var(--ink); border-bottom-color:var(--accent); font-weight:700; }
.resume-tabs button:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; }
[role="tabpanel"] { display:grid; gap:1rem; }

  .resume-manager { width: 100%; min-width: 0; max-width: 65rem; color: var(--smrt-color-on-surface); }
  .section-heading { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  h2, p { margin: 0; } h2 { font-size: 1.25rem; }
  p, .context, .preview { line-height: 1.5; overflow-wrap: anywhere; color: var(--smrt-color-on-surface-variant); }
  a { display: inline-flex; align-items: center; min-height: 44px; color: var(--smrt-color-primary); overflow-wrap: anywhere; }
  section { margin-block: 1.5rem 2rem; } .section-heading { margin-bottom: .75rem; } .counts { margin-top: .25rem; font-size: .85rem; }
  .records { display: grid; gap: .75rem; } .record-card { border-radius: var(--smrt-radius-large, .75rem); background: var(--smrt-color-surface-container-low, var(--smrt-color-surface-container)); min-width: 0; }
  button { font: inherit; cursor: pointer; min-height: 44px; color: var(--smrt-color-on-surface); background: transparent; border: 0; }
  button:disabled { cursor: wait; opacity: .65; } .record-trigger { display: flex; align-items: center; justify-content: space-between; text-align: left; gap: .75rem; width: 100%; padding: 1rem; }
  .record-trigger > :global(svg) { flex: 0 0 auto; color: var(--smrt-color-primary); }
  .record-copy { display: grid; gap: .3rem; min-width: 0; } .record-copy strong, .preview, .context { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
  .edit-heading { display: grid; gap: .3rem; padding: 1rem; overflow-wrap: anywhere; }
  .context { font-size: .85rem; } .preview { font-size: .95rem; } .membership { display: flex; align-items: center; gap: .35rem; font-size: .8rem; color: var(--smrt-color-on-surface-variant); }
  .hidden-toggle { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; min-width: 44px; padding: .5rem; border-radius: var(--smrt-radius-medium, .5rem); }
  .related { padding: 0 .5rem; margin-top: -.5rem; } .children-toggle { display: flex; align-items: center; gap: .5rem; padding: .5rem; text-align: left; }
  .related-row { border-bottom: 1px solid var(--smrt-color-outline-variant); min-width: 0; } .related-row .record-trigger { padding: .75rem .5rem; } .readonly { padding: .75rem .5rem; }
  .manage-links { display: flex; flex-wrap: wrap; gap: .25rem 1rem; font-size: .85rem; margin-top: .5rem; }
  .reason { font-size: .85rem; padding: 0 1rem .75rem; } .feedback { min-height: 1.5rem; margin-top: .75rem; color: var(--smrt-color-primary); } .load-notice { padding: .75rem 0; }
  form { padding: 0 1rem 1rem; display: grid; gap: .5rem; } label { margin-top: .5rem; font-size: .9rem; }
  input, textarea { box-sizing: border-box; width: 100%; min-width: 0; font: inherit; font-size: 16px; color: var(--smrt-color-on-surface); background: var(--smrt-color-surface); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small, .25rem); padding: .75rem; }
  textarea { resize: vertical; } .editor-actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: .5rem; } .editor-actions button { padding: .65rem 1.25rem; border-radius: var(--smrt-radius-medium, .5rem); }
  .save { background: var(--smrt-color-primary); color: var(--smrt-color-on-primary); } .error { color: var(--smrt-color-error); } .empty { padding: 1rem 0; }
  :is(a, button, input, textarea):focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
  @media (max-width: 600px) { section { margin-block: 1.25rem 1.5rem; } .related { padding-inline: .25rem; } }
</style>
