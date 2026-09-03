<script lang="ts">
import type { ShellNavItem } from '@happyvertical/smrt-svelte/workspace';
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

function isActive(item: ShellNavItem): boolean {
  return item.href === currentHref || currentHref.startsWith(`${item.href}/`);
}

function hasActiveChild(item: ShellNavItem): boolean {
  return item.children?.some((child) => isActive(child)) ?? false;
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
        <div class="admin-tenant-nav-children">
          {#each item.children as child (child.href)}
            <a
              href={child.href}
              class:active={isActive(child)}
              aria-current={isActive(child) ? 'page' : undefined}
              title={child.description}
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

  .admin-tenant-nav a {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-radius: var(--smrt-radius-medium);
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }

  .admin-tenant-nav.collapsed,
  .admin-tenant-nav.collapsed .admin-tenant-nav-section {
    justify-items: center;
  }

  .admin-tenant-nav.collapsed a {
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
  }

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
