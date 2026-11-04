<script lang="ts">
import { liveCollection } from '@happyvertical/smrt-svelte/web';
import {
  createSmrtCollection,
  invalidateSmrtWebCollections,
} from '@happyvertical/smrt-web';
import { onDestroy, onMount, untrack } from 'svelte';
import { browser } from '$app/environment';
import { page } from '$app/state';
import type { AdminRecord } from '$lib/admin/dock';
import type { AdminListPagination } from '$lib/admin/pagination';
import type { MatchingDiscoveryProgress } from '$lib/admin/resource-shell';
import type {
  AdminResource,
  ReferenceOptionsByField,
} from '$lib/admin/resources';
import type { OpportunityFilterOptions } from '$lib/opportunity-filters';
import AdminResourcePage from './AdminResourcePage.svelte';
import { getAdminResourceCollectionDefinition } from './admin-resource-definitions';
import {
  ADMIN_RESOURCE_REFRESH_EVENT,
  type AdminResourceListPayload,
  adminResourceQueryScope,
  createAdminLiveInvalidationCapabilities,
  createAdminResourceFetchers,
  getAdminSmrtWebClient,
  getCachedAdminResourceListPayload,
  invalidateAdminResourceLists,
  isHydratedAdminResourceSlug,
  rememberAdminResourceListPayload,
} from './admin-resource-hydration';

type ResourcePageData = {
  activeReviewFilter: string;
  activeTaskOwnerFilter: string;
  activeTaskStatusFilter: string;
  candidateSkills: string[];
  comboOptions: Record<string, Array<{ label: string; value: string }>>;
  error?: string | null;
  loading?: boolean;
  opportunityFilterOptions: OpportunityFilterOptions;
  matchingProgress?: MatchingDiscoveryProgress;
  /** Carried through to the bulk actions; see `AdminResourceListPayload`. */
  opportunityQueryFingerprint?: string;
  referenceOptions: ReferenceOptionsByField;
  pagination: AdminListPagination;
  records: AdminRecord[];
  refreshing?: boolean;
  resource: AdminResource;
  stale?: boolean;
  tenantId?: string | null;
  user?: { id?: string | null } | null;
};

let { data, form } = $props<{
  data: ResourcePageData;
  form?: unknown;
}>();

const initialData = untrack(() => data);
const initialResource = untrack(() => initialData.resource);
const resourceSlug = initialResource.slug;
if (!isHydratedAdminResourceSlug(resourceSlug)) {
  throw new Error(`Unsupported hydrated admin resource: ${resourceSlug}`);
}

const resourceDefinition = getAdminResourceCollectionDefinition(resourceSlug);
const initialSearch = untrack(() => page.url.search);
const queryScope = adminResourceQueryScope(
  resourceSlug,
  initialSearch,
  initialData.tenantId,
  initialData.user?.id,
);
const cachedPayload =
  browser && resourceSlug !== 'opportunities'
    ? getCachedAdminResourceListPayload(queryScope)
    : null;
let acceptsPayload = true;
let listFetchError = $state<string | null>(null);
let listFetchPending = false;
let formObservationReady = $state(false);
let lastForm = $state<unknown>(undefined);
let currentData = $state<ResourcePageData>(
  cachedPayload
    ? resourceDataFromPayload(cachedPayload)
    : { ...initialData, loading: initialData.loading ?? true },
);

function resourceDataFromPayload(
  payload: AdminResourceListPayload,
): ResourcePageData {
  return {
    ...payload,
    error: null,
    loading: false,
    refreshing: false,
    resource: initialResource,
    stale: false,
  };
}

function receiveListPayload(payload: AdminResourceListPayload): void {
  if (!acceptsPayload) return;
  listFetchError = null;
  if (resourceSlug !== 'opportunities')
    rememberAdminResourceListPayload(queryScope, payload);
  currentData = resourceDataFromPayload(payload);
}

const resourceClient = getAdminSmrtWebClient();
const resourceFetchers = createAdminResourceFetchers(
  resourceSlug,
  initialSearch,
  receiveListPayload,
);
const resourceCollection = createSmrtCollection(resourceDefinition, {
  capabilities: createAdminLiveInvalidationCapabilities(resourceSlug),
  client: resourceClient ?? undefined,
  fetchers: {
    ...resourceFetchers,
    list: async (params) => {
      listFetchPending = true;
      try {
        return await resourceFetchers.list(params);
      } catch (error) {
        // Observe the authenticated read itself: the live-query/preload
        // lifecycle can remain pending after an asynchronous HTTP failure.
        if (acceptsPayload)
          listFetchError =
            error instanceof Error
              ? error.message
              : 'Unable to load this admin resource.';
        throw error;
      } finally {
        listFetchPending = false;
      }
    },
  },
  scope: queryScope,
  staleTimeMs: 0,
});
// `liveCollection` is browser-only. The route deliberately renders its cheap
// shell during SSR; the browser binding owns the subsequent authenticated read.
const resourceView = browser ? liveCollection(resourceCollection) : null;
const hydratedRecords = $derived.by(() => {
  // Opportunity list rows and their match score arrive from the same server
  // response. Raw catalog events cannot establish profile-specific eligibility.
  if (resourceSlug === 'opportunities' || !resourceView?.isReady)
    return currentData.records;
  return resourceView.rows.map((record) => ({ ...record }));
});
const requestError = $derived(
  listFetchError ??
    (currentData.loading && resourceView?.isError
      ? resourceView.error instanceof Error
        ? resourceView.error.message
        : String(resourceView.error ?? 'Unable to load this admin resource.')
      : null),
);
const isInitialLoad = $derived(
  Boolean(currentData.loading) && !resourceView?.isReady && !requestError,
);
const isCachedRevalidation = $derived(
  Boolean(cachedPayload) && !resourceView?.isReady && !requestError,
);
const hydratedData = $derived({
  ...currentData,
  error: requestError,
  loading: isInitialLoad,
  records:
    resourceSlug === 'opportunities' && requestError ? [] : hydratedRecords,
  refreshing: isCachedRevalidation,
  stale:
    isCachedRevalidation || Boolean(requestError && currentData.records.length),
});

function retryListLoad(): void {
  if (!acceptsPayload || listFetchPending) return;
  // preload observes the existing collection lifecycle. Invalidate through
  // SMRT's public cache seam so Retry starts a fresh read of the same query.
  if (resourceClient)
    invalidateSmrtWebCollections(resourceClient, [resourceDefinition.name]);
  void resourceCollection.preload().catch(() => undefined);
}

$effect(() => {
  const currentForm = form;
  if (!formObservationReady) {
    formObservationReady = true;
    lastForm = currentForm;
    return;
  }
  if (currentForm === lastForm) return;
  lastForm = currentForm;
  retryListLoad();
});

// Enhanced form actions re-run `load` through invalidateAll instead of
// reloading the page, and an action may return no data (leaving `form`
// unchanged), so a new shell `data` object also refreshes the list (#90).
let lastData = untrack(() => data);
$effect(() => {
  const currentData = data;
  if (currentData === lastData) return;
  lastData = currentData;
  retryListLoad();
});

onMount(() => {
  // Form actions outside the collection CRUD surface (for example the
  // inactive-source sweep) emit this event after their mutation succeeds.
  // `preload()` alone only observes the existing cache entry; invalidating
  // through the shared live subscriber marks that entry stale and refetches
  // the server-filtered page and its authoritative total.
  const refresh = () => invalidateAdminResourceLists();
  window.addEventListener(ADMIN_RESOURCE_REFRESH_EVENT, refresh);
  const refreshMatching = () => {
    if (
      resourceSlug === 'opportunities' &&
      ['pending', 'failed'].includes(
        currentData.matchingProgress?.status ?? '',
      ) &&
      document.visibilityState === 'visible'
    )
      retryListLoad();
  };
  const timer =
    resourceSlug === 'opportunities'
      ? window.setInterval(refreshMatching, 5000)
      : undefined;
  const onVisible = () => {
    if (
      resourceSlug === 'opportunities' &&
      document.visibilityState === 'visible'
    )
      retryListLoad();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener(ADMIN_RESOURCE_REFRESH_EVENT, refresh);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(timer);
  };
});

onDestroy(() => {
  acceptsPayload = false;
  void resourceCollection.cleanup().catch(() => undefined);
});
</script>

<AdminResourcePage data={hydratedData} {form} onRetry={retryListLoad} />
