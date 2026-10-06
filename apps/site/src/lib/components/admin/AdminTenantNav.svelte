<script lang="ts">
import type { ShellNavItem } from '@happyvertical/smrt-svelte/workspace';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import { adminNavigationIsActive } from '$lib/admin/category-navigation';
import NavIcon from './NavIcon.svelte';

let {
  items,
  currentHref = '',
  collapsed = false,
  onNavigate,
} = $props<{
  items: ShellNavItem[];
  currentHref?: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}>();

let openMenu = $state<string | null>(null);
let menuToggle: HTMLButtonElement | null = null;

$effect(() => {
  currentHref;
  openMenu = null;
});

function toggleMenu(item: ShellNavItem, event: MouseEvent): void {
  menuToggle = event.currentTarget as HTMLButtonElement;
  openMenu = openMenu === item.href ? null : item.href;
}

function handleMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !openMenu) return;
  event.preventDefault();
  openMenu = null;
  menuToggle?.focus();
  // Let Escape reach AdminShell as well, so its overlay closes and restores
  // the navigation trigger's focus after this disclosure has settled.
}

function isActive(item: ShellNavItem): boolean {
  return adminNavigationIsActive(item.href, currentHref);
}

function hasActiveChild(item: ShellNavItem): boolean {
  return (
    item.children?.some((child) => isActive(child) || hasActiveChild(child)) ??
    false
  );
}

function isVisibleActive(item: ShellNavItem): boolean {
  return isActive(item) || hasActiveChild(item);
}

function ariaCurrent(item: ShellNavItem): 'page' | undefined {
  if (isActive(item)) return 'page';
  if (collapsed && hasActiveChild(item)) return 'page';
  return undefined;
}
</script>

<nav class="admin-tenant-nav" class:collapsed aria-label="Admin navigation">
  {#each items as item (item.href)}
    <div class="admin-tenant-nav-section">
      <div class="admin-tenant-nav-heading">
      <a
        href={item.href}
        class:active={isVisibleActive(item)}
        aria-current={ariaCurrent(item)}
        title={collapsed ? item.label : item.description}
        onclick={onNavigate}
      >
        {#if item.icon}
          <span class="admin-tenant-nav-icon" aria-hidden="true">
            <NavIcon name={item.icon} size={collapsed ? 18 : 16} />
          </span>
        {/if}
        {#if collapsed}
          <span class="admin-sr-only">{item.label}</span>
        {:else}
          <strong>{item.label}</strong>
          {#if item.badge !== null && item.badge !== undefined}
            <small>{item.badge}</small>
          {/if}
        {/if}
      </a>
      {#if item.children?.length && !collapsed}
        <button type="button" class="menu-toggle" class:open={openMenu === item.href} aria-label={`${item.label} sections`} aria-expanded={openMenu === item.href} aria-controls={`admin-menu-${item.label.toLowerCase()}`} onclick={(event) => toggleMenu(item, event)} onkeydown={handleMenuKeydown}>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      {/if}
      </div>

      {#if item.children?.length && !collapsed && openMenu === item.href}
        <div class="admin-tenant-nav-children" id={`admin-menu-${item.label.toLowerCase()}`}>
          {#each item.children as child (child.href)}
            <a
              href={child.href}
              class:active={isVisibleActive(child)}
              aria-current={isActive(child) ? 'page' : undefined}
              title={child.description}
              onkeydown={handleMenuKeydown}
              onclick={onNavigate}
            >
              {#if child.icon}
                <span class="admin-tenant-nav-icon" aria-hidden="true">
                  <NavIcon name={child.icon} size={15} />
                </span>
              {/if}
              <span>{child.label}</span>
              {#if child.badge !== null && child.badge !== undefined}
                <small>{child.badge}</small>
              {/if}
            </a>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</nav>

<style>
  .admin-tenant-nav,
  .admin-tenant-nav-section,
  .admin-tenant-nav-children {
    display: grid;
    gap: var(--smrt-spacing-1);
    min-width: 0;
  }

  .admin-tenant-nav-heading { display: flex; align-items: center; min-width: 0; }
  .admin-tenant-nav-heading > a { flex: 1; }
  .menu-toggle { display: grid; place-items: center; flex: 0 0 auto; width: 44px; height: 44px; border: 0; border-radius: var(--smrt-radius-medium); background: transparent; color: var(--smrt-color-on-surface-variant); cursor: pointer; }
  .menu-toggle:hover { background: var(--smrt-color-surface-container-high); }
  .menu-toggle.open :global(svg) { transform: rotate(180deg); }
  .admin-tenant-nav a:focus-visible, .menu-toggle:focus-visible { outline: 2px solid var(--smrt-color-on-surface); outline-offset: 2px; }

  .admin-tenant-nav a {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    min-height: 44px;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-radius: var(--smrt-radius-medium);
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }

  .admin-tenant-nav.collapsed,
  .admin-tenant-nav.collapsed .admin-tenant-nav-section {
    justify-items: center;
  }

  .admin-tenant-nav.collapsed .admin-tenant-nav-section { width: 100%; }
  .admin-tenant-nav.collapsed .admin-tenant-nav-heading { width: 100%; justify-content: center; }

  .admin-tenant-nav.collapsed a {
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    width: min(2.75rem, 100%);
    height: 2.75rem;
    padding: 0;
  }

  .admin-tenant-nav.collapsed a:focus-visible { outline-offset: -2px; }

  .admin-tenant-nav a:hover,
  .admin-tenant-nav a.active {
    background: var(--smrt-color-surface-container-high);
  }

  .admin-tenant-nav-icon {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    min-width: 1.25rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .admin-tenant-nav a.active .admin-tenant-nav-icon {
    color: var(--smrt-color-on-surface);
  }

  .admin-tenant-nav strong,
  .admin-tenant-nav span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .admin-tenant-nav small {
    color: var(--smrt-color-on-surface-variant);
  }

  .admin-tenant-nav-children {
    padding-inline-start: var(--smrt-spacing-4);
  }

  .admin-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
