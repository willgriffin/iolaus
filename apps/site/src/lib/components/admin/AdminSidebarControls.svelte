<script lang="ts">
import LogOut from '@lucide/svelte/icons/log-out';
import Moon from '@lucide/svelte/icons/moon';
import Sun from '@lucide/svelte/icons/sun';
import UserRound from '@lucide/svelte/icons/user-round';

let {
  email,
  theme,
  onToggleTheme,
  onOpenSettings,
  compact = false,
  accountConnectionsEnabled = false,
  id,
}: {
  email?: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  compact?: boolean;
  accountConnectionsEnabled?: boolean;
  id: string;
} = $props();
function dismissAccountMenu(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const menu = document.getElementById(id);
  if (!menu?.matches(':popover-open')) return;
  event.stopPropagation();
  menu.hidePopover();
}
</script>
<svelte:window onkeydowncapture={dismissAccountMenu} />
<div class="sidebar-controls" class:compact aria-label="Account and appearance">
  <button type="button" class="icon-button" title={theme === 'light' ? 'Use dark mode' : 'Use light mode'} aria-label={theme === 'light' ? 'Use dark mode' : 'Use light mode'} aria-pressed={theme === 'dark'} onclick={onToggleTheme}>
    {#if theme === 'light'}<Moon size={18} aria-hidden="true" />{:else}<Sun size={18} aria-hidden="true" />{/if}
  </button>
  {#if email}
    <button type="button" class="icon-button" popovertarget={id} title="Open account menu" aria-label="Open account menu">
      <UserRound size={18} aria-hidden="true" />
    </button>
    <div {id} popover="auto" class="account-menu" aria-label="Account">
      <p>{email}</p>
      <button type="button" onclick={(event) => { (event.currentTarget.closest('[popover]') as HTMLElement | null)?.hidePopover(); onOpenSettings(); }}>App settings</button>
      {#if accountConnectionsEnabled}<a href="/account/connections">Account connections</a>{/if}
      <form method="POST" action="/logout"><button type="submit"><LogOut size={16} aria-hidden="true" /> Sign out</button></form>
    </div>
  {/if}
</div>
<style>
.sidebar-controls { display:flex; align-items:center; gap:6px; }
.sidebar-controls.compact { flex-direction:column; }
button { border:1px solid transparent; border-radius:7px; background:transparent; color:var(--smrt-color-on-surface); cursor:pointer; font:inherit; }
.icon-button { display:grid; place-items:center; width:44px; height:44px; padding:0; flex-shrink:0; }
button:hover { background:var(--smrt-color-surface-container); border-color:var(--smrt-color-outline-variant); }
button:focus-visible { outline:2px solid var(--smrt-color-on-surface); outline-offset:2px; }
.account-menu { position:fixed; inset:auto; left:12px; bottom:calc(2.75rem + 108px); width:min(280px, calc(100vw - 24px)); box-sizing:border-box; padding:12px; margin:0; border:1px solid var(--smrt-color-outline-variant); border-radius:10px; background:var(--smrt-color-surface-container); color:var(--smrt-color-on-surface); box-shadow:0 8px 24px #0003; }
.account-menu p { overflow-wrap:anywhere; margin:0 0 8px; font-size:13px; }
.account-menu button { display:flex; align-items:center; gap:8px; width:100%; min-height:44px; padding:8px; text-align:left; }
</style>
