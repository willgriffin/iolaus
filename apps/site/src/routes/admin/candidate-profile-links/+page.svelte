<script lang="ts">
import { Globe2, Link } from '@lucide/svelte';
import type { SubmitFunction } from '@sveltejs/kit';
import { getContext } from 'svelte';
import { enhance } from '$app/forms';
import {
  ADMIN_HEADER_ACTIONS,
  type AdminHeaderActions,
} from '$lib/admin/header-actions';
import { adminBackLink } from '$lib/admin/navigation';
import AdminBackLink from '$lib/components/admin/AdminBackLink.svelte';
import type { ActionData, PageData } from './$types';

let { data, form }: { data: PageData; form: ActionData } = $props();
let saving = $state('');
let localError = $state('');
let notice = $state('');
const backLink = adminBackLink('Resume', '/admin/career');
const adminHeader = getContext<AdminHeaderActions | undefined>(
  ADMIN_HEADER_ACTIONS,
);
$effect(() => adminHeader?.register(profileLinksHeaderActions));
const submit: SubmitFunction = ({ cancel, formElement }) => {
  if (saving) {
    cancel();
    return;
  }
  saving = formElement.id;
  localError = '';
  notice = '';
  return async ({ result, update }) => {
    try {
      if (result.type === 'success' && result.data?.ok === true) {
        await update({ reset: false });
        if (formElement.id === 'new-custom-link') formElement.reset();
        notice = String(result.data.message ?? 'Profile link saved.');
      } else {
        localError =
          result.type === 'failure' && typeof result.data?.error === 'string'
            ? result.data.error
            : 'Could not save this link. Your changes are still here; please try again.';
      }
    } catch {
      localError =
        'Could not save this link. Your changes are still here; please try again.';
    } finally {
      saving = '';
    }
  };
};
</script>

{#snippet profileLinksHeaderActions()}
  <AdminBackLink {...backLink} />
{/snippet}

<svelte:head><title>Profile links</title><meta name="robots" content="noindex, nofollow" /></svelte:head>

<div class="profile-links-editor" aria-labelledby="profile-links-title">
  <h1 id="profile-links-title" class="sr-only">Profile links</h1>
  {#if !adminHeader}
    <a class="embedded-back" href={backLink.href} title={backLink.title}>{backLink.label}</a>
  {/if}
  {#if localError || form?.error}<p class="feedback error" role="alert">{localError || form?.error}</p>{/if}
  <p class="feedback" role="status" aria-live="polite">{notice || (form?.ok ? form.message : '')}</p>
  <section class="provider-grid" aria-label="Profile services">
    {#each data.providers as provider (provider.id)}
      <form id={'profile-link-' + provider.id} class="card" method="POST" action="?/save" use:enhance={submit} aria-label={provider.label + ' link'} aria-busy={saving === 'profile-link-' + provider.id}>
        <input type="hidden" name="provider" value={provider.id} />
        <input type="hidden" name="id" value={provider.link?.id ?? ''} />
        <div class="heading">
          <span class="mark" aria-hidden="true">
            {#if provider.id === 'website'}<Globe2 size={24} />
            {:else}<span class="brand-icon" style:mask-image={'url(/profile-link-icons/' + provider.id + '.svg)'}></span>{/if}
          </span>
          <div><h2>{provider.label}</h2>{#if provider.link && !provider.link.useOnResume}<small>Hidden from resume</small>{/if}</div>
        </div>
        <label><span class="sr-only">{provider.label} URL</span><input name="href" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2000" placeholder={provider.hosts?.[0] ? 'https://' + provider.hosts[0] + '/your-profile' : 'https://your-website.com'} value={provider.link?.href ?? ''} /></label>
        <button type="submit" disabled={Boolean(saving)}>{saving === 'profile-link-' + provider.id ? 'Saving…' : 'Save'}</button>
      </form>
    {/each}
  </section>
  <section class="custom-section" aria-labelledby="custom-links-title">
    <div class="heading"><Link size={22} aria-hidden="true" /><h2 id="custom-links-title">Custom links</h2></div>
    <p>Other services, portfolios, or additional profiles.</p>
    {#each data.customLinks as link (link.id)}
      <form id={'custom-link-' + link.id} class="custom card" method="POST" action="?/save" use:enhance={submit} aria-label={'Edit ' + link.label}>
        <input type="hidden" name="provider" value="custom" /><input type="hidden" name="id" value={link.id} />
        <label>Label<input name="label" maxlength="160" required value={link.label} /></label>
        <label>URL<input name="href" type="url" inputmode="url" maxlength="2000" required value={link.href} /></label>
        <button type="submit" disabled={Boolean(saving)}>{saving === 'custom-link-' + link.id ? 'Saving…' : 'Save'}</button>
        {#if !link.useOnResume}<small>Hidden from resume</small>{/if}
      </form>
    {/each}
    <form id="new-custom-link" class="custom card" method="POST" action="?/save" use:enhance={submit} aria-label="Add custom link">
      <input type="hidden" name="provider" value="custom" />
      <label>Label<input name="label" maxlength="160" required placeholder="Portfolio, publication, or other profile" /></label>
      <label>URL<input name="href" type="url" inputmode="url" maxlength="2000" required placeholder="https://…" /></label>
      <button type="submit" disabled={Boolean(saving)}>{saving === 'new-custom-link' ? 'Saving…' : 'Add link'}</button>
    </form>
  </section>
</div>

<style>
.profile-links-editor { max-width:72rem; width:100%; min-width:0; margin-inline:auto; color:var(--smrt-color-on-surface); }
h2,p { margin:0; }
h2 { font-size:1rem; }
p,small { color:var(--smrt-color-on-surface-variant); line-height:1.5; }
.feedback { min-height:1.5rem; margin-block:.5rem 1rem; }
.provider-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr)); gap:1rem; }
.card { display:grid; gap:1rem; min-width:0; padding:1rem; border:1px solid var(--smrt-color-outline-variant); border-radius:var(--smrt-radius-large,.75rem); background:var(--smrt-color-surface-container-low); }
.heading { display:flex; gap:.75rem; align-items:center; }
.mark { display:grid; place-items:center; width:2rem; height:2rem; flex:0 0 auto; color:var(--smrt-color-on-surface-variant); }
.brand-icon { display:block; width:24px; height:24px; background:currentColor; mask-repeat:no-repeat; mask-size:contain; mask-position:center; }
.custom-section { margin-top:2rem; display:grid; gap:1rem; }
.custom { grid-template-columns:minmax(0,1fr) minmax(0,2fr) auto; align-items:end; }
label { display:grid; gap:.4rem; min-width:0; font-size:.9rem; }
input { box-sizing:border-box; width:100%; min-width:0; min-height:44px; padding:.7rem; border:1px solid var(--smrt-color-outline); border-radius:var(--smrt-radius-small,.25rem); background:var(--smrt-color-surface); color:var(--smrt-color-on-surface); font:inherit; font-size:16px; }
button { width:max-content; min-height:44px; border:1px solid var(--smrt-color-outline-variant); border-radius:var(--smrt-radius-medium,.5rem); background:transparent; color:var(--smrt-color-on-surface); padding:.5rem 1rem; font:inherit; cursor:pointer; }
button:hover { background:var(--smrt-color-surface-container-high); }
button:disabled { opacity:.6; cursor:wait; }
.error { color:var(--smrt-color-error); }
.embedded-back { color:var(--smrt-color-primary); }
:is(input,button):focus-visible { outline:2px solid var(--smrt-color-primary); outline-offset:3px; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@media(max-width:40rem) { .custom { grid-template-columns:1fr; } }
</style>
