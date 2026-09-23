import type { AdminListPagination } from '$lib/admin/pagination';
import { positiveIntegerSearchParam } from '$lib/admin/pagination';
import {
  type AdminResource,
  getAdminResource,
  type ReferenceOptionsByField,
} from '$lib/admin/resources';
import {
  EMPTY_OPPORTUNITY_FILTER_OPTIONS,
  type OpportunityFilterOptions,
} from '$lib/opportunity-filters';

/**
 * Client-safe shell for admin list routes (#96).
 *
 * The resource schema and URL state render immediately; records and editor
 * metadata arrive through the authenticated list API after navigation. Keeping
 * this out of `$lib/server` lets the route build it in a universal load, so an
 * in-app click swaps pages without a server round trip.
 */

export type AdminRecord = Record<string, unknown> & { id?: string };

export const DEFAULT_ADMIN_RECORD_PAGE_SIZE = 250;
export const OPPORTUNITY_TABLE_PAGE_SIZE = 100;
export const OPPORTUNITY_DEFAULT_REVIEW_FILTER = 'unsorted';

export interface AdminResourcePageData {
  activeReviewFilter: string;
  activeTaskOwnerFilter: string;
  activeTaskStatusFilter: string;
  candidateSkills: string[];
  comboOptions: Record<string, Array<{ label: string; value: string }>>;
  error?: string | null;
  loading?: boolean;
  opportunityFilterOptions: OpportunityFilterOptions;
  /**
   * Digest of the filter state this page was resolved under (opportunities
   * only). A bulk action over "all matching rows" hands this back instead of
   * a list of ids, so the server can re-resolve the set and refuse the action
   * if the caller's filters have drifted from the ones the operator saw.
   */
  opportunityQueryFingerprint?: string;
  pagination: AdminListPagination;
  records: AdminRecord[];
  referenceOptions: ReferenceOptionsByField;
  refreshing?: boolean;
  resource: AdminResource;
  stale?: boolean;
  tenantId?: string | null;
  user?: { id?: string | null } | null;
}

/**
 * Keep the requested page visible while the real total is still loading.
 * `createAdminListPagination` correctly clamps page numbers against a known
 * total, but a shell total of zero must not erase a deep-linked page.
 */
export function createPendingAdminListPagination(
  requestedPage: number,
  pageSize: number,
): AdminListPagination {
  return {
    end: 0,
    hasNextPage: false,
    hasPreviousPage: requestedPage > 1,
    offset: (requestedPage - 1) * pageSize,
    page: requestedPage,
    pageSize,
    recordCount: 0,
    start: 0,
    totalPages: requestedPage,
    totalRecords: 0,
  };
}

/** Build the list-route shell, or `null` for an unknown resource slug. */
export function buildAdminResourceShell(
  resourceSlug: string,
  url: URL,
  identity: {
    tenantId?: string | null;
    user?: { id?: string | null } | null;
  } = {},
): AdminResourcePageData | null {
  const resource = getAdminResource(resourceSlug);
  if (!resource) return null;
  const requestedPage = positiveIntegerSearchParam(url, 'page', 1);
  const reviewFilter =
    resource.slug === 'opportunities'
      ? (url.searchParams.get('review') ?? OPPORTUNITY_DEFAULT_REVIEW_FILTER)
      : 'all';
  const taskOwnerFilter =
    resource.slug === 'tasks'
      ? (url.searchParams.get('owner') ?? 'all')
      : 'all';
  const taskStatusFilter =
    resource.slug === 'tasks'
      ? (url.searchParams.get('status') ?? 'all')
      : 'all';
  const pageSize =
    resource.slug === 'opportunities'
      ? OPPORTUNITY_TABLE_PAGE_SIZE
      : DEFAULT_ADMIN_RECORD_PAGE_SIZE;

  return {
    activeReviewFilter: reviewFilter,
    activeTaskOwnerFilter: taskOwnerFilter,
    activeTaskStatusFilter: taskStatusFilter,
    candidateSkills: [],
    comboOptions: {},
    loading: true,
    opportunityFilterOptions: EMPTY_OPPORTUNITY_FILTER_OPTIONS,
    pagination: createPendingAdminListPagination(requestedPage, pageSize),
    records: [],
    referenceOptions: {},
    resource,
    tenantId: identity.tenantId ?? null,
    user: identity.user ?? null,
  };
}
