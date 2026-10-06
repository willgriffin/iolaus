<script lang="ts">
import '@happyvertical/smrt-ui/themes/styles/studio.css';
import type { User as SmrtUser } from '@happyvertical/smrt-svelte';
import { Provider as SmrtProvider } from '@happyvertical/smrt-svelte';
import {
  ActivityList,
  AdminShell,
  AppScopePanel,
  createShellState,
  type ShellFocusTool,
  type ShellPanelDefaults,
} from '@happyvertical/smrt-svelte/workspace';
import { getThemeContext } from '@happyvertical/smrt-ui/themes';
import MessageSquare from '@lucide/svelte/icons/message-square';
import PanelBottomClose from '@lucide/svelte/icons/panel-bottom-close';
import PanelBottomOpen from '@lucide/svelte/icons/panel-bottom-open';
import { onMount, setContext, untrack } from 'svelte';
import { page } from '$app/state';
import {
  type AdminActivityFeedState,
  startAdminActivityFeed,
} from '$lib/admin/activity-feed';
import {
  adminCategories,
  buildAdminNavigation,
} from '$lib/admin/category-navigation';
import {
  ADMIN_DOCK_CONTEXT,
  type AdminDockApi,
  type AdminResourceDockData,
  adminDockContextsMatch,
  buildAdminDockTools,
  routeContextForAdminResource,
} from '$lib/admin/dock';
import {
  ADMIN_NAVIGATION_MEDIA_QUERY,
  navigationStateForViewport,
  readStoredNavigationState,
} from '$lib/admin/shell-navigation';
import AdminActivityTicker from '$lib/components/admin/AdminActivityTicker.svelte';
import AdminAssistantPanel from '$lib/components/admin/AdminAssistantPanel.svelte';
import AdminSidebarControls from '$lib/components/admin/AdminSidebarControls.svelte';
import AdminTenantNav from '$lib/components/admin/AdminTenantNav.svelte';

type BreadcrumbItem = {
  href?: string;
  label: string;
};
type BreadcrumbRecord = Record<string, unknown> | null | undefined;

const ADMIN_SHELL_STORAGE_KEY = 'iolaus.admin.shell';
const ADMIN_SHELL_CONFIG = {
  top: {
    collapsedSize: '3.5rem',
    expandedSize: 'min(18rem, calc(100vw - 1rem))',
    initial: 'collapsed',
    label: 'App',
    presentation: 'overlay',
  },
  left: {
    collapsedSize: '4.25rem',
    expandedSize: 'min(18rem, calc(100vw - 1rem))',
    initial: 'collapsed',
    label: 'Navigation',
    presentation: 'overlay',
  },
  right: {
    collapsedSize: '0rem',
    expandedSize: 'min(420px, calc(100vw - 1rem))',
    initial: 'collapsed',
    label: 'Assistant',
    presentation: 'overlay',
    keepMounted: true,
  },
  bottom: {
    collapsedSize: '2.75rem',
    expandedSize: 'min(360px, 42vh)',
    initial: 'collapsed',
    label: 'Activities',
    presentation: 'overlay',
  },
} satisfies ShellPanelDefaults;

let { data, children } = $props();

let adminDockContext = $state<AdminResourceDockData | null>(null);
let pendingAdminToolId = $state<string | null>(null);
let currentDockRouteSlug = $state<string | null>(null);

const themeContext = getThemeContext();
const theme = $derived<'light' | 'dark'>(
  themeContext.state.isDark ? 'dark' : 'light',
);
function initialNavigationState(): 'collapsed' | 'expanded' {
  if (typeof window === 'undefined') return 'collapsed';

  try {
    const stored = readStoredNavigationState(
      window.localStorage.getItem(ADMIN_SHELL_STORAGE_KEY),
    );
    if (stored) return stored;
    return navigationStateForViewport(
      window.matchMedia(ADMIN_NAVIGATION_MEDIA_QUERY).matches,
    );
  } catch {
    return 'collapsed';
  }
}

const adminShell = createShellState({
  config: {
    ...ADMIN_SHELL_CONFIG,
    right: untrack(() => data.assistantEnabled)
      ? ADMIN_SHELL_CONFIG.right
      : false,
  },
  storageKey: ADMIN_SHELL_STORAGE_KEY,
});
// Keep the responsive default out of the persisted settings delta. ShellState
// persists the complete delta when any panel changes, so the left setting
// must be added only by an explicit left-panel action.
adminShell.panels.left = initialNavigationState();
let shellReady = $state(false);
let activityFeedState = $state<AdminActivityFeedState>({
  status: 'loading',
  observedAt: null,
  truncated: false,
});
$effect(() => {
  const owner = data.activityScopeKey;
  if (typeof window === 'undefined') return;
  if (!owner) {
    activityFeedState = {
      status: 'unavailable',
      observedAt: null,
      truncated: false,
    };
    return;
  }
  const feed = untrack(() =>
    startAdminActivityFeed({
      shell: adminShell,
      onState: (state) => {
        activityFeedState = state;
      },
    }),
  );
  return () => feed.stop();
});
let assistantOpened = $state(false);
$effect(() => {
  if (data.assistantEnabled && adminShell.panels.right === 'expanded')
    assistantOpened = true;
});

const providerUser = $derived(data.user as unknown as SmrtUser | null);
const routeAdminDockContext = $derived(
  routeContextForAdminResource(page.url.pathname, data.resources),
);
const activeAdminDockContext = $derived(
  resolveAdminDockContext(adminDockContext, routeAdminDockContext),
);
const adminDockTools = $derived(buildAdminDockTools(activeAdminDockContext));
const activeAdminToolId = $derived(adminShell.activeFocusToolId);
const activeAdminTool = $derived(
  adminDockTools.find((tool) => tool.id === activeAdminToolId) ?? null,
);
const adminBreadcrumbs = $derived(
  resolveAdminBreadcrumbs(page.url.pathname, data.resources, page.data),
);
const showAdminBreadcrumbs = $derived(adminBreadcrumbs.length > 1);
const tenantCurrentHref = $derived(currentTenantHref(page.url.pathname));
const navItems = $derived(buildAdminNavigation(data.resources));

const activeRouteAliases: Record<string, string[]> = {
  '/admin/decisions': ['/admin/decision-tags'],
  '/admin/experience': [
    '/admin/experience-companies',
    '/admin/experience-roles',
    '/admin/projects',
    '/admin/duties',
    '/admin/achievements',
    '/admin/experience-tags',
  ],
  '/admin/companies': ['/admin/company-attachments', '/admin/company-tags'],
  '/admin/opportunities': [
    '/admin/opportunity-tags',
    '/admin/opportunity-places',
    '/admin/opportunity-roles',
  ],
  '/admin/roles': ['/admin/role-tags'],
  '/admin/skills': [
    '/admin/skill-categories',
    '/admin/skill-groups',
    '/admin/skill-group-members',
  ],
  '/admin/sources': ['/admin/source-tags'],
};

function setResourceContext(context: AdminResourceDockData | null): void {
  if (adminDockContextsMatch(adminDockContext, context)) return;
  adminDockContext = context;
}

function resolveAdminDockContext(
  pageContext: AdminResourceDockData | null,
  routeContext: AdminResourceDockData | null,
): AdminResourceDockData | null {
  if (!pageContext) return routeContext;
  if (!routeContext) return pageContext;
  return pageContext.resource.slug === routeContext.resource.slug
    ? pageContext
    : routeContext;
}

function openAdminTool(toolId: string): void {
  pendingAdminToolId = toolId;
  if (adminDockTools.some((tool) => tool.id === toolId)) {
    adminShell.openFocusTool(toolId);
    pendingAdminToolId = null;
  }
}

function toggleAdminTool(toolId: string): void {
  if (activeAdminToolId === toolId && adminShell.panels.right === 'expanded') {
    closeAdminDock();
    return;
  }

  openAdminTool(toolId);
}

function closeAdminDock(): void {
  adminShell.collapsePanel('right');
}

const adminDockApi: AdminDockApi = {
  close: closeAdminDock,
  open: openAdminTool,
  setResourceContext,
};

setContext(ADMIN_DOCK_CONTEXT, adminDockApi);

$effect(() => {
  const nextRouteSlug = routeAdminDockContext?.resource.slug ?? null;
  if (currentDockRouteSlug === nextRouteSlug) return;

  currentDockRouteSlug = nextRouteSlug;
  if (adminDockContext?.resource.slug !== nextRouteSlug) {
    adminDockContext = null;
  }
});

$effect(() => {
  const tools = adminDockTools.map(
    (tool, index): ShellFocusTool => ({
      badge: tool.badge,
      id: tool.id,
      label: tool.label,
      order: index,
      scopeId: activeAdminDockContext?.resource.slug,
      subject: activeAdminDockContext?.selectedRecord?.id
        ? {
            id: String(activeAdminDockContext.selectedRecord.id),
            label: activeAdminDockContext.resource.singularLabel,
            type: activeAdminDockContext.resource.slug,
          }
        : undefined,
    }),
  );

  const unregister = untrack(() =>
    tools.map((tool) => adminShell.registerFocusTool(tool)),
  );

  if (tools.length === 0 && !data.assistantEnabled) {
    pendingAdminToolId = null;
    untrack(() => adminShell.collapsePanel('right'));
  }

  return () => {
    for (const cleanup of unregister) cleanup();
  };
});

$effect(() => {
  if (!pendingAdminToolId) return;
  if (!adminDockTools.some((tool) => tool.id === pendingAdminToolId)) return;

  adminShell.openFocusTool(pendingAdminToolId);
  pendingAdminToolId = null;
});

function toggleTheme(): void {
  themeContext.toggleColorScheme();
}

function handleTenantNavigate(): void {
  // Navigation is an overlay at every width. Use the shell's native close
  // action so its active overlay and focus state settle along with the panel.
  adminShell.collapsePanel('left');
}

onMount(() => {
  const mediaQuery = window.matchMedia(ADMIN_NAVIGATION_MEDIA_QUERY);
  let disposed = false;

  const applyResponsiveDefault = (): void => {
    // A setting appears in localStorage only after an explicit user action.
    // Automatic breakpoint changes stay ephemeral and can follow resizing.
    let stored = null;
    try {
      stored = readStoredNavigationState(
        window.localStorage.getItem(ADMIN_SHELL_STORAGE_KEY),
      );
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    if (stored) {
      // A mobile route transition may close the live panel without changing
      // the user's explicit preference. Restore that preference when the
      // viewport changes again.
      adminShell.panels.left = stored;
      return;
    }
    if (adminShell.settings.panels?.left) {
      adminShell.panels.left = adminShell.settings.panels.left;
      return;
    }

    adminShell.panels.left = navigationStateForViewport(mediaQuery.matches);
  };

  const initializeShell = async (): Promise<void> => {
    // AdminShell also hydrates a provided state. Wait for that pass and one
    // macrotask so the responsive default is applied after persisted settings
    // have had their chance to win.
    try {
      await adminShell.hydrate();
    } catch {
      // A storage adapter failure must not strand the shell in its hidden
      // hydration state; the responsive default below remains available.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (disposed) return;

    applyResponsiveDefault();
    mediaQuery.addEventListener('change', applyResponsiveDefault);
    shellReady = true;
  };

  void initializeShell();

  return () => {
    disposed = true;
    mediaQuery.removeEventListener('change', applyResponsiveDefault);
  };
});

function resolveAdminBreadcrumbs(
  pathname: string,
  resources: Array<{ label: string; singularLabel: string; slug: string }>,
  pageData: Record<string, unknown>,
): BreadcrumbItem[] {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'admin') return [];

  const crumbs: BreadcrumbItem[] = [{ href: '/admin', label: 'Overview' }];
  const resourceSlug = parts[1];
  if (!resourceSlug) return crumbs;
  if (resourceSlug === 'resume' && parts[2] === 'skill-discovery') {
    return [
      ...crumbs,
      { href: '/admin/career', label: 'Resume' },
      { label: 'Discover skills' },
    ];
  }

  const memoryResources = new Set<string>(
    adminCategories.find(({ key }) => key === 'memory')?.resources ?? [],
  );
  const resumeResources = new Set<string>(
    adminCategories.find(({ key }) => key === 'career')?.resources ?? [],
  );
  if (resourceSlug === 'resume' || resumeResources.has(resourceSlug))
    crumbs.push({ href: '/admin/career', label: 'Resume' });
  if (resourceSlug === 'memory' || memoryResources.has(resourceSlug))
    crumbs.push({ href: '/admin/system', label: 'System' });
  if (memoryResources.has(resourceSlug))
    crumbs.push({ href: '/admin/memory', label: 'Memory' });

  const resource = resources.find((item) => item.slug === resourceSlug);
  if (!resource) {
    const categoryLabel = adminCategories.find(
      ({ key }) => key === resourceSlug,
    )?.label;
    const label =
      resourceSlug === 'resume'
        ? 'Preview & PDFs'
        : (categoryLabel ?? segmentLabel(resourceSlug));
    crumbs.push({
      href: `/admin/${resourceSlug}`,
      label,
    });
    return crumbs;
  }

  const resourceHref = `/admin/${resource.slug}`;
  crumbs.push({ href: resourceHref, label: resource.label });

  if (parts[2] === 'new') {
    crumbs.push({ label: `New ${resource.singularLabel}` });
    return crumbs;
  }

  if (!parts[2]) return crumbs;

  if (parts[3] === 'edit') {
    crumbs.push({ label: 'Edit' });
    return crumbs;
  }

  if (parts[3] === 'review') {
    crumbs.push({ label: 'Review' });
    return crumbs;
  }

  const detailLabel =
    resource.slug === 'applications'
      ? applicationBreadcrumbLabel(pageData)
      : '';
  crumbs.push({ label: detailLabel || resource.singularLabel });
  return crumbs;
}

function breadcrumbString(record: BreadcrumbRecord, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function applicationBreadcrumbLabel(pageData: Record<string, unknown>): string {
  return (
    breadcrumbString(pageData.opportunity as BreadcrumbRecord, 'title') ||
    breadcrumbString(pageData.company as BreadcrumbRecord, 'name') ||
    breadcrumbString(pageData.application as BreadcrumbRecord, 'title')
  );
}

function segmentLabel(segment: string): string {
  return decodeURIComponent(segment)
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeRoutePath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  return normalized || '/';
}

function routeMatches(href: string, currentPath: string): boolean {
  const path = normalizeRoutePath(currentPath);
  const itemHref = normalizeRoutePath(href);
  if (itemHref === '/admin') return path === itemHref;
  return path === itemHref || path.startsWith(`${itemHref}/`);
}

function currentTenantHref(pathname: string): string {
  const path = normalizeRoutePath(pathname);

  for (const [canonical, aliases] of Object.entries(activeRouteAliases)) {
    if (aliases.some((alias) => routeMatches(alias, path))) return canonical;
  }

  return path;
}
</script>

<svelte:head>
  <title>{data.appName} — Employment Search</title>
</svelte:head>

{#snippet appBar()}
  <div class="admin-app-bar">
    <div class="admin-app-bar-left">
      <button class="admin-brand" type="button" aria-label={`${data.appName}: ${adminShell.panels.left === 'expanded' ? 'Close' : 'Open'} navigation menu`} aria-expanded={adminShell.panels.left === 'expanded'} aria-controls="admin-navigation" onclick={() => { if (!window.matchMedia(ADMIN_NAVIGATION_MEDIA_QUERY).matches && adminShell.panels.left !== 'expanded') adminShell.collapsePanel('right'); adminShell.togglePanel('left'); }}>
        <span class="admin-brand-mark">{data.appMark}</span>
        <span class="admin-brand-text">
          <span class="admin-brand-eyebrow">{data.appName}</span>
          <strong>Employment Search</strong>
        </span>
      </button>
      {#if data.assistantEnabled}
        <button class="admin-icon-button" type="button" title={adminShell.panels.right === 'expanded' ? 'Close assistant' : 'Open assistant'} aria-label={adminShell.panels.right === 'expanded' ? 'Close assistant' : 'Open assistant'} aria-expanded={adminShell.panels.right === 'expanded'} aria-controls="admin-assistant" onclick={() => {
          if (!window.matchMedia(ADMIN_NAVIGATION_MEDIA_QUERY).matches && adminShell.panels.right !== 'expanded') adminShell.collapsePanel('left');
          adminShell.togglePanel('right');
        }}><MessageSquare size={18} aria-hidden="true" /></button>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet appPanel()}
  <AppScopePanel
    appName={data.appName}
    tenantName={data.user?.email ?? undefined}
    environment={data.tenantId ? `Tenant ${data.tenantId}` : 'Admin'}
  />
{/snippet}

{#snippet tenantRail()}
  <div class="admin-tenant-rail" data-sveltekit-preload-data="tap">
    <div class="admin-rail-navigation">
    <AdminTenantNav
      collapsed
      items={navItems}
      currentHref={tenantCurrentHref}
      onNavigate={handleTenantNavigate}
    />
    </div>
    <AdminSidebarControls id="admin-rail-account" compact email={data.user?.email} {theme} onToggleTheme={toggleTheme} onOpenSettings={() => adminShell.expandPanel('top')} />
  </div>
{/snippet}

{#snippet tenantPanel()}
  <div id="admin-navigation" class="admin-tenant-panel" data-sveltekit-preload-data="tap">
    <div class="admin-panel-header">
      <strong>Navigation</strong>
    </div>
    <AdminTenantNav items={navItems} currentHref={tenantCurrentHref} onNavigate={handleTenantNavigate} />
  </div>
{/snippet}

{#snippet tenantFooter()}
  <AdminSidebarControls id="admin-panel-account" email={data.user?.email} {theme} onToggleTheme={toggleTheme} onOpenSettings={() => adminShell.expandPanel('top')} />
{/snippet}

{#snippet focusRail()}{/snippet}

{#snippet focusPanel()}
  {#if data.assistantEnabled && assistantOpened}
    <AdminAssistantPanel visible={adminShell.panels.right === 'expanded'} onClose={() => adminShell.collapsePanel('right')} />
  {/if}
{/snippet}

{#snippet systemBar()}
  <div class="admin-system-bar">
    <button
      class="admin-icon-button"
      type="button"
      title={adminShell.panels.bottom === 'expanded' ? 'Collapse activities' : 'Expand activities'}
      aria-label={adminShell.panels.bottom === 'expanded' ? 'Collapse activities' : 'Expand activities'}
      aria-expanded={adminShell.panels.bottom === 'expanded'}
      onclick={() => adminShell.togglePanel('bottom')}
    >
      {#if adminShell.panels.bottom === 'expanded'}
        <PanelBottomClose size={16} strokeWidth={2.1} />
      {:else}
        <PanelBottomOpen size={16} strokeWidth={2.1} />
      {/if}
    </button>
    {#if activityFeedState.status === 'ready'}
      <AdminActivityTicker activities={adminShell.activities} statuses={['queued', 'running']} label="Active processes" />
    {:else}
      <span class="admin-activity-status">{activityFeedState.status === 'loading' ? 'Loading activities…' : 'Activity unavailable'}</span>
    {/if}
  </div>
{/snippet}

{#snippet systemPanel()}
  <section class="admin-system-panel">
    <header class="admin-panel-header">
      <div>
        <strong>Activities</strong>
      </div>
      <button
        class="admin-icon-button"
        type="button"
        title="Collapse activities"
        aria-label="Collapse activities"
        onclick={() => adminShell.collapsePanel('bottom')}
      >
        <PanelBottomClose size={16} strokeWidth={2.1} />
      </button>
    </header>
    {#if activityFeedState.status === 'ready'}
      <ActivityList filter={{ status: ['queued', 'running'] }} emptyLabel="No active processes" />
      {#if adminShell.activities.some((activity) => ['completed', 'failed', 'canceled'].includes(activity.status))}
        <strong>Recently finished · last 5 minutes</strong>
        <ActivityList filter={{ status: ['completed', 'failed', 'canceled'] }} hideWhenEmpty />
      {/if}
      {#if activityFeedState.truncated}<p class="admin-activity-status">Showing the first 20 activities.</p>{/if}
    {:else}
      <p class="admin-activity-status">{activityFeedState.status === 'loading' ? 'Loading activities…' : 'Activity unavailable. Retrying automatically.'}</p>
    {/if}
  </section>
{/snippet}

<div class="admin-shell-visibility" class:admin-shell-hydrating={!shellReady}>
  <SmrtProvider mode="default" autoEnableSmrt={false} user={providerUser} permissions={data.permissions}>
    <AdminShell
      title="Employment Search"
      subtitle={data.appName}
      state={adminShell}
      {appBar}
      {appPanel}
      {tenantRail}
      {tenantPanel}
      {tenantFooter}
      {focusRail}
      {focusPanel}
      {systemBar}
      {systemPanel}
    >
      <div class="admin-content">
        {#if showAdminBreadcrumbs}
          <nav class="smrt-breadcrumbs" aria-label="Admin breadcrumbs">
            {#each adminBreadcrumbs as crumb, index}
              {@const isCurrent = index === adminBreadcrumbs.length - 1}
              <span class="crumb-item" class:current={isCurrent}>
                {#if crumb.href && !isCurrent}
                  <a class="crumb-link" href={crumb.href}>{crumb.label}</a>
                {:else}
                  {crumb.label}
                {/if}
              </span>
              {#if !isCurrent}
                <span class="separator">/</span>
              {/if}
            {/each}
          </nav>
        {/if}
        {@render children()}
      </div>
    </AdminShell>
  </SmrtProvider>
</div>


  <style>
  :global(body) {
    background: var(--smrt-color-surface);
  }
  .admin-shell-hydrating :global(.smrt-admin-shell__edge--left) {
    visibility: hidden;
  }
  :global(.smrt-admin-shell) {
    --smrt-admin-shell-left-expanded: min(18rem, calc(100vw - 1rem));
    --smrt-admin-shell-right-expanded: min(420px, calc(100vw - 1rem));
  }
  :global(.smrt-admin-shell__edge--top .smrt-admin-shell__band),
  :global(.smrt-admin-shell__edge--bottom .smrt-admin-shell__band) {
    padding: 0;
  }
  .admin-app-bar,
  .admin-app-bar-left,
  .admin-brand,
  .admin-panel-header,
  .admin-system-bar {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .admin-app-bar {
    justify-content: space-between;
    gap: 14px;
    width: 100%;
    height: 100%;
    padding: 0 14px;
  }
  .admin-app-bar-left {
    gap: 8px;
  }
  .admin-brand {
    gap: 10px;
    color: inherit;
    text-decoration: none;
    border: 0;
    padding: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .admin-brand:focus-visible { outline: 2px solid var(--smrt-color-on-surface); outline-offset: 4px; border-radius: 7px; }
  .admin-brand-mark {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 7px;
    font: 800 11px/1 var(--smrt-font-family-mono, monospace);
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface);
  }
  .admin-brand-text {
    min-width: 0;
  }
  .admin-brand-eyebrow {
    display: block;
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    line-height: 1.2;
  }
  .admin-brand strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    line-height: 1.2;
  }
  .admin-icon-button {
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }
  .admin-icon-button {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
  }
  .admin-icon-button:hover,
  .admin-icon-button:focus-visible {
    border-color: var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
  }
  .admin-icon-button:focus-visible {
    outline: 2px solid var(--smrt-color-on-surface);
    outline-offset: 2px;
  }
  .admin-tenant-rail { display:flex; flex-direction:column; align-items:center; height:100%; min-height:0; gap:8px; }
  .admin-rail-navigation { flex:1; min-height:0; overflow:auto; width:100%; }
  .admin-tenant-panel,
  .admin-system-panel {
    display: grid;
    align-content: start;
    gap: 12px;
    min-width: 0;
  }
  .admin-panel-header {
    justify-content: space-between;
    gap: 10px;
  }
  .admin-panel-header strong {
    display: block;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.2;
  }
  .admin-system-bar {
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    height: 100%;
    padding: 0 14px;
  }
  .admin-system-bar { min-width: 0; }
  .admin-activity-status { color: var(--smrt-color-on-surface-variant); font-size: 12px; }
  .admin-content {
    display: grid;
    align-content: start;
    gap: 14px;
    min-height: 100%;
    min-width: 0;
    padding: 22px;
  }
  :global(.admin-content .smrt-breadcrumbs) {
    margin: 0;
    padding: 0 12px 6px;
    border: 0;
    background: transparent;
  }
  :global(.admin-content .smrt-breadcrumbs .crumb-item) {
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 700;
  }
  :global(.admin-content .smrt-breadcrumbs .crumb-link) {
    color: var(--smrt-color-on-surface-variant);
  }
  :global(.admin-content .smrt-breadcrumbs .current) {
    color: var(--smrt-color-on-surface);
  }
  :global(.admin-content .smrt-breadcrumbs .separator) {
    margin: 0 4px;
    color: var(--smrt-color-on-surface-variant);
  }

  @media (max-width: 640px) {
  .admin-brand-eyebrow {
      display: none;
    }
  .admin-content {
      padding: 14px;
    }
  }
</style>
