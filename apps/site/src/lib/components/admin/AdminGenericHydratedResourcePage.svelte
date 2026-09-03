<script lang="ts">
import { onDestroy, onMount, untrack } from 'svelte';
import { page } from '$app/state';
import type { AdminRecord } from '$lib/admin/dock';
import type { AdminListPagination } from '$lib/admin/pagination';
import type {
  AdminResource,
  ReferenceOptionsByField,
} from '$lib/admin/resources';
import { type OpportunityFilterOptions } from '$lib/opportunity-filters';
import AdminResourcePage from './AdminResourcePage.svelte';
import {
  type AdminResourceListPayload,
  adminResourceQueryScope,
  getCachedAdminResourceListPayload,
  readAdminResourceListPayload,
  rememberAdminResourceListPayload,
} from './admin-resource-hydration';

type GenericResourcePageData = {
  activeReviewFilter: string;
  activeTaskOwnerFilter: string;
  activeTaskStatusFilter: string;
  candidateSkills: string[];
  comboOptions: Record<string, Array<{ label: string; value: string }>>;
  error?: string | null;
  loading?: boolean;
  opportunityFilterOptions: OpportunityFilterOptions;
  pagination: AdminListPagination;
  records: AdminRecord[];
  referenceOptions: ReferenceOptionsByField;
  refreshing?: boolean;
  resource: AdminResource;
  stale?: boolean;
  tenantId?: string | null;
  user?: { id?: string | null } | null;
};

let { data, form } = $props<{
  data: GenericResourcePageData;
  form?: unknown;
}>();

const initialData = untrack(() => data);
const initialResource = untrack(() => initialData.resource);
const resourceSlug = initialResource.slug;
const initialSearch = untrack(() => page.url.search);
const queryScope = adminResourceQueryScope(
  resourceSlug,
  initialSearch,
  initialData.tenantId,
  initialData.user?.id,
);
const cachedPayload = getCachedAdminResourceListPayload(queryScope);
let currentData = $state<GenericResourcePageData>(
  cachedPayload
    ? resourceDataFromPayload(cachedPayload)
    : { ...initialData, loading: initialData.loading ?? true },
);
let acceptsPayload = true;
let formObservationReady = $state(false);
let lastForm = $state<unknown>(undefined);

function resourceDataFromPayload(
  payload: AdminResourceListPayload,
): GenericResourcePageData {
  return {
    ...payload,
    error: null,
    loading: false,
    refreshing: false,
    resource: initialResource,
    stale: false,
  };
}

let requestVersion = 0;
async function loadResource(): Promise<void> {
  const request = ++requestVersion;
  const hasVisibleRecords = currentData.records.length > 0;
  currentData = {
    ...currentData,
    error: null,
    loading: !cachedPayload && !hasVisibleRecords,
    refreshing: Boolean(cachedPayload || hasVisibleRecords),
    stale: false,
  };

  try {
    const payload = await readAdminResourceListPayload(
      `/api/admin-resources/${encodeURIComponent(resourceSlug)}${initialSearch}`,
      { 'Content-Type': 'application/json' },
    );
    if (!acceptsPayload || request !== requestVersion) return;
    rememberAdminResourceListPayload(queryScope, payload);
    currentData = resourceDataFromPayload(payload);
  } catch (error) {
    if (!acceptsPayload || request !== requestVersion) return;
    currentData = {
      ...currentData,
      error: error instanceof Error ? error.message : String(error),
      loading: false,
      refreshing: false,
      stale: currentData.records.length > 0,
    };
  }
}

function retryListLoad(): void {
  void loadResource();
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

onMount(() => {
  void loadResource();
});

onDestroy(() => {
  acceptsPayload = false;
  requestVersion += 1;
});
</script>

<AdminResourcePage data={currentData} {form} onRetry={retryListLoad} />
