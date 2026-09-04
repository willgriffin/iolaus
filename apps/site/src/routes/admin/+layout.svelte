<script lang="ts">
import '@happyvertical/smrt-ui/themes/styles/studio.css';
import type { User as SmrtUser } from '@happyvertical/smrt-svelte';
import { Provider as SmrtProvider } from '@happyvertical/smrt-svelte';
import {
  AdminShell,
  AppScopePanel,
  createShellState,
  type ShellFocusTool,
  type ShellNavItem,
  type ShellPanelDefaults,
  type ShellStatusChip,
  type ShellSystemPanel,
  SystemScopePanel,
  SystemStatusChips,
} from '@happyvertical/smrt-svelte/workspace';
import { getThemeContext } from '@happyvertical/smrt-ui/themes';
import LogOut from '@lucide/svelte/icons/log-out';
import Moon from '@lucide/svelte/icons/moon';
import PanelBottomClose from '@lucide/svelte/icons/panel-bottom-close';
import PanelBottomOpen from '@lucide/svelte/icons/panel-bottom-open';
import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
import Sun from '@lucide/svelte/icons/sun';
import UserRound from '@lucide/svelte/icons/user-round';
import { setContext, untrack } from 'svelte';
import { page } from '$app/state';
import {
  ADMIN_DOCK_CONTEXT,
  type AdminDockApi,
  type AdminResourceDockData,
  adminDockContextsMatch,
  buildAdminDockTools,
  routeContextForAdminResource,
} from '$lib/admin/dock';
import AdminResourceDockPanel from '$lib/components/admin/AdminResourceDockPanel.svelte';
import AdminTenantNav from '$lib/components/admin/AdminTenantNav.svelte';
import NavIcon from '$lib/components/admin/NavIcon.svelte';

type BreadcrumbItem = {
  href?: string;
  label: string;
};
type BreadcrumbRecord = Record<string, unknown> | null | undefined;

const ADMIN_SHELL_STORAGE_KEY = 'iolaus.admin.shell';
const ADMIN_SHELL_CONFIG = {
  top: {
    collapsedSize: '3.5rem',
    expandedSize: '18rem',
    initial: 'collapsed',
    label: 'App',
    presentation: 'overlay',
  },
  left: {
    collapsedSize: '4.25rem',
    expandedSize: '18rem',
    initial: 'expanded',
    label: 'Navigation',
    presentation: 'push',
  },
  right: {
    collapsedSize: '4rem',
    expandedSize: 'min(420px, 32vw)',
    initial: 'collapsed',
    label: 'Tools',
    presentation: 'push',
  },
  bottom: {
    collapsedSize: '2.75rem',
    expandedSize: 'min(360px, 42vh)',
    initial: 'collapsed',
    label: 'System',
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
const adminShell = createShellState({
  config: ADMIN_SHELL_CONFIG,
  storageKey: ADMIN_SHELL_STORAGE_KEY,
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
const systemStatusChips = $derived<ShellStatusChip[]>([
  {
    id: 'session',
    label: 'Session',
    tone: data.user?.email ? 'success' : 'warning',
    value: data.user?.email ? 'Active' : 'Guest',
  },
  {
    id: 'resources',
    label: 'Resources',
    tone: 'info',
    value: data.resources.length,
  },
  {
    id: 'theme',
    label: 'Theme',
    value: theme,
  },
]);
const systemPanels = $derived<ShellSystemPanel[]>([
  {
    id: 'admin',
    label: 'Admin',
    items: [
      {
        id: 'shell',
        label: 'AdminShell',
        status: 'Four-edge layout',
        detail: 'App, tenant, focus, and system scopes are active.',
      },
      {
        id: 'resources',
        label: 'Resources',
        status: `${data.resources.length} registered`,
        href: '/admin/tasks',
      },
    ],
  },
  {
    id: 'runtime',
    label: 'Runtime',
    items: [
      {
        id: 'tenant',
        label: 'Tenant',
        status: data.tenantId ? `Tenant ${data.tenantId}` : 'Admin',
      },
      {
        id: 'theme',
        label: 'Theme',
        status: theme,
      },
    ],
  },
]);
const navItems = $derived<ShellNavItem[]>(
  [
    resourceItem('tasks'),
    resourceItem('opportunities'),
    resourceItem('applications'),
    navGroup('Career', '/admin/resume', [
      {
        href: '/admin/resume',
        icon: 'file-text',
        label: 'Resume',
      },
      resourceItem('candidate-profiles', { label: 'Profiles' }),
      resourceItem('candidate-profile-links'),
      resourceItem('experience'),
      resourceItem('education'),
      resourceItem('companies'),
      resourceItem('roles'),
      resourceItem('skills'),
      resourceItem('resume-assets'),
      resourceItem('resume-tailoring-configs', { label: 'Tailoring configs' }),
      resourceItem('fact-intakes', { label: 'Notes' }),
    ]),
    navGroup('Research', '/admin/sources', [
      resourceItem('sources'),
      resourceItem('company-research', { label: 'Companies' }),
    ]),
    navGroup('Memory', '/admin/facts', [
      resourceItem('facts'),
      resourceItem('fact-candidates', { label: 'Review queue' }),
      resourceItem('decisions'),
    ]),
    navGroup('System', '/admin/preferences', [
      resourceItem('preferences'),
      resourceItem('agent-runs'),
      resourceItem('evaluation-scores'),
    ]),
  ].filter((item): item is ShellNavItem => Boolean(item)),
);

const activeRouteAliases: Record<string, string[]> = {
  '/admin/tasks': ['/admin'],
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

const resourceNavIcons: Record<string, string> = {
  'agent-runs': 'bot',
  applications: 'send',
  companies: 'building',
  'company-research': 'building',
  decisions: 'gavel',
  education: 'file-text',
  'evaluation-scores': 'bar-chart',
  experience: 'briefcase',
  'fact-candidates': 'bot',
  'fact-intakes': 'file-text',
  facts: 'database',
  opportunities: 'briefcase',
  preferences: 'sliders',
  roles: 'briefcase',
  'resume-assets': 'file-text',
  'resume-tailoring-configs': 'sliders',
  skills: 'tag',
  sources: 'rss',
  tasks: 'check-square',
};

const navGroupIcons: Record<string, string> = {
  Career: 'file-text',
  Memory: 'database',
  Research: 'rss',
  System: 'sliders',
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

  if (tools.length === 0) {
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

function toggleTenantPanel(): void {
  adminShell.togglePanel('left');
}

function handleTenantNavigate(): void {
  if (
    typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 48rem)').matches
  ) {
    adminShell.collapsePanel('left');
  }
}

function resourceItem(
  slug: string,
  overrides: Partial<ShellNavItem> = {},
): ShellNavItem | null {
  const resource = data.resources.find((item) => item.slug === slug);
  if (!resource) return null;
  return {
    href: `/admin/${resource.slug}`,
    icon: resourceNavIcons[resource.slug] ?? 'database',
    label: resource.label,
    ...overrides,
  };
}

function navGroup(
  label: string,
  fallbackHref: string,
  children: Array<ShellNavItem | null>,
): ShellNavItem | null {
  const visibleChildren = children.filter((item): item is ShellNavItem =>
    Boolean(item),
  );
  if (visibleChildren.length === 0) return null;
  return {
    href: fallbackHref,
    icon: navGroupIcons[label] ?? 'folder-tree',
    label,
    children: visibleChildren,
  };
}

function resolveAdminBreadcrumbs(
  pathname: string,
  resources: Array<{ label: string; singularLabel: string; slug: string }>,
  pageData: Record<string, unknown>,
): BreadcrumbItem[] {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'admin') return [];

  const crumbs: BreadcrumbItem[] = [{ href: '/admin/tasks', label: 'Admin' }];
  const resourceSlug = parts[1];
  if (!resourceSlug) return crumbs;

  const resource = resources.find((item) => item.slug === resourceSlug);
  if (!resource) {
    crumbs.push({
      href: `/admin/${resourceSlug}`,
      label: segmentLabel(resourceSlug),
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
  if (path === '/admin') return '/admin/tasks';

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
      <button
        class="admin-icon-button"
        type="button"
        title={adminShell.panels.left === 'expanded' ? 'Collapse navigation' : 'Expand navigation'}
        aria-label={adminShell.panels.left === 'expanded' ? 'Collapse navigation' : 'Expand navigation'}
        aria-expanded={adminShell.panels.left === 'expanded'}
        onclick={toggleTenantPanel}
      >
        {#if adminShell.panels.left === 'expanded'}
          <PanelLeftClose size={16} strokeWidth={2.1} />
        {:else}
          <PanelLeftOpen size={16} strokeWidth={2.1} />
        {/if}
      </button>
      <a class="admin-brand" href="/admin" aria-label={`${data.appName} employment search`}>
        <span class="admin-brand-mark">{data.appMark}</span>
        <span class="admin-brand-text">
          <span class="admin-brand-eyebrow">{data.appName}</span>
          <strong>Employment Search</strong>
        </span>
      </a>
    </div>

    <div class="admin-app-bar-actions">
      {#if data.user?.email}
        <button
          class="admin-user-button"
          type="button"
          title="Open app settings"
          aria-label="Open app settings"
          aria-expanded={adminShell.panels.top === 'expanded'}
          onclick={() => adminShell.togglePanel('top')}
        >
          <UserRound size={16} strokeWidth={2.1} />
          <span>{data.user.email}</span>
        </button>
      {/if}
      <button
        class="admin-icon-button"
        type="button"
        title={theme === 'light' ? 'Use dark mode' : 'Use light mode'}
        aria-label={theme === 'light' ? 'Use dark mode' : 'Use light mode'}
        aria-pressed={theme === 'dark'}
        onclick={toggleTheme}
      >
        {#if theme === 'light'}
          <Moon size={16} strokeWidth={2.1} />
        {:else}
          <Sun size={16} strokeWidth={2.1} />
        {/if}
      </button>
      <form method="POST" action="/logout">
        <button class="admin-icon-button" type="submit" title="Sign out" aria-label="Sign out">
          <LogOut size={16} strokeWidth={2.1} />
        </button>
      </form>
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
    <button
      class="admin-icon-button"
      type="button"
      title="Expand navigation"
      aria-label="Expand navigation"
      aria-expanded={adminShell.panels.left === 'expanded'}
      onclick={() => adminShell.expandPanel('left')}
    >
      <PanelLeftOpen size={17} strokeWidth={2.1} />
    </button>
    <AdminTenantNav
      collapsed
      items={navItems}
      currentHref={tenantCurrentHref}
      onNavigate={handleTenantNavigate}
    />
  </div>
{/snippet}

{#snippet tenantPanel()}
  <div class="admin-tenant-panel" data-sveltekit-preload-data="tap">
    <div class="admin-panel-header">
      <strong>Navigation</strong>
      <button
        class="admin-icon-button"
        type="button"
        title="Collapse navigation"
        aria-label="Collapse navigation"
        onclick={() => adminShell.collapsePanel('left')}
      >
        <PanelLeftClose size={16} strokeWidth={2.1} />
      </button>
    </div>
    <AdminTenantNav items={navItems} currentHref={tenantCurrentHref} onNavigate={handleTenantNavigate} />
  </div>
{/snippet}

{#snippet focusRail()}
  <div class="admin-focus-rail" aria-label="Admin tools">
    {#each adminDockTools as tool (tool.id)}
      <button
        type="button"
        class:active={activeAdminToolId === tool.id}
        title={tool.label}
        aria-label={tool.label}
        aria-pressed={activeAdminToolId === tool.id}
        onclick={() => toggleAdminTool(tool.id)}
      >
        <NavIcon name={tool.icon} size={18} />
        {#if tool.badge !== null && tool.badge !== undefined && tool.badge !== ''}
          <span class="admin-dock-badge">{tool.badge}</span>
        {/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet focusPanel()}
  <section class="admin-focus-panel">
    <header class="admin-panel-header">
      <div>
        <span>Tools</span>
        <strong>{activeAdminTool?.label ?? 'Inspector'}</strong>
      </div>
      <button
        class="admin-icon-button"
        type="button"
        title="Collapse tools"
        aria-label="Collapse tools"
        onclick={closeAdminDock}
      >
        <PanelRightClose size={16} strokeWidth={2.1} />
      </button>
    </header>

    {#if adminDockTools.length > 1}
      <div class="admin-focus-switcher">
        {#each adminDockTools as tool (tool.id)}
          <button
            type="button"
            class:active={activeAdminToolId === tool.id}
            onclick={() => toggleAdminTool(tool.id)}
          >
            <NavIcon name={tool.icon} size={15} />
            <span>{tool.label}</span>
          </button>
        {/each}
      </div>
    {/if}

    <AdminResourceDockPanel context={activeAdminDockContext} />
  </section>
{/snippet}

{#snippet systemBar()}
  <div class="admin-system-bar">
    <button
      class="admin-icon-button"
      type="button"
      title={adminShell.panels.bottom === 'expanded' ? 'Collapse system panel' : 'Expand system panel'}
      aria-label={adminShell.panels.bottom === 'expanded' ? 'Collapse system panel' : 'Expand system panel'}
      aria-expanded={adminShell.panels.bottom === 'expanded'}
      onclick={() => adminShell.togglePanel('bottom')}
    >
      {#if adminShell.panels.bottom === 'expanded'}
        <PanelBottomClose size={16} strokeWidth={2.1} />
      {:else}
        <PanelBottomOpen size={16} strokeWidth={2.1} />
      {/if}
    </button>
    <SystemStatusChips chips={systemStatusChips} />
  </div>
{/snippet}

{#snippet systemPanel()}
  <section class="admin-system-panel">
    <header class="admin-panel-header">
      <div>
        <span>System</span>
        <strong>Admin runtime</strong>
      </div>
      <button
        class="admin-icon-button"
        type="button"
        title="Collapse system panel"
        aria-label="Collapse system panel"
        onclick={() => adminShell.collapsePanel('bottom')}
      >
        <PanelBottomClose size={16} strokeWidth={2.1} />
      </button>
    </header>
    <SystemScopePanel panels={systemPanels} />
  </section>
{/snippet}

<SmrtProvider mode="default" autoEnableSmrt={false} user={providerUser} permissions={data.permissions}>
  <AdminShell
    title="Employment Search"
    subtitle={data.appName}
    state={adminShell}
    {appBar}
    {appPanel}
    {tenantRail}
    {tenantPanel}
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

<style>
  :global(body) {
    background: var(--smrt-color-surface);
  }

  :global(.smrt-admin-shell) {
    --smrt-admin-shell-left-expanded: 18rem;
    --smrt-admin-shell-right-expanded: min(420px, 32vw);
  }

  :global(.smrt-admin-shell__edge--top .smrt-admin-shell__band),
  :global(.smrt-admin-shell__edge--bottom .smrt-admin-shell__band) {
    padding: 0;
  }

  .admin-app-bar,
  .admin-app-bar-left,
  .admin-app-bar-actions,
  .admin-brand,
  .admin-user-button,
  .admin-panel-header,
  .admin-focus-switcher,
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

  .admin-app-bar-left,
  .admin-app-bar-actions {
    gap: 8px;
  }

  .admin-app-bar-actions form {
    display: contents;
  }

  .admin-brand {
    gap: 10px;
    color: inherit;
    text-decoration: none;
  }

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
    font-size: 14px;
    line-height: 1.2;
  }

  .admin-icon-button,
  .admin-user-button,
  .admin-focus-rail button,
  .admin-focus-switcher button {
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
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
  }

  .admin-user-button {
    gap: 7px;
    min-width: 0;
    max-width: min(280px, 38vw);
    height: 32px;
    padding: 0 9px;
  }

  .admin-user-button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .admin-icon-button:hover,
  .admin-icon-button:focus-visible,
  .admin-user-button:hover,
  .admin-user-button:focus-visible,
  .admin-focus-rail button:hover,
  .admin-focus-rail button.active,
  .admin-focus-switcher button:hover,
  .admin-focus-switcher button.active {
    border-color: var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
  }

  .admin-icon-button:focus-visible,
  .admin-user-button:focus-visible,
  .admin-focus-rail button:focus-visible,
  .admin-focus-switcher button:focus-visible {
    outline: 2px solid var(--smrt-color-on-surface);
    outline-offset: 2px;
  }

  .admin-tenant-rail,
  .admin-focus-rail {
    display: grid;
    justify-items: center;
    align-content: start;
    gap: 7px;
    min-height: 100%;
  }

  .admin-tenant-panel,
  .admin-focus-panel,
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

  .admin-panel-header span {
    display: block;
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    line-height: 1.2;
  }

  .admin-panel-header strong {
    display: block;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.2;
  }

  .admin-focus-rail button {
    position: relative;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
  }

  .admin-focus-switcher {
    flex-wrap: wrap;
    gap: 6px;
  }

  .admin-focus-switcher button {
    gap: 6px;
    min-width: 0;
    min-height: 30px;
    padding: 0 8px;
    font-size: 12px;
  }

  .admin-dock-badge {
    position: absolute;
    top: 3px;
    right: 2px;
    display: grid;
    place-items: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--smrt-color-warning);
    color: var(--smrt-color-on-warning);
    font-size: 9px;
    font-weight: 800;
    line-height: 1;
  }

  .admin-system-bar {
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    height: 100%;
    padding: 0 14px;
  }

  .admin-system-bar :global(.smrt-system-status-chips) {
    justify-content: flex-end;
  }

  .admin-content {
    display: grid;
    align-content: start;
    gap: 14px;
    min-height: 100%;
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
    .admin-brand-eyebrow,
    .admin-user-button span {
      display: none;
    }

    .admin-user-button {
      width: 32px;
      padding: 0;
      justify-content: center;
    }

    .admin-content {
      padding: 14px;
    }
  }
</style>
