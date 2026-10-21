<script lang="ts">
import Heart from '@lucide/svelte/icons/heart';
import Search from '@lucide/svelte/icons/search';
import User from '@lucide/svelte/icons/user';
import type { Snippet } from 'svelte';

let {
  signedIn = false,
  showAccount = true,
  actions,
  center,
  auxiliary,
}: {
  signedIn?: boolean;
  showAccount?: boolean;
  actions?: Snippet;
  center?: Snippet;
  auxiliary?: Snippet;
} = $props();
</script>
<header class="site-header">
  <nav aria-label="Main navigation">
    {#if showAccount}<a href={signedIn ? '/admin' : '/login?next=%2Fshortlist'} aria-label={signedIn ? 'Your workspace' : 'Sign in'} title={signedIn ? 'Your workspace' : 'Sign in'}><User size={22} aria-hidden="true" /></a>{/if}
    <a href={signedIn ? '/admin/tasks' : '/shortlist'} aria-label={signedIn ? 'Tasks' : 'Shortlist'} title={signedIn ? 'Tasks' : 'Shortlist'}><Heart size={22} aria-hidden="true" /></a>
    <a href={signedIn ? '/admin/opportunities' : '/'} aria-label="Search" title={signedIn ? 'Opportunities' : 'Search'}><Search size={22} aria-hidden="true" /></a>
  </nav>
  {#if center}<div class="header-center">{@render center()}</div>{/if}
  {#if auxiliary}<div class="header-auxiliary">{@render auxiliary()}</div>{/if}
  {#if actions}<div class="header-actions">{@render actions()}</div>{/if}
</header>
<style>
.site-header { position:relative; display:grid; grid-template-columns:1fr auto 1fr; grid-template-rows:56px; flex-shrink:0; align-items:center; justify-content:space-between; gap:.75rem; width:100%; min-height:55px; padding:.25rem .75rem; box-sizing:border-box; border-bottom:1px solid var(--border-strong); background:var(--bg); color:var(--ink); }
nav { grid-column:1; grid-row:1; display:flex; gap:.25rem; }
a { display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px; border-radius:50%; }
a:hover { background:var(--tag-bg); }
a:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.header-actions { grid-column:3; grid-row:1; justify-self:end; display:flex; align-items:center; }
.header-center { grid-column:2; grid-row:1; }
.header-auxiliary { position:absolute; left:10rem; top:50%; transform:translateY(-50%); }
@media(max-width:48rem) {
  .site-header { grid-template-rows:44px 56px; row-gap:.4rem; }
  .header-center { grid-column:1 / -1; grid-row:2; justify-self:center; }
  .header-auxiliary { left:.75rem; top:auto; bottom:10px; transform:none; }
}
@media print { .site-header { display:none; } }
</style>
