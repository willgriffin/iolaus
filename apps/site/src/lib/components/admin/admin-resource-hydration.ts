import {
  manifestHash,
  type SmrtWebCollectionDefinitions,
} from '@happyvertical/smrt-virt-web';
import {
  createSmrtWebClient,
  createSmrtWebEventSubscriber,
  liveInvalidation,
  type SmrtCrudFetchers,
  type SmrtWebCapability,
  type SmrtWebClient,
  type SmrtWebEventSubscriber,
  type SmrtWebRow,
} from '@happyvertical/smrt-web';
import { browser } from '$app/environment';
import type { AdminRecord } from '$lib/admin/dock';
import type { AdminListPagination } from '$lib/admin/pagination';
import type {
  AdminResource,
  ReferenceOptionsByField,
} from '$lib/admin/resources';
import {
  EMPTY_OPPORTUNITY_FILTER_OPTIONS,
  type OpportunityFilterOptions,
} from '$lib/opportunity-filters';

export type HydratedAdminResourceSlug = Extract<
  keyof SmrtWebCollectionDefinitions,
  'applications' | 'opportunities' | 'tasks'
>;

const HYDRATED_ADMIN_RESOURCES = {
  applications: { tableName: 'applications' },
  opportunities: { tableName: 'opportunities' },
  tasks: { tableName: 'tasks' },
} as const satisfies Record<HydratedAdminResourceSlug, { tableName: string }>;

export const ADMIN_RESOURCE_REFRESH_EVENT = 'iolaus:admin-resource-refresh';

let adminLiveSubscriber: SmrtWebEventSubscriber | null = null;
let adminSmrtWebClient: SmrtWebClient | null = null;
const adminListPayloadCache = new Map<string, AdminResourceListPayload>();
const MAX_ADMIN_LIST_PAYLOAD_CACHE_ENTRIES = 24;

export interface AdminResourceListPayload {
  activeReviewFilter: string;
  activeTaskOwnerFilter: string;
  activeTaskStatusFilter: string;
  candidateSkills: string[];
  comboOptions: Record<string, Array<{ label: string; value: string }>>;
  opportunityFilterOptions: OpportunityFilterOptions;
  /**
   * Digest of the filter state this listing was resolved under (opportunities
   * only). A bulk action over "all matching rows" hands this back instead of a
   * list of ids, so it has to survive normalization: without it the browser
   * sends an empty fingerprint and the server refuses the action as
   * `stale_query_fingerprint`.
   */
  opportunityQueryFingerprint?: string;
  pagination: AdminListPagination;
  records: AdminRecord[];
  referenceOptions: ReferenceOptionsByField;
  resource?: AdminResource;
}

/**
 * Return the browser-wide SMRT client used by admin collections.
 *
 * Keep this lazy so importing the module during SSR never creates browser
 * cache state. A shared client lets hydrated resource collections reuse cache
 * entries and deduplicate concurrent reads across admin navigation.
 */
export function getAdminSmrtWebClient(): SmrtWebClient | null {
  if (!browser) return null;
  adminSmrtWebClient ??= createSmrtWebClient();
  return adminSmrtWebClient;
}

export function isHydratedAdminResourceSlug(
  slug: string,
): slug is HydratedAdminResourceSlug {
  return Object.hasOwn(HYDRATED_ADMIN_RESOURCES, slug);
}

export function adminRowsFromRecords(
  records: AdminRecord[],
): Array<SmrtWebRow<Record<string, unknown>>> {
  return records
    .map((record) => {
      const id = typeof record.id === 'string' ? record.id : '';
      return id ? { ...record, id } : null;
    })
    .filter(
      (record): record is SmrtWebRow<Record<string, unknown>> =>
        record !== null,
    );
}

/**
 * Keep query cache identities stable across equivalent URL parameter ordering.
 * The tenant and user segment prevents an in-memory browser cache from crossing
 * an authenticated admin boundary.
 */
export function adminResourceQueryScope(
  resourceSlug: string,
  search: string,
  tenantId: string | null | undefined,
  userId: string | null | undefined,
): string {
  const params = Array.from(new URLSearchParams(search).entries()).sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  );
  const canonicalSearch = new URLSearchParams(params).toString();
  return `admin:${tenantId ?? 'none'}:${userId ?? 'anonymous'}:${resourceSlug}:${canonicalSearch}`;
}

export function getCachedAdminResourceListPayload(
  scope: string,
): AdminResourceListPayload | null {
  const payload = adminListPayloadCache.get(scope);
  if (!payload) return null;

  // Promote recently used entries so a long admin session retains the most
  // likely back-navigation targets without unbounded browser memory growth.
  adminListPayloadCache.delete(scope);
  adminListPayloadCache.set(scope, payload);
  return payload;
}

export function createAdminResourceFetchers(
  resourceSlug: HydratedAdminResourceSlug,
  search: string,
  onListPayload?: (payload: AdminResourceListPayload) => void,
): SmrtCrudFetchers {
  const headers = { 'Content-Type': 'application/json' };
  const adminListPath = `/api/admin-resources/${resourceSlug}${search}`;
  const collectionPath = `/api/${resourceSlug}`;
  const recordPath = (id: string) =>
    `${collectionPath}/${encodeURIComponent(id)}`;

  return {
    list: async () => {
      const payload = await readAdminResourceListPayload(
        adminListPath,
        headers,
      );
      onListPayload?.(payload);
      return payload.records;
    },
    get: async (id) => readJson(await fetch(recordPath(id), { headers })),
    create: async (record) =>
      readJson(
        await fetch(collectionPath, {
          body: JSON.stringify(record),
          headers,
          method: 'POST',
        }),
      ),
    update: async (id, record) =>
      readJson(
        await fetch(recordPath(id), {
          body: JSON.stringify(record),
          headers,
          method: 'PUT',
        }),
      ),
    delete: async (id) =>
      readJson(
        await fetch(recordPath(id), {
          headers,
          method: 'DELETE',
        }),
      ),
  };
}

export async function readAdminResourceListPayload(
  adminListPath: string,
  headers: HeadersInit,
): Promise<AdminResourceListPayload> {
  const payload = await readJson(await fetch(adminListPath, { headers }));
  if (!payload || typeof payload !== 'object') {
    throw new Error('[smrt-web] admin resource response was not an object');
  }

  const value = payload as Partial<AdminResourceListPayload> & {
    data?: unknown;
  };
  const records = Array.isArray(value.records)
    ? value.records
    : Array.isArray(value.data)
      ? value.data
      : null;
  if (!records || !value.pagination) {
    throw new Error('[smrt-web] admin resource response was incomplete');
  }

  const normalized: AdminResourceListPayload = {
    activeReviewFilter: value.activeReviewFilter ?? 'all',
    activeTaskOwnerFilter: value.activeTaskOwnerFilter ?? 'all',
    activeTaskStatusFilter: value.activeTaskStatusFilter ?? 'all',
    candidateSkills: value.candidateSkills ?? [],
    comboOptions: value.comboOptions ?? {},
    opportunityFilterOptions:
      value.opportunityFilterOptions ?? EMPTY_OPPORTUNITY_FILTER_OPTIONS,
    ...(typeof value.opportunityQueryFingerprint === 'string'
      ? { opportunityQueryFingerprint: value.opportunityQueryFingerprint }
      : {}),
    pagination: value.pagination,
    records: records as AdminRecord[],
    referenceOptions: value.referenceOptions ?? {},
    resource: value.resource,
  };
  return normalized;
}

export function rememberAdminResourceListPayload(
  scope: string,
  payload: AdminResourceListPayload,
): void {
  adminListPayloadCache.delete(scope);
  adminListPayloadCache.set(scope, payload);
  if (adminListPayloadCache.size <= MAX_ADMIN_LIST_PAYLOAD_CACHE_ENTRIES)
    return;
  const oldestScope = adminListPayloadCache.keys().next().value;
  if (oldestScope) adminListPayloadCache.delete(oldestScope);
}

export function createAdminLiveInvalidationCapabilities(
  resourceSlug: HydratedAdminResourceSlug,
): Array<SmrtWebCapability<Record<string, unknown>>> {
  const subscriber = getAdminLiveSubscriber();
  if (!subscriber) return [];

  return [
    liveInvalidation({
      subscriber,
      tableName: HYDRATED_ADMIN_RESOURCES[resourceSlug].tableName,
    }),
  ];
}

async function readJson(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? String((payload as { error: string }).error)
        : `HTTP ${response.status}`;
    throw new Error(`[smrt-web] admin resource request failed: ${message}`);
  }
  return payload;
}

function getAdminLiveSubscriber(): SmrtWebEventSubscriber | null {
  if (!browser) return null;
  adminLiveSubscriber ??= createSmrtWebEventSubscriber({
    changesUrl: '/api/_changes',
    eventsUrl: '/api/_events',
    manifestHash,
    pollIntervalMs: 5000,
  });
  return adminLiveSubscriber;
}
