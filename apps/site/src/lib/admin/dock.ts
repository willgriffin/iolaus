import type { AdminResource, ReferenceOptionsByField } from './resources';

export interface AdminRecord {
  id?: string;
  [key: string]: unknown;
}

/**
 * Situational context every admin resource page feeds to the right-hand dock.
 *
 * The dock is reserved for high-level, cross-page context (the chat agent that
 * can move through the site). Per-record editing lives with the list machinery
 * (expansion rows, bulk toolbar) and the detail pages, so this payload carries
 * "where the user is and what they are looking at" rather than tool state.
 */
export interface AdminResourceDockData {
  comboOptions?: Record<string, Array<{ label: string; value: string }>>;
  referenceOptions?: ReferenceOptionsByField;
  records: AdminRecord[];
  resource: AdminResource;
  selectedRecord: AdminRecord | null;
}

export interface AdminDockTool {
  badge?: number | string | null;
  icon: string;
  id: string;
  label: string;
}

export interface AdminDockApi {
  close: () => void;
  open: (toolId: string) => void;
  setResourceContext: (context: AdminResourceDockData | null) => void;
}

export const ADMIN_DOCK_CONTEXT = Symbol('admin-dock-context');

export function adminDockContextsMatch(
  current: AdminResourceDockData | null,
  next: AdminResourceDockData | null,
): boolean {
  if (current === next) return true;
  if (!current || !next) return false;

  return (
    current.resource.slug === next.resource.slug &&
    current.records === next.records &&
    (current.selectedRecord?.id ?? null) === (next.selectedRecord?.id ?? null)
  );
}

export function routeContextForAdminResource(
  pathname: string,
  resources: AdminResource[],
): AdminResourceDockData | null {
  const [adminSegment, resourceSlug, ...rest] = pathname
    .split('/')
    .filter(Boolean);
  if (adminSegment !== 'admin' || !resourceSlug || rest.length > 0) return null;

  const resource = resources.find((item) => item.slug === resourceSlug);
  if (!resource) return null;

  return {
    comboOptions: {},
    referenceOptions: {},
    records: [],
    resource,
    selectedRecord: null,
  };
}

/**
 * Tools the dock exposes for the current context. Per-record tools were
 * retired (see issue #421); the dock keeps only the shell and the context feed
 * until the chat-agent surface lands, so no resource contributes tools today.
 */
export function buildAdminDockTools(
  _context: AdminResourceDockData | null,
  _activeToolId: string | null = null,
): AdminDockTool[] {
  return [];
}
