<script lang="ts">
import Archive from '@lucide/svelte/icons/archive';
import BriefcaseBusiness from '@lucide/svelte/icons/briefcase-business';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import Columns3 from '@lucide/svelte/icons/columns-3';
import Eye from '@lucide/svelte/icons/eye';
import EyeOff from '@lucide/svelte/icons/eye-off';
import FileText from '@lucide/svelte/icons/file-text';
import List from '@lucide/svelte/icons/list';
import Pencil from '@lucide/svelte/icons/pencil';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import Search from '@lucide/svelte/icons/search';
import Sparkles from '@lucide/svelte/icons/sparkles';
import { getContext, onDestroy, onMount, untrack } from 'svelte';
import { enhance } from '$app/forms';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import {
  ADMIN_DOCK_CONTEXT,
  type AdminDockApi,
  type AdminRecord,
} from '$lib/admin/dock';
import type { AdminListPagination } from '$lib/admin/pagination';
import type {
  AdminResource,
  ReferenceOption,
  ReferenceOptionsByField,
  ResourceField,
} from '$lib/admin/resources';
import { displayFieldLabel } from '$lib/admin/resources';
import {
  taskAssigneeRoleDefinitions,
  taskKanbanColumnDefinitions,
  taskKanbanLaneDefinitions,
  taskStatusDefinitions,
  workflowLabel,
} from '$lib/objects/workflow';
import {
  createOpportunityBulkWorkflowClient,
  OPPORTUNITY_BULK_MAX_SELECTION_SIZE,
  OPPORTUNITY_BULK_WORKFLOW_IDS,
  OPPORTUNITY_DATA_SURFACE_IDENTITY,
  summarizeOpportunityBulkDetails,
} from '$lib/opportunity-bulk-workflows';
import {
  filterStateFromSearchParams,
  type OpportunityFilterOptions,
} from '$lib/opportunity-filters';
import SourceControlList from '../sources/SourceControlList.svelte';
import AdminRecordValue from './AdminRecordValue.svelte';
import ApplicationCardList from './ApplicationCardList.svelte';
import { ADMIN_RESOURCE_REFRESH_EVENT } from './admin-resource-hydration';
import OpportunityCardList from './OpportunityCardList.svelte';

const TASK_VIEW_STORAGE_KEY = 'iolaus.admin.tasks.view';
const TASK_COLLAPSED_LANES_STORAGE_KEY =
  'iolaus.admin.tasks.collapsedKanbanLanes';
const opportunityReviewFilters = [
  { label: 'All', value: 'all' },
  { label: 'Unsorted', value: 'unsorted' },
  { label: 'Applied', value: 'apply' },
  { label: 'Maybe', value: 'maybe' },
  { label: 'Rejected', value: 'reject' },
  { label: 'Missing planning', value: 'missing_application_planning' },
] as const;
const opportunityReviewStatuses = [
  { className: 'accept', label: 'Apply', value: 'apply' },
  { className: 'maybe', label: 'Maybe', value: 'maybe' },
  { className: 'reject', label: 'Reject', value: 'reject' },
] as const;

type TaskViewMode = 'kanban' | 'list';
type TaskSubjectLink = {
  href: string;
  id: string;
  icon?: 'application' | 'opportunity';
  label: string;
  title: string;
  variant: 'icon' | 'text';
};

let { data, form, onRetry } = $props<{
  data: {
    activeReviewFilter: string;
    activeTaskOwnerFilter: string;
    activeTaskStatusFilter: string;
    candidateSkills: string[];
    comboOptions: Record<string, Array<{ label: string; value: string }>>;
    error?: string | null;
    loading?: boolean;
    opportunityFilterOptions: OpportunityFilterOptions;
    referenceOptions: ReferenceOptionsByField;
    pagination: AdminListPagination;
    records: AdminRecord[];
    refreshing?: boolean;
    opportunityQueryFingerprint?: string;
    resource: AdminResource;
    stale?: boolean;
  };
  form?: unknown;
  onRetry?: () => void;
}>();

let selectedRecordId = $state<string | null>(null);
let selectedOpportunityIds = $state<Set<string>>(new Set());
/**
 * True when the operator has escalated a full-page selection to "every row
 * matching the current filters". The ids are deliberately NOT materialized in
 * the browser: the server re-resolves the set from the filter fingerprint, so
 * the action applies to what the filters describe rather than to a list the
 * page happened to assemble.
 */
let allMatchingSelected = $state(false);
/**
 * The query fingerprint the escalation was made under.
 *
 * "Every row matching the current filters" is only meaningful against the
 * filters the operator saw, so the escalation is pinned to the fingerprint it
 * was made under and dropped rather than silently retargeted at a set the
 * operator never selected.
 *
 * In practice the route wraps this page in `{#key slug:url.search}`, so any
 * URL change -- a filter, a sort, or a page -- rebuilds the component and
 * resets this state anyway, and the apply request fingerprint binds the page
 * number besides. The escalation is therefore per rendered listing. This check
 * is the backstop for a data change that does not replace the component.
 */
let allMatchingQueryFingerprint = $state('');
let bulkPreview = $state<{
  accepted: number;
  actionId: string;
  confirmationToken: string;
  payload: Record<string, unknown> | undefined;
  reasons: string[];
  skipped: number;
} | null>(null);
let bulkBusy = $state(false);
let bulkError = $state('');
let taskViewMode = $state<TaskViewMode>('kanban');
let taskSearchQuery = $state('');
let collapsedTaskKanbanLanes = $state<Set<string>>(new Set());
let taskPreferencesLoaded = $state(false);
let autoOpenedSelectionKey = $state('');
let skillResumeToggleOverrides = $state<Record<string, boolean>>({});
const adminDock = getContext<AdminDockApi>(ADMIN_DOCK_CONTEXT);
const selectedRecord = $derived(
  data.records.find((record: AdminRecord) => record.id === selectedRecordId) ??
    null,
);
const isTaskResource = $derived(data.resource.slug === 'tasks');
const isOpportunityResource = $derived(data.resource.slug === 'opportunities');
/** Owner decision (2026-09-02) for the inactive-source sweep. */
const OPPORTUNITY_SWEEP_NOT_SEEN_DAYS = 30;
const isApplicationResource = $derived(data.resource.slug === 'applications');
const isSkillResource = $derived(data.resource.slug === 'skills');
const isSourceResource = $derived(data.resource.slug === 'sources');
const resourceActionFeedbackMessage = $derived(
  stringFromValue(feedbackValue(form, 'message')),
);
const resourceActionFailedCount = $derived(
  numberFromValue(feedbackValue(form, 'failed')),
);
const resourceActionFeedbackTone = $derived(
  resourceActionFailedCount > 0
    ? 'error'
    : stringFromValue(feedbackValue(form, 'status')),
);
// Stage 0 inactive-source sweep. The preview submission returns the matching
// count and writes nothing; the archive button only appears once that count is
// on screen, so an apply is always a second, explicit confirmation.
const sweepPreview = $derived.by(() => {
  if (!isOpportunityResource || !feedbackValue(form, 'sweep')) return null;
  if (feedbackValue(form, 'applied') === true) return null;
  const count = numberFromValue(feedbackValue(form, 'count'));
  if (count <= 0) return null;
  return {
    count,
    notSeenDays:
      numberFromValue(feedbackValue(form, 'notSeenDays')) ||
      OPPORTUNITY_SWEEP_NOT_SEEN_DAYS,
  };
});
const rowOpensPanel = $derived(false);
const rowOpensView = $derived(
  isOpportunityResource || (data.resource.rowAction ?? 'edit') === 'edit',
);
const rowIsInteractive = $derived(rowOpensPanel || rowOpensView);
const isTaskKanbanView = $derived(isTaskResource && taskViewMode === 'kanban');
const knownTaskKanbanColumns: ReadonlySet<string> = new Set(
  taskKanbanColumnDefinitions.map((column) => column.value),
);
const knownTaskKanbanLanes: ReadonlySet<string> = new Set(
  taskKanbanLaneDefinitions.map((lane) => lane.value),
);
const taskKanbanColumnLabels: ReadonlyMap<string, string> = new Map(
  taskKanbanColumnDefinitions.map((column) => [column.value, column.label]),
);
const taskKanbanColumnOrder: ReadonlyMap<string, number> = new Map(
  taskKanbanColumnDefinitions.map((column, index) => [column.value, index]),
);
const taskSubjectDefinitions = [
  {
    field: 'companyId',
    label: 'Company',
    resourceSlug: 'companies',
    variant: 'text',
  },
  {
    field: 'opportunityId',
    icon: 'opportunity',
    label: 'Opportunity',
    resourceSlug: 'opportunities',
    variant: 'icon',
  },
  {
    field: 'applicationId',
    icon: 'application',
    label: 'Application',
    resourceSlug: 'applications',
    variant: 'icon',
  },
  {
    field: 'sourceId',
    label: 'Source',
    resourceSlug: 'sources',
    variant: 'text',
  },
  {
    field: 'decisionId',
    label: 'Decision',
    resourceSlug: 'decisions',
    variant: 'text',
  },
  {
    field: 'organizationProfileId',
    label: 'Profile',
    resourceSlug: 'candidate-profiles',
    variant: 'text',
  },
] as const;
const filteredTaskRecords = $derived.by(() => {
  if (!isTaskResource) return data.records;
  return data.records.filter(taskMatchesActiveFilters);
});
const visibleTaskListRecords = $derived.by(() => {
  if (!isTaskResource) return data.records;

  const query = taskSearchQuery.trim().toLowerCase();
  if (!query) return filteredTaskRecords;

  return filteredTaskRecords.filter((record: AdminRecord) =>
    [
      'title',
      'description',
      'taskType',
      'assigneeRole',
      'status',
      'kanbanColumn',
      'opportunityId',
      'applicationId',
      'companyId',
      'sourceId',
    ].some((key) => valueFor(record, key).toLowerCase().includes(query)),
  );
});
const displayRecords = $derived(
  isTaskResource ? visibleTaskListRecords : data.records,
);
const visibleOpportunityIds = $derived(
  isOpportunityResource
    ? displayRecords
        .map((record: AdminRecord) => record.id)
        .filter((id: string | undefined): id is string => Boolean(id))
    : [],
);
const selectedOpportunityCount = $derived(selectedOpportunityIds.size);
const selectedOpportunityRecords = $derived(
  isOpportunityResource
    ? data.records.filter(
        (record: AdminRecord) =>
          Boolean(record.id) && selectedOpportunityIds.has(String(record.id)),
      )
    : [],
);
const headerOpportunityReviewRecords = $derived.by((): AdminRecord[] => {
  if (!isOpportunityResource) return [];
  if (selectedOpportunityRecords.length > 0) return selectedOpportunityRecords;
  return selectedRecord ? [selectedRecord] : [];
});
const headerOpportunityReviewIds = $derived(
  headerOpportunityReviewRecords
    .map((record: AdminRecord) => record.id)
    .filter((id: string | undefined): id is string => Boolean(id)),
);
const headerOpportunityReviewCount = $derived(
  headerOpportunityReviewIds.length,
);
const headerOpportunitySingleReviewRecord = $derived(
  headerOpportunityReviewCount === 1 ? headerOpportunityReviewRecords[0] : null,
);
const taskRecordsByLane = $derived.by((): Map<string, AdminRecord[]> => {
  if (!isTaskResource) return new Map();

  const entries = taskKanbanLaneDefinitions.map((lane) => {
    const laneColumns = new Set<string>(lane.columns);
    const records = filteredTaskRecords
      .filter((record: AdminRecord) =>
        laneColumns.has(normalizedTaskKanbanColumn(record)),
      )
      .sort(
        (left: AdminRecord, right: AdminRecord) =>
          taskKanbanColumnSortValue(left) - taskKanbanColumnSortValue(right),
      );

    return [lane.value, records] as const;
  });
  return new Map(entries);
});

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readTaskPreference(key: string): string | null {
  const storage = browserLocalStorage();
  if (!storage) return null;

  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeTaskPreference(key: string, value: string): void {
  const storage = browserLocalStorage();
  if (!storage) return;

  try {
    storage.setItem(key, value);
  } catch {
    // Keep the board usable when persistence is unavailable.
  }
}

function removeTaskPreference(key: string): void {
  const storage = browserLocalStorage();
  if (!storage) return;

  try {
    storage.removeItem(key);
  } catch {
    // Ignore stale preference cleanup failures.
  }
}

function writeTaskViewMode(mode: TaskViewMode): void {
  writeTaskPreference(TASK_VIEW_STORAGE_KEY, mode);
}

function writeCollapsedTaskKanbanLanes(lanes: Set<string>): void {
  writeTaskPreference(
    TASK_COLLAPSED_LANES_STORAGE_KEY,
    JSON.stringify([...lanes]),
  );
}

onMount(() => {
  const storedView = readTaskPreference(TASK_VIEW_STORAGE_KEY);
  if (storedView === 'kanban' || storedView === 'list') {
    taskViewMode = storedView;
  }

  const storedCollapsedLanes = readTaskPreference(
    TASK_COLLAPSED_LANES_STORAGE_KEY,
  );
  if (storedCollapsedLanes) {
    try {
      const parsed = JSON.parse(storedCollapsedLanes);
      if (Array.isArray(parsed)) {
        collapsedTaskKanbanLanes = new Set(
          parsed.filter(
            (value): value is string =>
              typeof value === 'string' && knownTaskKanbanLanes.has(value),
          ),
        );
      }
    } catch {
      removeTaskPreference(TASK_COLLAPSED_LANES_STORAGE_KEY);
    }
  }

  taskPreferencesLoaded = true;
});

$effect(() => {
  if (!isTaskResource || !taskPreferencesLoaded) return;
  writeTaskViewMode(taskViewMode);
});

$effect(() => {
  if (!isTaskResource || !taskPreferencesLoaded) return;
  writeCollapsedTaskKanbanLanes(collapsedTaskKanbanLanes);
});

$effect(() => {
  const selectedId = page.url.searchParams.get('selected')?.trim() ?? '';
  if (!selectedId) {
    autoOpenedSelectionKey = '';
    return;
  }

  const record = data.records.find(
    (item: AdminRecord) => item.id === selectedId,
  );
  if (!record) return;

  selectedRecordId = selectedId;
  const selectionKey = `${data.resource.slug}:${selectedId}`;
  if (autoOpenedSelectionKey === selectionKey) return;

  autoOpenedSelectionKey = selectionKey;
});

$effect(() => {
  if (!isOpportunityResource) return;

  const visibleIds = new Set(visibleOpportunityIds);
  // The filters moved out from under the escalation. Drop it: an operator who
  // chose "all 300 matching" under one filter did not choose whatever the new
  // one matches.
  if (
    allMatchingSelected &&
    (data.opportunityQueryFingerprint ?? '') !== allMatchingQueryFingerprint
  ) {
    allMatchingSelected = false;
    allMatchingQueryFingerprint = '';
    bulkPreview = null;
    bulkError = '';
  }
  // An all-matching selection spans every page by definition, so pruning it
  // to the visible page would silently narrow what the operator selected.
  if (!allMatchingSelected) {
    const nextSelected = new Set(
      [...selectedOpportunityIds].filter((id) => visibleIds.has(id)),
    );
    if (nextSelected.size !== selectedOpportunityIds.size) {
      selectedOpportunityIds = nextSelected;
    }
  }
  if (selectedRecordId && !visibleIds.has(selectedRecordId)) {
    selectedRecordId = null;
  }
});

const datetimeColumns = $derived(
  new Set(
    data.resource.fields
      .filter(
        (field: ResourceField) =>
          field.kind === 'datetime' || field.kind === 'date',
      )
      .map((field: ResourceField) => field.key)
      .concat(['created_at', 'updated_at']),
  ),
);

$effect(() => {
  const context = {
    comboOptions: data.comboOptions,
    referenceOptions: data.referenceOptions,
    records: data.records,
    resource: data.resource,
    selectedRecord,
  };

  // Avoid subscribing this page effect to parent dock state reads inside the context API.
  untrack(() => {
    adminDock.setResourceContext(context);
  });
});

onDestroy(() => {
  adminDock.setResourceContext(null);
});

function stringFromValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

function numberFromValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function feedbackValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function valueFor(record: AdminRecord, key: string): string {
  return stringFromValue(record[key]);
}

function booleanFor(
  record: AdminRecord,
  key: string,
  fallback = false,
): boolean {
  const value = record[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'on')
      return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'off')
      return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function taskMatchesActiveFilters(record: AdminRecord): boolean {
  const owner = data.activeTaskOwnerFilter;
  const status = data.activeTaskStatusFilter;
  const ownerMatches =
    !owner || owner === 'all' || valueFor(record, 'assigneeRole') === owner;
  const statusMatches =
    !status || status === 'all' || valueFor(record, 'status') === status;
  return ownerMatches && statusMatches;
}

function skillResumeToggleValue(record: AdminRecord): boolean {
  const id = stringFromValue(record.id);
  if (id && Object.hasOwn(skillResumeToggleOverrides, id)) {
    return skillResumeToggleOverrides[id];
  }
  return booleanFor(record, 'useOnResume', true);
}

function enhanceSkillResumeToggle({ formData }: { formData: FormData }) {
  const id = stringFromValue(formData.get('id'));
  const nextUseOnResume = formData.get('useOnResume') === 'on';
  if (id) {
    skillResumeToggleOverrides = {
      ...skillResumeToggleOverrides,
      [id]: nextUseOnResume,
    };
  }

  return async ({
    result,
    update,
  }: {
    result: { type: string };
    update: (options: {
      invalidateAll?: boolean;
      reset?: boolean;
    }) => Promise<void>;
  }) => {
    if (result.type === 'success') {
      await update({ invalidateAll: false, reset: false });
      return;
    }

    const record = data.records.find((record: AdminRecord) => record.id === id);
    if (id && record) {
      skillResumeToggleOverrides = {
        ...skillResumeToggleOverrides,
        [id]: booleanFor(record, 'useOnResume', true),
      };
    }
    await update({ invalidateAll: false, reset: false });
  };
}

function isDateColumn(key: string): boolean {
  return datetimeColumns.has(key) || key.endsWith('At');
}

function isAuditDateColumn(key: string): boolean {
  return key === 'created_at' || key === 'updated_at';
}

function columnLabel(key: string): string {
  const field = data.resource.fields.find(
    (item: ResourceField) => item.key === key,
  );
  if (field) return displayFieldLabel(field);
  if (key === 'created_at') return 'Created';
  if (key === 'updated_at') return 'Updated';
  if (key === 'projectNames') return 'Projects';

  const spaced = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldFor(key: string): ResourceField {
  return (
    data.resource.fields.find((item: ResourceField) => item.key === key) ?? {
      key,
      kind: 'text',
      label: columnLabel(key),
    }
  );
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string') return null;

  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalizedValue =
    value.includes(' ') && !hasExplicitTimezone
      ? `${value.replace(' ', 'T')}Z`
      : value;

  const date = new Date(normalizedValue);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatRelativeDate(date: Date, clampFuture = false): string {
  let diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  if (clampFuture && diffSeconds > 0) diffSeconds = 0;

  const absSeconds = Math.abs(diffSeconds);
  const future = diffSeconds > 0;

  if (absSeconds < 45) return 'now';

  let secondsPerUnit = 60;
  let suffix = 'm';

  if (absSeconds >= 60 * 60 * 24 * 365) {
    secondsPerUnit = 60 * 60 * 24 * 365;
    suffix = 'y';
  } else if (absSeconds >= 60 * 60 * 24 * 30) {
    secondsPerUnit = 60 * 60 * 24 * 30;
    suffix = 'mo';
  } else if (absSeconds >= 60 * 60 * 24 * 7) {
    secondsPerUnit = 60 * 60 * 24 * 7;
    suffix = 'w';
  } else if (absSeconds >= 60 * 60 * 24) {
    secondsPerUnit = 60 * 60 * 24;
    suffix = 'd';
  } else if (absSeconds >= 60 * 60) {
    secondsPerUnit = 60 * 60;
    suffix = 'h';
  }
  const value = Math.max(1, Math.round(absSeconds / secondsPerUnit));

  return future ? `in ${value}${suffix}` : `${value}${suffix} ago`;
}

function recordHref(record: AdminRecord): string {
  return record.id
    ? `/admin/${data.resource.slug}/${encodeURIComponent(record.id)}`
    : `/admin/${data.resource.slug}`;
}

function editHref(record: AdminRecord): string {
  return record.id
    ? `/admin/${data.resource.slug}/${encodeURIComponent(record.id)}/edit`
    : `/admin/${data.resource.slug}`;
}

function openPrimaryTool(record: AdminRecord): void {
  selectedRecordId = record.id ?? null;
  void goto(recordHref(record));
}

function targetIsNestedControl(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest('a,button,input,select,textarea,label,form'))
    : false;
}

function openRow(record: AdminRecord, event?: MouseEvent): void {
  if (targetIsNestedControl(event?.target ?? null)) return;
  if (rowOpensPanel) {
    selectedRecordId = record.id ?? null;
    return;
  }

  if (!rowOpensView) return;

  void goto(recordHref(record));
}

function handleRowKeydown(event: KeyboardEvent, record: AdminRecord): void {
  if (targetIsNestedControl(event.target)) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;

  event.preventDefault();
  openRow(record);
}

/**
 * How many rows a bulk action would target. An all-matching selection is
 * counted from the server's own total, because the browser never holds those
 * ids.
 */
const opportunityBulkSelectionCount = $derived(
  allMatchingSelected
    ? data.pagination.totalRecords
    : selectedOpportunityIds.size,
);
/** A multi-row disposition takes the preview path; a single row still posts. */
const opportunityBulkIsMulti = $derived(
  allMatchingSelected || headerOpportunityReviewCount > 1,
);
/**
 * Offered once the whole page is selected and more rows match than fit on it,
 * so the operator can escalate to the full filtered set without paging.
 */
const canSelectAllMatchingOpportunities = $derived(
  isOpportunityResource &&
    !allMatchingSelected &&
    visibleOpportunityIds.length > 0 &&
    selectedOpportunityIds.size === visibleOpportunityIds.length &&
    data.pagination.totalRecords > visibleOpportunityIds.length &&
    data.pagination.totalRecords <= OPPORTUNITY_BULK_MAX_SELECTION_SIZE,
);

/** Read the rating and reason the operator typed alongside the disposition. */
function reviewPayloadFromForm(
  form: HTMLFormElement | null,
  humanReviewStatus: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { humanReviewStatus };
  if (!form) return payload;
  const fields = new FormData(form);
  const rating = String(fields.get('humanRating') ?? '').trim();
  if (rating) payload.humanRating = Number(rating);
  const notes = String(fields.get('humanReviewNotes') ?? '').trim();
  if (notes) payload.humanReviewNotes = notes;
  return payload;
}

const opportunityBulkClient = createOpportunityBulkWorkflowClient({
  fetch: (...args) => fetch(...args),
});

/**
 * The filter state and page the current listing was rendered under.
 *
 * Read back from the URL, which is the same source the server load used, so
 * the target the request declares matches the one the page's query
 * fingerprint was computed from. A mismatch is refused server-side rather
 * than quietly applied to a different set.
 */
function opportunityBulkTarget(): Record<string, unknown> {
  const params = page.url.searchParams;
  return {
    candidateSkills: data.candidateSkills ?? [],
    filters: filterStateFromSearchParams(params),
    page: Number(params.get('page') ?? '1') || 1,
    reviewFilter: data.activeReviewFilter,
  };
}

function opportunityBulkSelection(): Record<string, unknown> {
  if (allMatchingSelected) {
    return {
      scope: 'all-matching',
      queryFingerprint: data.opportunityQueryFingerprint ?? '',
    };
  }
  return { scope: 'explicit-ids', rowIds: [...selectedOpportunityIds] };
}

function bulkRequestBase(
  actionId: string,
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    version: 1,
    requestId: crypto.randomUUID(),
    identity: OPPORTUNITY_DATA_SURFACE_IDENTITY,
    actionId,
    expectedRevision: 0,
    selection: opportunityBulkSelection(),
    target: opportunityBulkTarget(),
    ...(payload ? { payload } : {}),
  };
}

/** Ask the server what an action would do, without doing it. */
async function previewOpportunityBulkAction(
  actionId: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  bulkBusy = true;
  bulkError = '';
  try {
    const result = await opportunityBulkClient.preview({
      ...bulkRequestBase(actionId, payload),
      phase: 'preview',
    } as never);
    if (!result.ok || !result.confirmationToken) {
      bulkPreview = null;
      bulkError = result.reason ?? 'The selection could not be resolved.';
      return;
    }
    bulkPreview = {
      actionId,
      confirmationToken: result.confirmationToken,
      payload,
      ...summarizeOpportunityBulkDetails(result.details),
    };
  } catch (caught) {
    bulkPreview = null;
    bulkError = caught instanceof Error ? caught.message : 'Preview failed.';
  } finally {
    bulkBusy = false;
  }
}

/** Apply the previewed action, carrying its confirmation. */
async function applyOpportunityBulkAction(): Promise<void> {
  const preview = bulkPreview;
  if (!preview) return;
  bulkBusy = true;
  bulkError = '';
  try {
    const result = await opportunityBulkClient.apply({
      ...bulkRequestBase(preview.actionId, preview.payload),
      phase: 'apply',
      confirmationToken: preview.confirmationToken,
      // A fresh key per attempt. It bounds the batch to one application: the
      // confirmation is consumed by the first key that presents it, so a
      // second attempt is refused as `confirmation_replayed` rather than
      // repeating the work. It deliberately does NOT replay the first
      // attempt's result -- recovering a dropped response means previewing
      // again, which re-resolves the set and shows the operator what is left
      // to do. Reusing one key across attempts would enable replay, but it
      // would also let a reservation orphaned by a crash wedge that key,
      // since the store expires preview tokens and not idempotency
      // reservations.
      idempotencyKey: crypto.randomUUID(),
    } as never);
    if (!result.ok) {
      // Clear the preview as well as reporting the reason. The strip renders
      // the error only when no preview is showing, and a refused apply has
      // spent its confirmation anyway -- a stale preview left on screen would
      // keep offering a Confirm that can now only be refused again.
      bulkPreview = null;
      bulkError = result.reason ?? 'The action could not be applied.';
      return;
    }
    // `ok` means the batch ran, not that every row changed. A row whose
    // revision drifted, whose status moved, or whose enqueue failed comes back
    // as a per-row outcome, so report those rather than clearing the strip and
    // letting a partial batch look complete.
    const applied = summarizeOpportunityBulkDetails(result.details);
    bulkPreview = null;
    allMatchingSelected = false;
    allMatchingQueryFingerprint = '';
    selectedOpportunityIds = new Set();
    window.dispatchEvent(new Event(ADMIN_RESOURCE_REFRESH_EVENT));
    if (applied.skipped > 0) {
      bulkError = `Applied to ${applied.accepted} of ${
        applied.accepted + applied.skipped
      }; ${applied.skipped} unchanged${
        applied.reasons.length > 0 ? ` (${applied.reasons.join(', ')})` : ''
      }.`;
    }
  } catch (caught) {
    // The request may or may not have been applied. The confirmation is
    // single-use and each attempt mints its own idempotency key, so the only
    // safe next step is a fresh preview against the current rows.
    bulkPreview = null;
    bulkError = caught instanceof Error ? caught.message : 'Apply failed.';
  } finally {
    bulkBusy = false;
  }
}

function selectAllMatchingOpportunities(): void {
  allMatchingSelected = true;
  // Pin the escalation to the query it was made under.
  allMatchingQueryFingerprint = data.opportunityQueryFingerprint ?? '';
  bulkPreview = null;
  bulkError = '';
}

function clearOpportunityBulkSelection(): void {
  allMatchingSelected = false;
  allMatchingQueryFingerprint = '';
  selectedOpportunityIds = new Set();
  bulkPreview = null;
  bulkError = '';
}

function setOpportunitySelection(ids: Set<string>): void {
  selectedOpportunityIds = new Set(ids);
  // Any manual change to the checkboxes is a narrower, explicit selection
  // again; it must not silently keep meaning "everything matching".
  allMatchingSelected = false;
  allMatchingQueryFingerprint = '';
  bulkPreview = null;
}

function selectRecordForDock(record: AdminRecord): void {
  selectedRecordId = record.id ?? null;
}

function displayValue(record: AdminRecord, key: string): string {
  if (isDateColumn(key)) {
    const date = parseDateValue(record[key]);
    if (date) return formatRelativeDate(date, isAuditDateColumn(key));
  }

  const value = valueFor(record, key);
  return value.length > 96 ? `${value.slice(0, 93)}...` : value;
}

function displayTitle(record: AdminRecord, key: string): string | undefined {
  if (!isDateColumn(key)) return undefined;

  const date = parseDateValue(record[key]);
  return date?.toLocaleString();
}

function referenceLabelForField(field: string, id: string): string | null {
  return (
    data.referenceOptions[field]?.find(
      (option: ReferenceOption) => option.value === id,
    )?.label ?? null
  );
}

function compactMultilineText(value: string, fallback = 'Unknown'): string {
  const text = value
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
  return text || fallback;
}

function numericValue(record: AdminRecord, key: string): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCompactNumber(value: number): string {
  if (Math.abs(value) >= 1000) {
    const compact = value / 1000;
    return `${Number.isInteger(compact) ? compact.toFixed(0) : compact.toFixed(1)}k`;
  }
  return new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatRange(
  min: number | null,
  max: number | null,
  formatter = formatCompactNumber,
): string {
  if (min !== null && max !== null) {
    if (min === max) return formatter(min);
    return `${formatter(min)}-${formatter(max)}`;
  }
  if (min !== null) return `${formatter(min)}+`;
  if (max !== null) return `Up to ${formatter(max)}`;
  return '';
}

function opportunityScoreValue(record: AdminRecord): number | null {
  return numericValue(record, 'latestScore');
}

function taskFilterHref(next: { owner?: string; status?: string }): string {
  const owner = next.owner ?? data.activeTaskOwnerFilter ?? 'all';
  const status = next.status ?? data.activeTaskStatusFilter ?? 'all';
  const params = new URLSearchParams();
  if (owner !== 'all') params.set('owner', owner);
  if (status !== 'all') params.set('status', status);
  const query = params.toString();
  const basePath = '/admin/tasks';
  return query ? `${basePath}?${query}` : basePath;
}

function setTaskViewMode(mode: TaskViewMode): void {
  taskViewMode = mode;
  writeTaskViewMode(mode);
}

function taskLaneIsCollapsed(lane: string): boolean {
  return collapsedTaskKanbanLanes.has(lane);
}

function toggleTaskLane(lane: string): void {
  const next = new Set(collapsedTaskKanbanLanes);
  if (next.has(lane)) {
    next.delete(lane);
  } else {
    next.add(lane);
  }
  collapsedTaskKanbanLanes = next;
  writeCollapsedTaskKanbanLanes(next);
}

function normalizedTaskKanbanColumn(record: AdminRecord): string {
  const column = valueFor(record, 'kanbanColumn');
  return knownTaskKanbanColumns.has(column) ? column : 'inbox';
}

function taskKanbanColumnSortValue(record: AdminRecord): number {
  return taskKanbanColumnOrder.get(normalizedTaskKanbanColumn(record)) ?? 0;
}

function taskKanbanColumnLabel(record: AdminRecord): string {
  const column = normalizedTaskKanbanColumn(record);
  return taskKanbanColumnLabels.get(column) ?? workflowLabel(column);
}

function adminRecordHref(resourceSlug: string, recordId: string): string {
  return `/admin/${resourceSlug}/${encodeURIComponent(recordId)}`;
}

function taskSubjectHref(
  resourceSlug: string,
  field: string,
  task: AdminRecord,
): string {
  const recordId = valueFor(task, field);
  if (
    field === 'applicationId' &&
    valueFor(task, 'taskType') === 'approve_application'
  ) {
    return `/admin/applications/${encodeURIComponent(recordId)}`;
  }
  return adminRecordHref(resourceSlug, recordId);
}

function taskSubjectReferenceLabel(field: string, id: string): string | null {
  return (
    data.referenceOptions[field]?.find(
      (option: ReferenceOption) => option.value === id,
    )?.label ?? null
  );
}

function taskSubjectLinks(record: AdminRecord): TaskSubjectLink[] {
  const links: TaskSubjectLink[] = [];
  for (const definition of taskSubjectDefinitions) {
    const id = valueFor(record, definition.field);
    if (!id) continue;
    const referenceLabel = taskSubjectReferenceLabel(definition.field, id);
    const isReviewApplication =
      definition.field === 'applicationId' &&
      valueFor(record, 'taskType') === 'approve_application';
    const fallbackLabel = isReviewApplication
      ? 'Review application'
      : definition.label;
    const titlePrefix = isReviewApplication
      ? 'Review application'
      : definition.label;
    const label = referenceLabel ?? fallbackLabel;
    links.push({
      href: taskSubjectHref(definition.resourceSlug, definition.field, record),
      id,
      icon: 'icon' in definition ? definition.icon : undefined,
      label,
      title: referenceLabel ? `${titlePrefix}: ${referenceLabel}` : label,
      variant: definition.variant,
    });
  }
  return links;
}

function taskMeta(record: AdminRecord): string {
  return [
    valueFor(record, 'taskType')
      ? workflowLabel(valueFor(record, 'taskType'))
      : '',
  ]
    .filter(Boolean)
    .join(' / ');
}
</script>

{#snippet opportunityBulkToolbar()}
  {#if isOpportunityResource}
    <form
      method="POST"
      action="?/previewInactiveOpportunitySweep"
      class="sweep-form"
      aria-label="Inactive-source sweep"
    >
      <input
        type="hidden"
        name="notSeenDays"
        value={sweepPreview?.notSeenDays ?? OPPORTUNITY_SWEEP_NOT_SEEN_DAYS}
      />
      {#if sweepPreview}
        <button
          type="submit"
          class="sweep-apply"
          formaction="?/applyInactiveOpportunitySweep"
          title={`Archive ${sweepPreview.count} opportunities under inactive sources not seen for ${sweepPreview.notSeenDays} days`}
        >
          <Archive size={14} strokeWidth={2.2} />
          <span>Archive {sweepPreview.count}</span>
        </button>
      {:else}
        <button
          type="submit"
          class="sweep-preview"
          title={`Count opportunities under inactive sources not seen for ${OPPORTUNITY_SWEEP_NOT_SEEN_DAYS} days. Nothing is changed.`}
        >
          <Archive size={14} strokeWidth={2.2} />
          <span>Sweep inactive</span>
        </button>
      {/if}
    </form>
  {/if}
  <!--
    An all-matching escalation holds no ids in the browser, so the per-page
    intersection does not describe it. Gate on the effective selection so the
    controls follow the selection the toolbar reports rather than the checkbox
    set.
  -->
  {#if isOpportunityResource && (headerOpportunityReviewCount > 0 || allMatchingSelected)}
    <form
      method="POST"
      action={headerOpportunityReviewCount > 1
        ? '?/bulkReviewOpportunities'
        : '?/reviewOpportunity'}
      class="bulk-review-form"
      aria-label={headerOpportunityReviewCount > 1
        ? 'Bulk opportunity review'
        : 'Opportunity review'}
    >
      {#each headerOpportunityReviewIds as opportunityId}
        <input type="hidden" name="opportunityId" value={opportunityId} />
      {/each}
      <label>
        <span>Rating</span>
        <select
          name="humanRating"
          value={headerOpportunitySingleReviewRecord
            ? valueFor(headerOpportunitySingleReviewRecord, 'humanRating')
            : ''}
          aria-label={headerOpportunityReviewCount > 1
            ? 'Bulk rating'
            : 'Opportunity rating'}
        >
          <option value="">
            {headerOpportunitySingleReviewRecord ? 'No rating' : 'Keep rating'}
          </option>
          {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as rating}
            <option value={rating}>{rating}/10</option>
          {/each}
        </select>
      </label>
      <label class="bulk-notes">
        <span>Reason</span>
        <input
          type="text"
          name="humanReviewNotes"
          value={headerOpportunitySingleReviewRecord
            ? valueFor(headerOpportunitySingleReviewRecord, 'humanReviewNotes')
            : ''}
          placeholder={headerOpportunitySingleReviewRecord ? 'Add reason' : 'Keep notes'}
          aria-label={headerOpportunityReviewCount > 1
            ? 'Bulk review reason'
            : 'Opportunity review reason'}
        />
      </label>
      <div class="bulk-status-actions" aria-label="Bulk review status">
        {#each opportunityReviewStatuses as status}
          <button
            type={opportunityBulkIsMulti ? 'button' : 'submit'}
            name="humanReviewStatus"
            value={status.value}
            class={`bulk-status ${status.className}`}
            disabled={bulkBusy}
            class:active={headerOpportunitySingleReviewRecord
              ? valueFor(headerOpportunitySingleReviewRecord, 'humanReviewStatus') === status.value
              : false}
            onclick={opportunityBulkIsMulti
              ? (event: MouseEvent) => {
                  // A multi-row disposition goes through preview -> confirm ->
                  // apply, so the operator sees the resolved count before
                  // anything is written. The single-row form post stays as the
                  // no-JS path.
                  event.preventDefault();
                  const form = (event.currentTarget as HTMLButtonElement).form;
                  void previewOpportunityBulkAction(
                    OPPORTUNITY_BULK_WORKFLOW_IDS.review,
                    reviewPayloadFromForm(form, status.value),
                  );
                }
              : undefined}
          >
            {status.label}
          </button>
        {/each}
      </div>
      {#if opportunityBulkSelectionCount > 0}
        <button
          type="button"
          class="bulk-process"
          disabled={bulkBusy}
          title="Queue the intelligence pipeline for the selected opportunities"
          onclick={() =>
            void previewOpportunityBulkAction(
              OPPORTUNITY_BULK_WORKFLOW_IDS.processWithLlm,
            )}
        >
          <Sparkles size={14} strokeWidth={2.2} />
          <span>Process</span>
        </button>
      {/if}
    </form>
  {/if}
  {#if isOpportunityResource && (bulkPreview || bulkError)}
    <div class="bulk-confirm" role="status" aria-live="polite">
      {#if bulkPreview}
        <span class="bulk-confirm-summary">
          <strong>{bulkPreview.accepted}</strong>
          {bulkPreview.accepted === 1 ? 'opportunity' : 'opportunities'}
          will be {bulkPreview.actionId === OPPORTUNITY_BULK_WORKFLOW_IDS.review
            ? 'reviewed'
            : 'queued'}
          {#if bulkPreview.skipped > 0}
            <span class="bulk-confirm-skipped">
              · {bulkPreview.skipped} skipped
              {#if bulkPreview.reasons.length > 0}
                ({bulkPreview.reasons.join(', ')})
              {/if}
            </span>
          {/if}
        </span>
        <button
          type="button"
          class="bulk-confirm-apply"
          disabled={bulkBusy || bulkPreview.accepted === 0}
          onclick={() => void applyOpportunityBulkAction()}
        >
          Confirm
        </button>
        <button
          type="button"
          class="bulk-confirm-cancel"
          disabled={bulkBusy}
          onclick={() => {
            bulkPreview = null;
            bulkError = '';
          }}
        >
          Cancel
        </button>
      {:else}
        <span class="bulk-confirm-error">{bulkError}</span>
        <button
          type="button"
          class="bulk-confirm-cancel"
          onclick={() => {
            bulkError = '';
          }}
        >
          Dismiss
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

<section
  class="resource-page"
  class:opportunity-page={isOpportunityResource}
  class:task-page={isTaskResource}
  class:task-kanban-page={isTaskKanbanView}
>
  {#if !isOpportunityResource}
    <header class="page-header">
      <div>
        <h1>{data.resource.label}</h1>
        <p>{data.resource.description}</p>
      </div>
      {#if (data.resource.rowAction ?? 'edit') === 'edit'}
        <a class="new-record-link" href={`/admin/${data.resource.slug}/new`}>
          {isSourceResource ? 'Add a job source' : `New ${data.resource.singularLabel}`}
        </a>
      {/if}
    </header>
  {/if}

  {#if data.resource.slug === 'tasks'}
    <section class="task-workspace" aria-label="Application workflow task board">
      <div class="task-toolbar">
        <div class="task-filter-cluster">
          <div class="task-filter-group" aria-label="Task assignee filters">
            {#each [{ label: 'All', value: 'all' }, ...taskAssigneeRoleDefinitions] as owner}
              <a
                class:active={data.activeTaskOwnerFilter === owner.value}
                href={taskFilterHref({ owner: owner.value })}
              >
                {owner.label}
              </a>
            {/each}
          </div>
          <div class="task-filter-group" aria-label="Task status filters">
            {#each [{ label: 'All', value: 'all' }, ...taskStatusDefinitions] as status}
              <a
                class:active={data.activeTaskStatusFilter === status.value}
                href={taskFilterHref({ status: status.value })}
              >
                {status.label}
              </a>
            {/each}
          </div>
        </div>

        <div class="task-actions">
          <div class="task-view-toggle" role="group" aria-label="Task view">
            <button
              type="button"
              class:active={taskViewMode === 'kanban'}
              aria-pressed={taskViewMode === 'kanban'}
              title="Kanban board"
              onclick={() => setTaskViewMode('kanban')}
            >
              <Columns3 size={15} strokeWidth={2.2} />
              <span>Board</span>
            </button>
            <button
              type="button"
              class:active={taskViewMode === 'list'}
              aria-pressed={taskViewMode === 'list'}
              title="List"
              onclick={() => setTaskViewMode('list')}
            >
              <List size={15} strokeWidth={2.2} />
              <span>List</span>
            </button>
          </div>

          <form method="POST" action="?/syncRecommendationTasks">
            <button type="submit" class="sync-button">
              <RefreshCw size={14} strokeWidth={2.2} />
              <span>Sync recommendations</span>
            </button>
          </form>
        </div>

        {#if taskViewMode === 'list'}
          <label class="task-search">
            <Search size={15} strokeWidth={2.2} />
            <span class="sr-only">Filter tasks</span>
            <input
              type="search"
              placeholder="Filter tasks"
              bind:value={taskSearchQuery}
            />
          </label>
        {/if}
      </div>

      {#if data.error}
        <div class="resource-action-feedback error task-load-error" role="alert">
          <span>{data.error}</span>
          {#if onRetry}
            <button type="button" onclick={onRetry}>Try again</button>
          {/if}
        </div>
      {/if}

      {#if taskViewMode === 'kanban'}
        {#if data.error && data.records.length === 0}
          <!-- The authenticated list request failed; do not misrepresent its
               empty shell as a set of empty workflow lanes. -->
        {:else}
          <div class="kanban-board">
          {#each taskKanbanLaneDefinitions as lane}
            {@const laneTasks = taskRecordsByLane.get(lane.value) ?? []}
            {@const collapsed = taskLaneIsCollapsed(lane.value)}
            <section
              class="kanban-column"
              class:collapsed
              aria-label={lane.label}
            >
              <header>
                <button
                  class="kanban-column-toggle"
                  type="button"
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${lane.label}`}
                  onclick={() => toggleTaskLane(lane.value)}
                >
                  {#if collapsed}
                    <ChevronRight size={14} strokeWidth={2.3} />
                  {:else}
                    <ChevronDown size={14} strokeWidth={2.3} />
                  {/if}
                  <span class="kanban-column-title">{lane.label}</span>
                  <span class="kanban-column-count">{laneTasks.length}</span>
                </button>
              </header>
              {#if !collapsed}
                <div class="task-card-list">
                  {#each laneTasks as task (task.id)}
                    {@const subjectLinks = taskSubjectLinks(task)}
                    <article
                      class="task-card"
                      class:blocked={valueFor(task, 'status') === 'blocked'}
                      class:done={valueFor(task, 'status') === 'done'}
                      data-task-column={normalizedTaskKanbanColumn(task)}
                      data-task-status={valueFor(task, 'status') || 'open'}
                    >
                      <button type="button" onclick={() => openPrimaryTool(task)}>
                        <strong>{valueFor(task, 'title') || 'Untitled task'}</strong>
                        {#if taskMeta(task)}
                          <span>{taskMeta(task)}</span>
                        {/if}
                      </button>
                      {#if subjectLinks.length > 0}
                        <nav class="task-subject-links" aria-label="Task subjects">
                          {#each subjectLinks as link (link.href)}
                            <a
                              class:icon-link={link.variant === 'icon'}
                              class:text-link={link.variant === 'text'}
                              href={link.href}
                              aria-label={link.title}
                              title={link.title}
                            >
                              {#if link.icon === 'opportunity'}
                                <BriefcaseBusiness size={14} strokeWidth={2.2} aria-hidden="true" />
                              {:else if link.icon === 'application'}
                                <FileText size={14} strokeWidth={2.2} aria-hidden="true" />
                              {:else}
                                {link.label}
                              {/if}
                            </a>
                          {/each}
                        </nav>
                      {/if}
                      <div class="task-card-footer">
                        <span class="workflow-state-chip">{taskKanbanColumnLabel(task)}</span>
                        <span>{workflowLabel(valueFor(task, 'assigneeRole') || 'unassigned')}</span>
                        <span>{workflowLabel(valueFor(task, 'status') || 'open')}</span>
                      </div>
                      {#if valueFor(task, 'blockerReason')}
                        <p>{valueFor(task, 'blockerReason')}</p>
                      {/if}
                      {#if valueFor(task, 'dueAt')}
                        <time title={displayTitle(task, 'dueAt')}>Due {displayValue(task, 'dueAt')}</time>
                      {/if}
                    </article>
                  {:else}
                    <p class="kanban-empty" role={data.loading ? 'status' : undefined}>
                      {data.loading ? 'Loading tasks…' : 'No tasks'}
                    </p>
                  {/each}
                </div>
              {/if}
            </section>
          {/each}
          </div>
        {/if}
      {/if}
    </section>
  {/if}

  {#if data.resource.slug !== 'tasks' || taskViewMode === 'list'}
  <section
    class="records-section"
    class:opportunity-split-section={isOpportunityResource}
  >
    {#if isOpportunityResource}
      {#if resourceActionFeedbackMessage}
        <p class={`resource-action-feedback ${resourceActionFeedbackTone}`}>
          {resourceActionFeedbackMessage}
        </p>
      {/if}
      <OpportunityCardList
        records={data.records}
        candidateSkills={data.candidateSkills}
        selectedIds={selectedOpportunityIds}
        onSelectedIdsChange={setOpportunitySelection}
        {allMatchingSelected}
        canSelectAllMatching={canSelectAllMatchingOpportunities}
        onSelectAllMatching={selectAllMatchingOpportunities}
        onClearSelection={clearOpportunityBulkSelection}
        dockSelectedId={selectedRecordId}
        onSelectRecord={selectRecordForDock}
        toolbar={opportunityBulkToolbar}
        activeReviewFilter={data.activeReviewFilter}
        pagination={data.pagination}
        filterOptions={data.opportunityFilterOptions}
        reviewFilters={opportunityReviewFilters}
        reviewStatuses={opportunityReviewStatuses}
        loading={data.loading}
        refreshing={data.refreshing}
        stale={data.stale}
        error={data.error}
        {onRetry}
      />
    {:else if isApplicationResource}
      {#if resourceActionFeedbackMessage}
        <p class={`resource-action-feedback ${resourceActionFeedbackTone}`}>
          {resourceActionFeedbackMessage}
        </p>
      {/if}
      <ApplicationCardList
        records={data.records}
        loading={data.loading}
        refreshing={data.refreshing}
        stale={data.stale}
        error={data.error}
        {onRetry}
      />
    {:else if isSourceResource}
      <SourceControlList records={data.records} onRefresh={() => onRetry?.()} />
    {:else}
    <div class="section-heading">
      <div class="section-title-stack">
        <h2>{data.loading ? 'Loading records…' : `${displayRecords.length} records`}</h2>
      </div>
    </div>

    {#if !isTaskResource && data.error && displayRecords.length > 0}
      <div class="resource-action-feedback error" role="alert">
        <span>{data.error}</span>
        {#if onRetry}
          <button type="button" onclick={onRetry}>Try again</button>
        {/if}
      </div>
    {:else if !isTaskResource && (data.refreshing || data.stale)}
      <p class="resource-action-feedback" role="status">
        Refreshing {data.resource.label.toLowerCase()}…
      </p>
    {/if}

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            {#each data.resource.tableColumns as column}
              <th>{columnLabel(column)}</th>
            {/each}
            <th class="tools-heading" aria-label="Tools"></th>
          </tr>
        </thead>
        <tbody>
          {#each displayRecords as record (record.id)}
            <tr
              class:selected={record.id === selectedRecordId}
              class:row-opens-view={rowIsInteractive}
              onclick={(event) => openRow(record, event)}
              onkeydown={(event) => handleRowKeydown(event, record)}
              role={rowIsInteractive ? 'button' : undefined}
              tabindex={rowIsInteractive ? 0 : undefined}
              aria-label={rowIsInteractive
                ? `Open ${record.id ?? data.resource.singularLabel}`
                : undefined}
            >
              {#each data.resource.tableColumns as column}
                <td class:date-cell={isDateColumn(column)} title={displayTitle(record, column)}>
                  <AdminRecordValue
                    compact
                    field={fieldFor(column)}
                    {record}
                    referenceOptions={data.referenceOptions}
                  />
                </td>
              {/each}
              <td class="tools-cell">
                <a
                  class="row-action"
                  href={recordHref(record)}
                  onclick={(event) => event.stopPropagation()}
                  onkeydown={(event) => event.stopPropagation()}
                  aria-label={`View ${record.id ?? data.resource.singularLabel}`}
                >
                  View
                </a>
                <a
                  class="row-action"
                  href={editHref(record)}
                  onclick={(event) => event.stopPropagation()}
                  onkeydown={(event) => event.stopPropagation()}
                  aria-label={`Edit ${record.id ?? data.resource.singularLabel}`}
                >
                  <Pencil size={15} strokeWidth={2.2} />
                </a>
                {#if isSkillResource}
                  {@const skillIsOnResume = skillResumeToggleValue(record)}
                  <form
                    method="POST"
                    action="?/update"
                    class="resume-skill-toggle-form"
                    use:enhance={enhanceSkillResumeToggle}
                  >
                    <input type="hidden" name="id" value={record.id ?? ''} />
                    {#each data.resource.fields as field}
                      {#if field.key !== 'useOnResume'}
                        <input type="hidden" name={field.key} value={valueFor(record, field.key)} />
                      {/if}
                    {/each}
                    <button
                      type="submit"
                      class="row-action resume-skill-toggle-button"
                      class:active={skillIsOnResume}
                      name={skillIsOnResume ? undefined : 'useOnResume'}
                      value="on"
                      aria-label={skillIsOnResume ? 'Hide from resume' : 'Show on resume'}
                      aria-pressed={skillIsOnResume}
                      title={skillIsOnResume ? 'On resume' : 'Hidden from resume'}
                    >
                      {#if skillIsOnResume}
                        <Eye size={15} strokeWidth={2.2} />
                      {:else}
                        <EyeOff size={15} strokeWidth={2.2} />
                      {/if}
                    </button>
                  </form>
                {/if}
              </td>
            </tr>
          {:else}
            <tr>
              <td
                colspan={data.resource.tableColumns.length + 1}
                class="empty"
              >
                {#if data.loading}
                  <span role="status">Loading {data.resource.label.toLowerCase()}…</span>
                {:else if data.error}
                  <span role="alert">{data.error}</span>
                  {#if onRetry}
                    <button type="button" onclick={onRetry}>Try again</button>
                  {/if}
                {:else if isTaskResource && taskSearchQuery.trim()}
                  No tasks match these filters.
                {:else}
                  No {data.resource.label.toLowerCase()} yet.
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {/if}
  </section>
  {/if}
</section>

<style>
  .resource-page {
    display: grid;
    gap: 22px;
  }

  :global(.smrt-admin-shell__main:has(.task-kanban-page)) {
    min-height: 0;
    overflow: hidden !important;
  }

  :global(.admin-content:has(.task-kanban-page)) {
    grid-template-rows: minmax(0, 1fr);
    align-content: stretch;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  :global(.admin-content:has(.task-kanban-page) .smrt-breadcrumbs) {
    display: none;
  }

  .task-page {
    gap: 14px;
  }

  .opportunity-page {
    gap: 0;
  }

  .task-kanban-page {
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .page-header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
  }

  .page-header p {
    margin: 5px 0 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .new-record-link {
    display: inline-flex;
    min-height: 36px;
    flex: 0 0 auto;
    align-items: center;
    padding: 0 12px;
    border: 1px solid var(--smrt-color-on-surface);
    border-radius: 6px;
    background: var(--smrt-color-on-surface);
    color: var(--smrt-color-surface);
    font-size: 13px;
    font-weight: 800;
    text-decoration: none;
  }

  .new-record-link:hover,
  .new-record-link:focus-visible {
    background: var(--smrt-color-on-surface);
  }

  .task-workspace {
    display: grid;
    gap: 14px;
    min-height: 0;
  }

  .task-kanban-page .task-workspace {
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }

  .task-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .task-filter-cluster,
  .task-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .task-filter-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .task-filter-group a,
  .task-view-toggle button,
  .sync-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 9px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font-size: 12px;
    font-weight: 800;
    text-decoration: none;
  }

  .task-view-toggle {
    display: inline-flex;
    overflow: hidden;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
  }

  .task-view-toggle button {
    min-height: 28px;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
  }

  .task-view-toggle button + button {
    border-left: 1px solid var(--smrt-color-outline-variant);
  }

  .task-filter-group a.active,
  .task-view-toggle button.active,
  .task-view-toggle button:hover,
  .task-view-toggle button:focus-visible,
  .sync-button:hover,
  .sync-button:focus-visible {
    border-color: var(--smrt-color-on-surface);
    background: var(--smrt-color-on-surface);
    color: var(--smrt-color-surface);
  }

  .sync-button {
    cursor: pointer;
  }

  .task-search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 320px;
    max-width: 440px;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface-variant);
  }

  .task-search input {
    min-width: 0;
    flex: 1 1 auto;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: 13px;
  }

  .task-search:focus-within {
    border-color: var(--smrt-color-on-surface);
    box-shadow: 0 0 0 1px var(--smrt-color-on-surface);
  }

  .kanban-board {
    display: flex;
    gap: 10px;
    height: 100%;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 2px;
    overscroll-behavior-x: contain;
  }

  .kanban-column {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 10px;
    flex: 1 0 268px;
    min-width: 268px;
    min-height: 0;
    padding: 8px;
    background: var(--smrt-color-surface-container);
  }

  .kanban-column.collapsed {
    flex: 0 0 46px;
    min-width: 46px;
    padding: 6px;
  }

  .kanban-column header {
    min-width: 0;
  }

  .kanban-column-toggle {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 32px;
    padding: 0 2px;
    border: 0;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    text-align: left;
    cursor: pointer;
  }

  .kanban-column-toggle:focus-visible {
    outline: 2px solid var(--smrt-color-on-surface);
    outline-offset: 2px;
  }

  .kanban-column-title {
    overflow: hidden;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    font-weight: 800;
    line-height: 1.2;
    text-overflow: ellipsis;
  }

  .kanban-column-count {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
  }

  .kanban-column.collapsed .kanban-column-toggle {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr) auto;
    justify-items: center;
    align-items: center;
    height: 100%;
    min-height: 0;
    padding: 4px 0;
    text-align: center;
  }

  .kanban-column.collapsed .kanban-column-title {
    writing-mode: vertical-rl;
    max-height: 100%;
    white-space: nowrap;
  }

  .task-card-list {
    display: grid;
    align-content: start;
    gap: 8px;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 2px;
  }

  .task-card {
    --task-accent: var(--smrt-color-primary);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);

    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-left: 4px solid var(--task-accent);
    border-radius: 6px;
    background: linear-gradient(
      90deg,
      var(--task-card-bg),
      var(--smrt-color-surface) 54px
    );
  }

  .task-card[data-task-column='inbox'] {
    --task-accent: var(--smrt-color-outline);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);
  }

  .task-card[data-task-column='recommended'] {
    --task-accent: var(--smrt-color-primary);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);
  }

  .task-card[data-task-column='needs_user_decision'] {
    --task-accent: var(--smrt-color-warning);
    --task-card-bg: var(--smrt-color-warning-container);
    --task-chip-bg: var(--smrt-color-warning-container);
    --task-chip-fg: var(--smrt-color-on-warning-container);
  }

  .task-card[data-task-column='accepted_apply'] {
    --task-accent: var(--smrt-color-success);
    --task-card-bg: var(--smrt-color-success-container);
    --task-chip-bg: var(--smrt-color-success-container);
    --task-chip-fg: var(--smrt-color-on-success-container);
  }

  .task-card[data-task-column='researching'] {
    --task-accent: var(--smrt-color-primary);
    --task-card-bg: var(--smrt-color-primary-container);
    --task-chip-bg: var(--smrt-color-primary-container);
    --task-chip-fg: var(--smrt-color-primary);
  }

  .task-card[data-task-column='materials_drafting'] {
    --task-accent: var(--smrt-color-primary);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);
  }

  .task-card[data-task-column='needs_account_credentials'] {
    --task-accent: var(--smrt-color-warning);
    --task-card-bg: var(--smrt-color-warning-container);
    --task-chip-bg: var(--smrt-color-warning-container);
    --task-chip-fg: var(--smrt-color-on-warning-container);
  }

  .task-card[data-task-column='ready_for_user_review'] {
    --task-accent: var(--smrt-color-error);
    --task-card-bg: var(--smrt-color-error-container);
    --task-chip-bg: var(--smrt-color-error-container);
    --task-chip-fg: var(--smrt-color-on-error-container);
  }

  .task-card[data-task-column='approved_to_submit'] {
    --task-accent: var(--smrt-color-success);
    --task-card-bg: var(--smrt-color-success-container);
    --task-chip-bg: var(--smrt-color-success-container);
    --task-chip-fg: var(--smrt-color-on-success-container);
  }

  .task-card[data-task-column='submitting'] {
    --task-accent: var(--smrt-color-primary);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);
  }

  .task-card[data-task-column='submitted'] {
    --task-accent: var(--smrt-color-primary);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);
  }

  .task-card[data-task-column='follow_up'] {
    --task-accent: var(--smrt-color-primary);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);
  }

  .task-card[data-task-column='interviewing'] {
    --task-accent: var(--smrt-color-primary);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);
  }

  .task-card[data-task-column='offer_negotiation'] {
    --task-accent: var(--smrt-color-warning);
    --task-card-bg: var(--smrt-color-warning-container);
    --task-chip-bg: var(--smrt-color-warning-container);
    --task-chip-fg: var(--smrt-color-on-warning-container);
  }

  .task-card[data-task-column='rejected_archived'] {
    --task-accent: var(--smrt-color-outline);
    --task-card-bg: var(--smrt-color-surface-container);
    --task-chip-bg: var(--smrt-color-surface-container);
    --task-chip-fg: var(--smrt-color-on-surface-variant);
  }

  .task-card[data-task-column='blocked'] {
    --task-accent: var(--smrt-color-error);
    --task-card-bg: var(--smrt-color-error-container);
    --task-chip-bg: var(--smrt-color-error-container);
    --task-chip-fg: var(--smrt-color-on-error-container);
  }

  .task-card[data-task-status='in_progress'] {
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.09);
  }

  .task-card.blocked {
    border-color: var(--smrt-color-warning);
    border-left-color: var(--task-accent);
    background: linear-gradient(
      90deg,
      var(--task-card-bg),
      var(--smrt-color-surface) 54px
    );
  }

  .task-card.done,
  .task-card[data-task-status='canceled'] {
    opacity: 0.68;
  }

  .task-card button {
    display: grid;
    gap: 4px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .task-card button:focus-visible {
    outline: 2px solid var(--smrt-color-on-surface);
    outline-offset: 3px;
  }

  .task-card strong {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-small-font);
    line-height: 1.25;
  }

  .task-subject-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }

  .task-subject-links a {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    color: var(--smrt-color-primary);
    font-size: 11px;
    font-weight: 800;
    line-height: 1.2;
    text-decoration: none;
  }

  .task-subject-links a.text-link {
    padding: 0;
  }

  .task-subject-links a.icon-link {
    justify-content: center;
    width: 20px;
    color: var(--smrt-color-on-surface);
  }

  .task-subject-links a:hover,
  .task-subject-links a:focus-visible {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  .task-subject-links a.icon-link:hover,
  .task-subject-links a.icon-link:focus-visible {
    color: var(--smrt-color-primary);
    text-decoration: none;
  }

  .task-subject-links a:focus-visible {
    outline: 2px solid var(--smrt-color-on-surface);
    outline-offset: 2px;
  }

  .task-card button span,
  .task-card p,
  .task-card time,
  .kanban-empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    line-height: 1.35;
  }

  .task-card-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .task-card-footer span {
    display: inline-flex;
    min-height: 22px;
    align-items: center;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    font-size: 11px;
    font-weight: 800;
  }

  .task-card-footer .workflow-state-chip {
    background: var(--task-chip-bg);
    color: var(--task-chip-fg);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  h1,
  h2 {
    margin: 0;
    color: var(--smrt-color-on-surface);
  }

  h1 {
    font: var(--smrt-typography-headline-medium-font);
    line-height: 1.15;
  }

  h2 {
    font: var(--smrt-typography-headline-small-font);
  }

  .records-section {
    display: grid;
    gap: 12px;
  }

  .opportunity-split-section {
    gap: 0;
  }

  .section-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .section-title-stack {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .resource-action-feedback {
    margin: 0;
    padding: 9px 12px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.4;
  }

  .resource-action-feedback.processed {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .resource-action-feedback.error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .sweep-form {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .sweep-form button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid var(--admin-border, #d4d4d8);
    border-radius: 0.4rem;
    background: transparent;
    padding: 0.32rem 0.6rem;
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .sweep-form .sweep-apply {
    border-color: #b45309;
    color: #b45309;
    font-weight: 600;
  }

  .bulk-review-form {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    align-items: end;
    justify-content: flex-end;
    gap: 8px;
    min-width: min(100%, 640px);
  }

  .bulk-review-form label {
    display: grid;
    gap: 4px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .bulk-review-form select,
  .bulk-review-form input {
    height: 30px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: 12px;
    text-transform: none;
  }

  .bulk-review-form select {
    min-width: 112px;
    padding: 0 8px;
  }

  .bulk-review-form input {
    width: min(220px, 28vw);
    min-width: 150px;
    padding: 0 9px;
  }

  .bulk-status-actions {
    display: inline-flex;
    overflow: hidden;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
  }

  .bulk-status,
  .bulk-process {
    min-height: 30px;
    border: 0;
    background: transparent;
    color: var(--smrt-color-on-surface);
    font-size: 12px;
    font-weight: 900;
    cursor: pointer;
  }

  .bulk-status {
    padding: 0 10px;
  }

  .bulk-process {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    color: var(--smrt-color-primary);
  }

  .bulk-status + .bulk-status {
    border-left: 1px solid var(--smrt-color-outline-variant);
  }

  .bulk-status.accept {
    color: var(--smrt-color-on-success-container);
  }

  .bulk-status.maybe {
    color: var(--smrt-color-on-warning-container);
  }

  .bulk-status.reject {
    color: var(--smrt-color-on-error-container);
  }

  .bulk-status.active.accept {
    background: var(--smrt-color-success);
    color: var(--smrt-color-on-success);
  }

  .bulk-status.active.maybe {
    background: var(--smrt-color-warning);
    color: var(--smrt-color-on-warning);
  }

  .bulk-status.active.reject {
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
  }

  .bulk-status:hover,
  .bulk-status:focus-visible,
  .bulk-process:hover,
  .bulk-process:focus-visible {
    background: var(--smrt-color-surface-container);
  }

  .bulk-status:disabled,
  .bulk-process:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  /* Confirmation strip: what the preview resolved, before anything is written. */
  .bulk-confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
    font-size: 12px;
  }

  .bulk-confirm-summary strong {
    font-weight: 800;
  }

  .bulk-confirm-skipped {
    color: var(--smrt-color-on-surface-variant);
  }

  .bulk-confirm-error {
    color: var(--smrt-color-error);
  }

  .bulk-confirm-apply,
  .bulk-confirm-cancel {
    padding: 3px 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    background: var(--smrt-color-surface);
    color: inherit;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .bulk-confirm-apply {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .bulk-confirm-apply:disabled,
  .bulk-confirm-cancel:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .bulk-confirm-apply:hover:not(:disabled),
  .bulk-confirm-cancel:hover:not(:disabled) {
    background: var(--smrt-color-surface-container);
  }

  .row-action {
    display: inline-flex;
    min-width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 800;
    font-family: inherit;
    text-decoration: none;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .row-action:hover,
  .row-action:focus-visible {
    color: var(--smrt-color-on-surface);
  }

  .row-action:focus-visible {
    outline: 2px solid var(--smrt-color-on-surface);
    outline-offset: 2px;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
  }

  .opportunity-split-section .table-wrap {
    min-height: 0;
    overflow: auto;
    border: 0;
  }

  table {
    width: 100%;
    min-width: 860px;
    border-collapse: collapse;
  }

  th,
  td {
    max-width: 260px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    text-align: left;
    vertical-align: top;
  }

  th {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    text-transform: uppercase;
  }

  .opportunity-split-section thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--smrt-color-surface-container);
    box-shadow: inset 0 -1px 0 var(--smrt-color-outline-variant);
  }

  tr.selected td {
    background: var(--smrt-color-warning-container);
  }

  tbody tr.row-opens-view {
    cursor: pointer;
  }

  tbody tr.row-opens-view:hover td,
  tbody tr.row-opens-view:focus-visible td {
    background: var(--smrt-color-surface-container);
  }

  tbody tr.row-opens-view:focus-visible {
    outline: 2px solid var(--smrt-color-on-surface);
    outline-offset: -2px;
  }

  tbody tr.row-opens-view.selected:hover td,
  tbody tr.row-opens-view.selected:focus-visible td {
    background: var(--smrt-color-warning-container);
  }

  .resume-skill-toggle-form {
    display: inline-flex;
    margin: 0;
    vertical-align: middle;
  }

  .resume-skill-toggle-button.active {
    color: var(--smrt-color-primary);
  }

  .date-cell {
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    white-space: nowrap;
  }

  .tools-heading,
  .tools-cell {
    width: 1%;
    min-width: 40px;
    text-align: center;
    white-space: nowrap;
  }

  .empty {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
