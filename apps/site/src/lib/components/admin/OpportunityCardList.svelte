<script lang="ts">
import {
  DataTable,
  type DataTableColumn,
  type SortState,
} from '@happyvertical/smrt-ui/data';
import Building2 from '@lucide/svelte/icons/building-2';
import ExternalLink from '@lucide/svelte/icons/external-link';
import Heart from '@lucide/svelte/icons/heart';
import Layers from '@lucide/svelte/icons/layers';
import MapPin from '@lucide/svelte/icons/map-pin';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Star from '@lucide/svelte/icons/star';
import X from '@lucide/svelte/icons/x';
import { onMount, type Snippet, untrack } from 'svelte';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import type { AdminRecord } from '$lib/admin/dock';
import { OPPORTUNITY_LIST_REFRESH_STORAGE_KEY } from '$lib/admin/opportunity-list-refresh';
import type { AdminListPagination } from '$lib/admin/pagination';
import {
  isTriageDeepLink,
  TRIAGE_SORT_URL_PARAM,
  TRIAGE_URL_PARAM,
  triageCloseHref,
} from '$lib/admin/triage-session';
import {
  countActiveFilters,
  DEFAULT_OPPORTUNITY_FILTERS,
  filterStateFromSearchParams,
  normalizeFilterState,
  getNumber as num,
  type OpportunityFilterOptions,
  type OpportunityFilterState,
  type OpportunitySort,
  parseSkillList,
  getString as str,
  writeFilterStateSearchParams,
} from '$lib/opportunity-filters';
import {
  filtersForOpportunityTableSort,
  opportunityTableSort,
} from '$lib/opportunity-table-sorting';
import { createCandidateSkillMatcher } from '$lib/skill-matching';
import { ADMIN_RESOURCE_REFRESH_EVENT } from './admin-resource-hydration';
import OpportunityTriageModal from './OpportunityTriageModal.svelte';
import OpportunityWorkflowForms from './OpportunityWorkflowForms.svelte';

type WorkflowOption = { label: string; value: string };
type SignalFilterKey =
  | 'freshOnly'
  | 'founderOnly'
  | 'greenfieldOnly'
  | 'relocationOnly'
  | 'visaOnly';

let {
  records,
  candidateSkills,
  activeReviewFilter,
  pagination,
  filterOptions,
  reviewFilters,
  reviewStatuses,
  reviewedByProfileId = '',
  selectedIds = new Set<string>(),
  onSelectedIdsChange,
  allMatchingSelected = false,
  canSelectAllMatching = false,
  onSelectAllMatching,
  onClearSelection,
  dockSelectedId = null,
  onSelectRecord,
  toolbar,
  loading = false,
  refreshing = false,
  stale = false,
  error = null,
  onRetry,
} = $props<{
  records: AdminRecord[];
  candidateSkills: string[];
  activeReviewFilter: string;
  pagination: AdminListPagination;
  filterOptions: OpportunityFilterOptions;
  reviewFilters: readonly WorkflowOption[];
  reviewStatuses: readonly {
    className: string;
    label: string;
    value: string;
  }[];
  reviewedByProfileId?: string;
  /** Bulk (checkbox) selection, owned by the parent. */
  selectedIds?: Set<string>;
  onSelectedIdsChange?: (ids: Set<string>) => void;
  /**
   * The selection has been escalated to every row matching the current
   * filters. The ids are not held here -- the server re-resolves them -- so
   * the count comes from the pagination total rather than the checkbox set.
   */
  allMatchingSelected?: boolean;
  canSelectAllMatching?: boolean;
  onSelectAllMatching?: () => void;
  onClearSelection?: () => void;
  /** Record currently selected for the admin dock (single-select). */
  dockSelectedId?: string | null;
  onSelectRecord?: (record: AdminRecord) => void;
  /** Rendered by DataTable directly above the rows (e.g. bulk review form). */
  toolbar?: Snippet;
  loading?: boolean;
  refreshing?: boolean;
  stale?: boolean;
  error?: string | Error | null;
  onRetry?: () => void;
}>();

const POSTED_PRESETS = [7, 14, 30, 90];
const REVIEW_STORAGE_KEY = 'iolaus.admin.opportunities.review';
const SORT_STORAGE_KEY = 'iolaus.admin.opportunities.sort';
const OPPORTUNITY_SORT_VALUES: readonly OpportunitySort[] = [
  'best',
  'newest',
  'score',
  'salary',
  'rating',
];

const tableColumns: DataTableColumn<AdminRecord>[] = [
  {
    id: 'opportunity',
    label: 'Opportunity',
    accessor: 'title',
    minWidth: '18rem',
    responsive: { keepVisible: true },
  },
  {
    id: 'company',
    label: 'Company',
    minWidth: '11rem',
    responsive: { priority: 3 },
  },
  {
    id: 'location',
    label: 'Location',
    minWidth: '11rem',
    responsive: { priority: 2 },
  },
  {
    id: 'score',
    label: 'AI score',
    align: 'right',
    minWidth: '6rem',
    sortable: true,
  },
  { id: 'status', label: 'Status', minWidth: '7rem' },
  {
    id: 'compensation',
    label: 'Compensation',
    minWidth: '8rem',
    sortable: true,
  },
];

const tableModes = {
  filtering: 'manual',
  pagination: 'manual',
  sorting: 'manual',
} as const;

let expanded = $state<Set<string | number>>(new Set());
let drawerOpen = $state(page.url.searchParams.has('facets'));
let skillQuery = $state('');
let skillSearchActive = $state(false);
let filters = $state<OpportunityFilterState>(
  filterStateFromSearchParams(page.url.searchParams),
);
let lastUrlSearch = $state(page.url.search);
let preferencesReady = $state(false);
let lastRefreshAt = 0;

const candidateSkillMatcher = $derived(
  createCandidateSkillMatcher(candidateSkills ?? []),
);

$effect(() => {
  if (page.url.search === lastUrlSearch) return;
  lastUrlSearch = page.url.search;
  filters = filterStateFromSearchParams(page.url.searchParams);
  drawerOpen = page.url.searchParams.has('facets');
});

$effect(() => {
  if (!preferencesReady) return;
  rememberReviewFilter(activeReviewFilter);
  rememberSort(filters.sort);
});

onMount(() => {
  const cleanupRefreshListeners = installOpportunityListRefreshListeners();
  const url = new URL(page.url);
  let changed = removeActionSearchParams(url.searchParams);
  const hasReviewParam = url.searchParams.has('review');
  const hasSortParam = url.searchParams.has('sort');

  if (hasReviewParam) {
    rememberReviewFilter(activeReviewFilter);
  } else {
    const storedReview = readReviewPreference();
    if (storedReview && storedReview !== activeReviewFilter) {
      writeReviewSearchParam(url.searchParams, storedReview);
      changed = true;
    }
  }

  if (hasSortParam) {
    rememberSort(filters.sort);
  } else {
    const storedSort = readSortPreference();
    if (storedSort && storedSort !== filters.sort) {
      const nextFilters = { ...filters, sort: storedSort };
      writeFilterStateSearchParams(url.searchParams, nextFilters);
      changed = true;
    }
  }

  if (changed) {
    // A page in the URL is an explicit deep link. Adding an otherwise absent
    // local preference must not silently move that link back to page one.
    // Filter interactions still clear pagination through their own handlers.
    // Likewise keep `selected` so a deep-linked dock selection survives the
    // preference sync.
    const href = `${url.pathname}${url.search}${url.hash}`;
    void goto(href, { keepFocus: true, noScroll: true }).finally(() => {
      preferencesReady = true;
    });
    return cleanupRefreshListeners;
  }

  preferencesReady = true;
  return cleanupRefreshListeners;
});

function installOpportunityListRefreshListeners(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const refresh = () => {
    const now = Date.now();
    if (now - lastRefreshAt < 500) return;
    lastRefreshAt = now;
    window.dispatchEvent(new Event(ADMIN_RESOURCE_REFRESH_EVENT));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === OPPORTUNITY_LIST_REFRESH_STORAGE_KEY) refresh();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') refresh();
  };

  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

function hrefWithFilters(nextFilters: OpportunityFilterState): string {
  const url = new URL(page.url);
  removeActionSearchParams(url.searchParams);
  writeFilterStateSearchParams(url.searchParams, nextFilters);
  url.searchParams.delete('page');
  url.searchParams.delete('selected');
  return `${url.pathname}${url.search}${url.hash}`;
}

function setFilters(nextFilters: OpportunityFilterState): void {
  const normalized = normalizeFilterState(nextFilters);
  rememberSort(normalized.sort);
  filters = normalized;
  const href = hrefWithFilters(normalized);
  const currentHref = `${page.url.pathname}${page.url.search}${page.url.hash}`;
  if (href !== currentHref) {
    void goto(href, { keepFocus: true, noScroll: true });
  }
}

function commitFilters(): void {
  setFilters(filters);
}

function commitSort(): void {
  setFilters({ ...filters, sortDirection: 'desc' });
}

function setTableSort(nextSort: SortState): void {
  setFilters(filtersForOpportunityTableSort(filters, nextSort));
}

function closeDrawer(): void {
  drawerOpen = false;
  skillSearchActive = false;
  skillQuery = '';
  const url = new URL(page.url);
  if (!url.searchParams.has('facets')) return;
  url.searchParams.delete('facets');
  void goto(`${url.pathname}${url.search}${url.hash}`, {
    keepFocus: true,
    noScroll: true,
  });
}

function openDrawer(): void {
  if (page.url.searchParams.has('facets')) {
    drawerOpen = true;
    return;
  }
  const url = new URL(page.url);
  url.searchParams.set('facets', '');
  void goto(`${url.pathname}${url.search}${url.hash}`, {
    keepFocus: true,
    noScroll: true,
  });
}

function setReviewFilter(event: Event): void {
  const value = (event.currentTarget as HTMLSelectElement).value;
  rememberReviewFilter(value || 'unsorted');
  const url = new URL(page.url);
  removeActionSearchParams(url.searchParams);
  writeReviewSearchParam(url.searchParams, value);
  url.searchParams.delete('page');
  url.searchParams.delete('selected');
  void goto(`${url.pathname}${url.search}${url.hash}`, {
    keepFocus: true,
    noScroll: true,
  });
}

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readPreference(key: string): string | null {
  const storage = browserLocalStorage();
  if (!storage) return null;

  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  const storage = browserLocalStorage();
  if (!storage) return;

  try {
    storage.setItem(key, value);
  } catch {
    // Keep the list usable if persistence is unavailable.
  }
}

function removePreference(key: string): void {
  const storage = browserLocalStorage();
  if (!storage) return;

  try {
    storage.removeItem(key);
  } catch {
    // Ignore stale preference cleanup failures.
  }
}

function isKnownReviewFilter(value: string): boolean {
  return reviewFilters.some((filter: WorkflowOption) => filter.value === value);
}

function isOpportunitySort(value: string): value is OpportunitySort {
  return OPPORTUNITY_SORT_VALUES.includes(value as OpportunitySort);
}

function readReviewPreference(): string | null {
  const stored = readPreference(REVIEW_STORAGE_KEY);
  if (!stored) return null;
  if (isKnownReviewFilter(stored)) return stored;
  removePreference(REVIEW_STORAGE_KEY);
  return null;
}

function readSortPreference(): OpportunitySort | null {
  const stored = readPreference(SORT_STORAGE_KEY);
  if (!stored) return null;
  if (isOpportunitySort(stored)) return stored;
  removePreference(SORT_STORAGE_KEY);
  return null;
}

function rememberReviewFilter(value: string): void {
  if (!isKnownReviewFilter(value)) return;
  writePreference(REVIEW_STORAGE_KEY, value);
}

function rememberSort(value: OpportunitySort): void {
  writePreference(SORT_STORAGE_KEY, value);
}

function writeReviewSearchParam(params: URLSearchParams, value: string): void {
  if (!value || value === 'unsorted') {
    params.delete('review');
  } else {
    params.set('review', value);
  }
}

function removeActionSearchParams(params: URLSearchParams): boolean {
  let removed = false;
  for (const key of Array.from(params.keys())) {
    if (key.startsWith('/')) {
      params.delete(key);
      removed = true;
    }
  }
  return removed;
}

function pageActionHref(actionName: string): string {
  const url = new URL(page.url);
  removeActionSearchParams(url.searchParams);
  url.searchParams.set(`/${actionName}`, '');
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Triage runs the same filter model under its own preset, over this list's
 * *current* filters: the list is the context and owns the filter, and the deck
 * is a modal popped over it. `page`, `offset`, and any pending form action are
 * list-only state, so they never reach the queue read.
 */
const triageSearch = $derived.by(() => {
  const url = new URL(page.url);
  removeActionSearchParams(url.searchParams);
  url.searchParams.delete('page');
  url.searchParams.delete('offset');
  url.searchParams.delete(TRIAGE_URL_PARAM);
  url.searchParams.delete(TRIAGE_SORT_URL_PARAM);
  writeFilterStateSearchParams(url.searchParams, filters);
  return url.searchParams.toString();
});

/**
 * `?triage=1` is the deep link: it opens the list with the deck already up, so
 * a bookmark (and the redirect from the retired standalone route) still lands
 * where it used to. The parameter is only read when the list mounts — the
 * toolbar button opens the deck without touching the URL, because the route
 * keys its page on `url.search` and a rewrite mid-session would remount the
 * deck out from under the operator.
 */
let triageOpen = $state(untrack(() => isTriageDeepLink(page.url.searchParams)));
/** Ordering named by the deep link, if it named one. */
const triageInitialSort = untrack(() =>
  page.url.searchParams.get(TRIAGE_SORT_URL_PARAM),
);

function openTriage(): void {
  triageOpen = true;
}

/**
 * Closing is the session boundary: the list refreshes so decided rows drop
 * out. When the deck was deep-linked, dropping `?triage=1` re-runs the route,
 * which is the same refresh by another name.
 */
function closeTriage(): void {
  triageOpen = false;
  const href = triageCloseHref(new URL(page.url));
  if (href !== null) {
    void goto(href, {
      invalidateAll: true,
      keepFocus: true,
      noScroll: true,
      replaceState: true,
    });
    return;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ADMIN_RESOURCE_REFRESH_EVENT));
  }
}

/**
 * The shortlist is where a triage "dig deeper" lands: the same list, filtered
 * to the `maybe` pile and sorted by score, which is where an application is
 * actually started. The operator's other filters ride along, exactly as they do
 * into triage, so the two links describe the same working set from both ends.
 */
const shortlistHref = $derived.by(() => {
  const url = new URL(page.url);
  removeActionSearchParams(url.searchParams);
  url.searchParams.delete('page');
  url.searchParams.delete('offset');
  writeFilterStateSearchParams(url.searchParams, {
    ...filters,
    sort: 'score',
    sortDirection: 'desc',
  });
  url.searchParams.set('review', 'maybe');
  return `/admin/opportunities${url.search}`;
});

function clearFilters(): void {
  setFilters({ ...DEFAULT_OPPORTUNITY_FILTERS, sort: filters.sort });
  skillQuery = '';
}

function toggleSkill(skill: string): void {
  const key = skill.toLowerCase();
  if (filters.skills.some((s) => s.toLowerCase() === key)) {
    setFilters({
      ...filters,
      skills: filters.skills.filter((s) => s.toLowerCase() !== key),
    });
  } else {
    setFilters({ ...filters, skills: [...filters.skills, skill] });
  }
}

function toggleArrayValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function toggleEmploymentType(value: string): void {
  setFilters({
    ...filters,
    employmentTypes: toggleArrayValue(filters.employmentTypes, value),
  });
}

function toggleWorkMode(value: string): void {
  setFilters({
    ...filters,
    workModes: toggleArrayValue(filters.workModes, value),
  });
}

function setFreshnessFilter(value: string): void {
  const isActive =
    filters.freshness === value || (value === 'fresh' && filters.freshOnly);
  setFilters({
    ...filters,
    freshOnly: false,
    freshness: isActive ? 'all' : value,
  });
}

function toggleSignalFilter(key: SignalFilterKey): void {
  setFilters({ ...filters, [key]: !filters[key] });
}

function skillSelected(skill: string): boolean {
  const key = skill.toLowerCase();
  return filters.skills.some((s) => s.toLowerCase() === key);
}

function handleSkillSearchFocusOut(event: FocusEvent): void {
  const current = event.currentTarget as HTMLElement;
  const next = event.relatedTarget;
  if (next instanceof Node && current.contains(next)) return;
  skillSearchActive = false;
}

function humanize(value: string, fallback = ''): string {
  const text = value.trim();
  if (!text) return fallback;
  return text.replaceAll('_', ' ');
}

function companyLabel(record: AdminRecord): string {
  return str(record, 'companyName') || 'Unknown company';
}

function locationLabel(record: AdminRecord): string {
  const text = (
    str(record, 'locations') || str(record, 'locationNotes')
  ).trim();
  return text ? text.split(/\r?\n/)[0] : 'Location unknown';
}

function formatThousands(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

function salaryLabel(record: AdminRecord): string {
  const currency = str(record, 'currency');
  const min = num(record, 'salaryMin');
  const max = num(record, 'salaryMax');
  if (min !== null || max !== null) {
    const range = [min, max]
      .filter((v): v is number => v !== null)
      .map(formatThousands)
      .join('–');
    return [currency, range].filter(Boolean).join(' ');
  }
  const hmin = num(record, 'hourlyMin');
  const hmax = num(record, 'hourlyMax');
  if (hmin !== null || hmax !== null) {
    const range = [hmin, hmax].filter((v): v is number => v !== null).join('–');
    return `${[currency, range].filter(Boolean).join(' ')}/hr`;
  }
  return '';
}

// Score only — the recommendation is still conveyed by the badge's tone color
// (toneFor(latestRecommendation) on the badge) and by the status badge.
function scoreLabel(record: AdminRecord): string {
  const score = num(record, 'latestScore');
  return score === null ? 'Unscored' : `${score}/100`;
}

function boolField(record: AdminRecord, key: string): boolean {
  const value = record[key];
  return value === true || value === 'true';
}

function dateField(record: AdminRecord, key: string): string {
  const raw = str(record, key);
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

function lineItems(record: AdminRecord, key: string): string[] {
  return str(record, key)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// A scalar field worth showing in the detail facts grid: non-empty and not an
// "unknown" sentinel.
function hasFact(record: AdminRecord, key: string): boolean {
  const value = str(record, key).trim();
  return value !== '' && value !== 'unknown';
}

type HalfFill = 'empty' | 'mine' | 'yours' | 'both';

// AI score (0–100) mapped onto the 0–10 star scale, rounded to half-star steps.
function aiRatingTen(record: AdminRecord): number | null {
  const score = num(record, 'latestScore');
  return score === null ? null : Math.round(score / 10);
}

// Who fills a given half-star point (1–10): the human rating (mine, blue), the
// AI rating (yours, yellow), both (green = agreement), or neither.
function halfFill(
  point: number,
  mine: number | null,
  yours: number | null,
): HalfFill {
  const m = mine !== null && mine >= point;
  const y = yours !== null && yours >= point;
  if (m && y) return 'both';
  if (m) return 'mine';
  if (y) return 'yours';
  return 'empty';
}

function toneFor(status: string): string {
  const text = status.trim().toLowerCase();
  if (
    [
      'apply',
      'applied',
      'interviewing',
      'offer',
      'recommend',
      'recommended',
    ].includes(text)
  )
    return 'tone-positive';
  if (['found', 'maybe', 'needs_input', 'needs_research'].includes(text))
    return 'tone-amber';
  if (['archived', 'closed', 'reject', 'rejected', 'skip'].includes(text))
    return 'tone-negative';
  return 'tone-neutral';
}

function skillList(record: AdminRecord, key: string): string[] {
  return parseSkillList(str(record, key));
}

// A required skill is "have" if it matches a reviewed candidate skill, an alias,
// or a curated achievement title/tag such as "Hybrid Cloud Infrastructure".
function hasSkill(skill: string): boolean {
  return candidateSkillMatcher(skill);
}

function isApplyableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return Boolean(
      (parsed.pathname && parsed.pathname !== '/') || parsed.search,
    );
  } catch {
    return false;
  }
}

function postingUrlFor(record: AdminRecord): string {
  const url = str(record, 'postingUrl') || str(record, 'canonicalUrl');
  return url && isApplyableUrl(url) ? url : '';
}

function pageHref(targetPage: number): string {
  // Unlike the shared helper, keep `selected`: the parent prunes the dock
  // selection while the record is off-page and restores it when paging back.
  const url = new URL(page.url);
  if (targetPage <= 1) {
    url.searchParams.delete('page');
  } else {
    url.searchParams.set('page', String(targetPage));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function navigateToPage(targetPage: number): void {
  // While the shell is waiting for the authoritative total, DataTable quite
  // reasonably attempts to clamp an out-of-range deep-linked page. That
  // attempted change is not user intent, so keep the URL stable until the
  // server-paged result arrives with its real bounds.
  if (loading && pagination.totalRecords === 0) return;
  if (targetPage === pagination.page) return;
  void goto(pageHref(targetPage), { keepFocus: true, noScroll: true });
}

const activeFilterCount = $derived(countActiveFilters(filters));

const visibleSkillOptions = $derived.by(() => {
  const query = skillQuery.trim().toLowerCase();
  if (!query) return filterOptions.skills;
  return filterOptions.skills.filter((skill: string) =>
    skill.toLowerCase().includes(query),
  );
});
const skillSearchInUse = $derived(
  skillSearchActive || skillQuery.trim().length > 0,
);

const visibleRecords = $derived(records);
const tableSelected = $derived(new Set<string | number>(selectedIds));

function handleSelectionChange(ids: Set<string | number>): void {
  onSelectedIdsChange?.(new Set([...ids].map(String)));
}

function handleRowClick(record: AdminRecord): void {
  if (!record.id) return;
  onSelectRecord?.(record);
}

const bulkSelectionCount = $derived(selectedIds.size);

/**
 * Focus (row click, orange, feeds the dock) and selection (checkboxes, blue,
 * feeds bulk actions) stay separate. While anything is checked, the focus bar
 * is de-emphasised so the affected set reads unambiguously.
 */
function rowClassFor(record: AdminRecord): string {
  if (!record.id || record.id !== dockSelectedId) return '';
  return bulkSelectionCount > 0
    ? 'dock-selected dock-selected--muted'
    : 'dock-selected';
}

function clearBulkSelection(): void {
  if (onClearSelection) {
    onClearSelection();
    return;
  }
  onSelectedIdsChange?.(new Set());
}
const tableSort = $derived(opportunityTableSort(filters));

const resultCountLabel = $derived.by(() => {
  if (pagination.totalRecords === 0) return '0 opportunities';

  const pageRange =
    pagination.start === pagination.end
      ? String(pagination.start)
      : `${pagination.start}-${pagination.end}`;
  const suffix = activeFilterCount > 0 ? 'filtered' : 'opportunities';
  return `${pageRange} of ${pagination.totalRecords} ${suffix}`;
});
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && drawerOpen) closeDrawer();
  }}
/>

<div class="card-list-wrap">
  <div class="list-toolbar">
    <form method="GET" class="review-form" aria-label="Review filter">
      <label>
        <span>Review</span>
        <select name="review" onchange={setReviewFilter}>
          {#each reviewFilters as option}
            <option value={option.value} selected={option.value === activeReviewFilter}>
              {option.label}
            </option>
          {/each}
        </select>
      </label>
    </form>
    <label class="sort-field">
      <span>Sort</span>
      <select
        bind:value={filters.sort}
        aria-label="Sort opportunities"
        onchange={commitSort}
      >
        <option value="best">Best fit</option>
        <option value="newest">Newest</option>
        <option value="score">AI score</option>
        <option value="salary">Salary</option>
        <option value="rating">My rating</option>
      </select>
    </label>
    <button
      type="button"
      class="filters-toggle"
      class:active={activeFilterCount > 0}
      aria-haspopup="dialog"
      aria-expanded={drawerOpen}
      onclick={openDrawer}
    >
      <SlidersHorizontal size={15} strokeWidth={2.2} />
      Filters
      {#if activeFilterCount > 0}<span class="filters-count">{activeFilterCount}</span>{/if}
    </button>
    <button type="button" class="triage-link" onclick={openTriage}>
      <Layers size={15} strokeWidth={2.2} /> Triage
    </button>
    <a class="triage-link" href={shortlistHref}>
      <Heart size={15} strokeWidth={2.2} /> Shortlist
    </a>
    <span class="result-count">{resultCountLabel}</span>
  </div>

  <OpportunityTriageModal
    bind:open={triageOpen}
    {candidateSkills}
    search={triageSearch}
    initialSort={triageInitialSort}
    onClose={closeTriage}
  />

  {#snippet tableToolbar()}
    <div
      class="bulk-toolbar"
      class:has-selection={bulkSelectionCount > 0 || allMatchingSelected}
    >
      {#if bulkSelectionCount > 0 || allMatchingSelected}
        <div class="selection-summary" role="status" aria-live="polite">
          {#if allMatchingSelected}
            <strong>All {pagination.totalRecords} matching selected</strong>
          {:else}
            <strong>{bulkSelectionCount} selected</strong>
          {/if}
          <span aria-hidden="true">·</span>
          <button type="button" class="selection-clear" onclick={clearBulkSelection}>
            Clear
          </button>
          {#if canSelectAllMatching}
            <span aria-hidden="true">·</span>
            <button
              type="button"
              class="selection-clear"
              onclick={() => onSelectAllMatching?.()}
            >
              Select all {pagination.totalRecords} matching
            </button>
          {/if}
        </div>
      {/if}
      {#if toolbar}
        <div class="bulk-toolbar-actions">{@render toolbar()}</div>
      {/if}
    </div>
  {/snippet}

  {#snippet opportunityCell({ column, row: record }: { column: DataTableColumn<AdminRecord>; row: AdminRecord })}
    {@const oppId = str(record, 'id')}
    {@const posting = postingUrlFor(record)}
    {#if column.id === 'opportunity'}
      <div class="table-opportunity">
        <a
          class="title-link"
          href={`/admin/opportunities/${encodeURIComponent(oppId)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          {str(record, 'title') || 'Untitled opportunity'}
        </a>
        {#if posting}
          <a class="posting-icon" href={posting} target="_blank" rel="noreferrer" title="View posting" aria-label="View posting">
            <ExternalLink size={15} strokeWidth={2.2} />
          </a>
        {/if}
      </div>
    {:else if column.id === 'company'}
      <span class="table-meta"><Building2 size={13} strokeWidth={2.2} /> {companyLabel(record)}</span>
    {:else if column.id === 'location'}
      <span class="table-meta"><MapPin size={13} strokeWidth={2.2} /> {locationLabel(record)}</span>
    {:else if column.id === 'score'}
      <span class={`badge ${toneFor(str(record, 'latestRecommendation'))}`}>
        <Sparkles size={12} strokeWidth={2.4} /> {scoreLabel(record)}
      </span>
    {:else if column.id === 'status'}
      <span class={`badge ${toneFor(str(record, 'status'))}`}>
        {humanize(str(record, 'status'), 'unknown')}
      </span>
    {:else if column.id === 'compensation'}
      {salaryLabel(record) || '—'}
    {/if}
  {/snippet}

  {#snippet expandedOpportunity({ row: record }: { row: AdminRecord })}
    {@const oppId = str(record, 'id')}
    {@const required = skillList(record, 'requiredSkills')}
    {@const preferred = skillList(record, 'preferredSkills')}
    {@const currentStatus = str(record, 'humanReviewStatus')}
    {@const rating = num(record, 'humanRating')}
    {@const aiTen = aiRatingTen(record)}
    <div class="opportunity-expanded">
      {#if required.length || preferred.length}
          <div class="skills" aria-label="Required and preferred skills">
            {#each required as skill}
              <span class="chip" class:have={hasSkill(skill)} title={hasSkill(skill) ? 'You have this' : 'Not in your skills'}>{skill}</span>
            {/each}
            {#each preferred as skill}
              <span class="chip preferred" class:have={hasSkill(skill)} title={`Preferred — ${hasSkill(skill) ? 'you have this' : 'not in your skills'}`}>{skill}</span>
            {/each}
          </div>
        {/if}

      <div class="card-detail">
            <section>
              <h4>Job description</h4>
              {#if str(record, 'descriptionRaw')}
                <pre>{str(record, 'descriptionRaw')}</pre>
              {:else}
                <p class="muted">No job description was captured from the source.</p>
              {/if}
            </section>

            <section>
              <div class="section-head">
                <h4><Sparkles size={13} strokeWidth={2.2} /> Intelligence summary</h4>
                <form method="POST" action="?/processOpportunity" class="inline-form">
                  <input type="hidden" name="opportunityId" value={oppId} />
                  <button
                    type="submit"
                    class="refresh-btn"
                    aria-label="Re-run intelligence"
                    title="Re-run the AI intelligence pipeline (re-scores and re-summarizes this opportunity)"
                  >
                    <RefreshCw size={14} strokeWidth={2.2} />
                  </button>
                </form>
              </div>
              {#if str(record, 'latestScoreSummary')}
                <p class="summary">{str(record, 'latestScoreSummary')}</p>
              {:else}
                <p class="muted">Not yet scored — refresh to run the intelligence pipeline.</p>
              {/if}
            </section>

            {#if lineItems(record, 'responsibilities').length}
              <section>
                <h4>Responsibilities</h4>
                <ul class="detail-list">
                  {#each lineItems(record, 'responsibilities') as item}<li>{item}</li>{/each}
                </ul>
              </section>
            {/if}

            {#if lineItems(record, 'qualifications').length}
              <section>
                <h4>Qualifications</h4>
                <ul class="detail-list">
                  {#each lineItems(record, 'qualifications') as item}<li>{item}</li>{/each}
                </ul>
              </section>
            {/if}

            {#if str(record, 'applyInstructions')}
              <section>
                <h4>Apply instructions</h4>
                <p class="summary">{str(record, 'applyInstructions')}</p>
              </section>
            {/if}

            {#if str(record, 'locationNotes')}
              <section>
                <h4>Location notes</h4>
                <p class="summary">{str(record, 'locationNotes')}</p>
              </section>
            {/if}

            <section>
              <h4>Details</h4>
              <dl class="facts-grid">
                {#if hasFact(record, 'employmentType')}
                  <div class="fact"><dt>Employment type</dt><dd>{humanize(str(record, 'employmentType'))}</dd></div>
                {/if}
                {#if hasFact(record, 'seniority')}
                  <div class="fact"><dt>Seniority</dt><dd>{humanize(str(record, 'seniority'))}</dd></div>
                {/if}
                {#if hasFact(record, 'locations')}
                  <div class="fact"><dt>Locations</dt><dd>{str(record, 'locations')}</dd></div>
                {/if}
                {#if hasFact(record, 'applyMethod')}
                  <div class="fact"><dt>Apply method</dt><dd>{humanize(str(record, 'applyMethod'))}</dd></div>
                {/if}
                {#if hasFact(record, 'freshness')}
                  <div class="fact"><dt>Freshness</dt><dd>{humanize(str(record, 'freshness'))}</dd></div>
                {/if}
                <div class="fact"><dt>Relocation supported</dt><dd>{boolField(record, 'relocationSupported') ? 'Yes' : 'No'}</dd></div>
                <div class="fact"><dt>Visa or EOR possible</dt><dd>{boolField(record, 'visaOrEorPossible') ? 'Yes' : 'No'}</dd></div>
                <div class="fact"><dt>Greenfield signal</dt><dd>{boolField(record, 'greenfieldSignal') ? 'Yes' : 'No'}</dd></div>
                <div class="fact"><dt>Founder signal</dt><dd>{boolField(record, 'founderSignal') ? 'Yes' : 'No'}</dd></div>
                {#if dateField(record, 'reviewedAt')}
                  <div class="fact"><dt>Reviewed at</dt><dd>{dateField(record, 'reviewedAt')}</dd></div>
                {/if}
                {#if dateField(record, 'firstSeenAt')}
                  <div class="fact"><dt>First seen</dt><dd>{dateField(record, 'firstSeenAt')}</dd></div>
                {/if}
                {#if dateField(record, 'lastSeenAt')}
                  <div class="fact"><dt>Last seen</dt><dd>{dateField(record, 'lastSeenAt')}</dd></div>
                {/if}
              </dl>
            </section>

            <OpportunityWorkflowForms
              {record}
              draftApplicationAction={pageActionHref('createDraftApplication')}
              factIntakeAction={pageActionHref('createFactIntake')}
              compact
            />

            <section>
              <h4><Star size={13} strokeWidth={2.2} /> Your rating</h4>
              <form method="POST" action="?/reviewOpportunity" class="rating-form" aria-label="Rating">
                <input type="hidden" name="opportunityId" value={oppId} />
                <input type="hidden" name="humanReviewStatus" value={currentStatus} />
                <input type="hidden" name="reviewedByProfileId" value={reviewedByProfileId} />
                <div
                  class="stars"
                  role="group"
                  aria-label="Rating out of 5 (half-star steps). Blue = your rating, yellow = AI, green = agreement."
                >
                  {#each Array(5) as _, i}
                    {@const leftPoint = i * 2 + 1}
                    {@const rightPoint = i * 2 + 2}
                    {@const leftFill = halfFill(leftPoint, rating, aiTen)}
                    {@const rightFill = halfFill(rightPoint, rating, aiTen)}
                    <span class="star-slot">
                      <span class="star-layer base"><Star size={18} strokeWidth={2} fill="none" /></span>
                      <span class={`star-layer half left fill-${leftFill}`}><Star size={18} strokeWidth={2} fill="currentColor" /></span>
                      <span class={`star-layer half right fill-${rightFill}`}><Star size={18} strokeWidth={2} fill="currentColor" /></span>
                      <button type="submit" name="humanRating" value={leftPoint} class="half-btn left" aria-label={`Rate ${leftPoint} of 10`} title={`Rate ${leftPoint}/10`}></button>
                      <button type="submit" name="humanRating" value={rightPoint} class="half-btn right" aria-label={`Rate ${rightPoint} of 10`} title={`Rate ${rightPoint}/10`}></button>
                    </span>
                  {/each}
                </div>
              </form>
              <p class="rating-legend">
                <span class="swatch mine"></span> your rating
                <span class="swatch yours"></span> AI
                <span class="swatch both"></span> you agree
              </p>
            </section>
      </div>

        <div class="card-actions">
          <form method="POST" action={pageActionHref('reviewOpportunity')} class="decision-form">
            <input type="hidden" name="opportunityId" value={oppId} />
            <input type="hidden" name="humanRating" value={rating ?? ''} />
            <input type="hidden" name="reviewedByProfileId" value={reviewedByProfileId} />
            <label class="sr-only" for={`preflight-override-${oppId}`}>
              Reason to override an inconclusive posting check
            </label>
            <input
              id={`preflight-override-${oppId}`}
              name="preflightOverrideReason"
              placeholder="Only if you personally verified an inconclusive posting"
            />
            {#each reviewStatuses as status}
              <button
                type="submit"
                name="humanReviewStatus"
                value={status.value}
                formaction={status.value === 'apply' ? pageActionHref('acceptOpportunity') : undefined}
                class={`decision ${status.className}`}
                class:primary={status.value === 'apply'}
                class:active={currentStatus === status.value}
                title={status.value === 'apply' ? 'Apply — starts the application process' : status.label}
              >
                {status.label}
              </button>
            {/each}
          </form>
        </div>
    </div>
  {/snippet}

  <DataTable
    data={visibleRecords}
    columns={tableColumns}
    rowKey="id"
    agentAddressable
    selectable
    selected={tableSelected}
    onSelectionChange={handleSelectionChange}
    onRowClick={handleRowClick}
    rowClass={rowClassFor}
    toolbar={tableToolbar}
    modes={tableModes}
    sortable
    sort={tableSort}
    onSortChange={setTableSort}
    {loading}
    {refreshing}
    {stale}
    {error}
    {onRetry}
    page={pagination.page}
    pageSize={pagination.pageSize}
    totalRows={pagination.totalRecords}
    onPageChange={navigateToPage}
    bind:expanded
    canExpand={() => true}
    rowLabel={(record) => str(record, 'title') || 'Untitled opportunity'}
    caption="Opportunities"
    stickyHeader
    hoverable
    dense
    cell={opportunityCell}
    expandedContent={expandedOpportunity}
  />

  {#if drawerOpen}
    <button
      type="button"
      class="drawer-overlay"
      aria-label="Close filters"
      onclick={closeDrawer}
    ></button>
    <div class="drawer" role="dialog" aria-modal="true" aria-label="Opportunity filters">
      <header class="drawer-head">
        <h3>Filters</h3>
        <div class="drawer-head-actions">
          {#if activeFilterCount > 0}
            <button type="button" class="drawer-clear" onclick={clearFilters}>
              Clear all
            </button>
          {/if}
          <button
            type="button"
            class="drawer-close"
            aria-label="Close filters"
            onclick={closeDrawer}
          >
            <X size={18} strokeWidth={2.2} />
          </button>
        </div>
      </header>

      <div class="drawer-body">
        <section class="drawer-group">
          <span class="field-label">Posted within</span>
          <div class="toggle-row" role="group" aria-label="Posted within">
            <button
              type="button"
              class="filter-pill"
              class:active={filters.postedWithinDays === null}
              onclick={() => setFilters({ ...filters, postedWithinDays: null })}
            >
              Any
            </button>
            {#each POSTED_PRESETS as days}
              <button
                type="button"
                class="filter-pill"
                class:active={filters.postedWithinDays === days}
                onclick={() => setFilters({ ...filters, postedWithinDays: filters.postedWithinDays === days ? null : days })}
              >
                {days}d
              </button>
            {/each}
          </div>
          <span class="field-label">Freshness</span>
          <div class="toggle-row" role="group" aria-label="Freshness">
            <button
              type="button"
              class="filter-pill"
              class:active={filters.freshness === 'fresh' || filters.freshOnly}
              onclick={() => setFreshnessFilter('fresh')}
            >
              Fresh
            </button>
            <button
              type="button"
              class="filter-pill"
              class:active={filters.excludeExpired}
              onclick={() => setFilters({ ...filters, excludeExpired: !filters.excludeExpired })}
            >
              Expired
            </button>
          </div>

          {#if filterOptions.employmentTypes.length}
            <span class="field-label">Employment type</span>
            <div class="toggle-row" role="group" aria-label="Employment type">
              {#each filterOptions.employmentTypes as value}
                <button
                  type="button"
                  class="filter-pill"
                  class:active={filters.employmentTypes.includes(value)}
                  onclick={() => toggleEmploymentType(value)}
                >
                  {humanize(value)}
                </button>
              {/each}
            </div>
          {/if}

          {#if filterOptions.workModes.length}
            <span class="field-label">Work mode</span>
            <div class="toggle-row" role="group" aria-label="Work mode">
              {#each filterOptions.workModes as value}
                <button
                  type="button"
                  class="filter-pill"
                  class:active={filters.workModes.includes(value)}
                  onclick={() => toggleWorkMode(value)}
                >
                  {humanize(value)}
                </button>
              {/each}
            </div>
          {/if}

          <span class="field-label">Signals</span>
          <div class="toggle-row" role="group" aria-label="Signals">
            <button
              type="button"
              class="filter-pill"
              class:active={filters.founderOnly}
              onclick={() => toggleSignalFilter('founderOnly')}
            >
              Founder
            </button>
            <button
              type="button"
              class="filter-pill"
              class:active={filters.greenfieldOnly}
              onclick={() => toggleSignalFilter('greenfieldOnly')}
            >
              Greenfield
            </button>
            <button
              type="button"
              class="filter-pill"
              class:active={filters.relocationOnly}
              onclick={() => toggleSignalFilter('relocationOnly')}
            >
              Relocation
            </button>
            <button
              type="button"
              class="filter-pill"
              class:active={filters.visaOnly}
              onclick={() => toggleSignalFilter('visaOnly')}
            >
              Visa / EOR
            </button>
          </div>

          <span class="field-label">Fit</span>
          <div class="segmented" role="group" aria-label="Skill fit">
            <button type="button" class:active={filters.fit === 'all'} onclick={() => setFilters({ ...filters, fit: 'all' })}>All</button>
            <button type="button" class:active={filters.fit === 'have'} onclick={() => setFilters({ ...filters, fit: 'have' })}>I have all</button>
            <button type="button" class:active={filters.fit === 'gaps'} onclick={() => setFilters({ ...filters, fit: 'gaps' })}>Has gaps</button>
          </div>
          {#if filterOptions.skills.length}
            <div
              class="skill-search"
              onfocusin={() => (skillSearchActive = true)}
              onfocusout={handleSkillSearchFocusOut}
            >
              <input
                type="search"
                class="drawer-input"
                placeholder="Find a skill..."
                bind:value={skillQuery}
                aria-label="Filter skill list"
              />
              {#if skillSearchInUse}
                <div class="skill-picker">
                  {#each visibleSkillOptions as skill}
                    <button
                      type="button"
                      class="filter-pill"
                      class:active={skillSelected(skill)}
                      onclick={() => toggleSkill(skill)}
                    >
                      {skill}
                    </button>
                  {:else}
                    <span class="muted">No skills match "{skillQuery}".</span>
                  {/each}
                </div>
              {:else}
                <div class="selected-filter-row" aria-label="Selected skill filters">
                  {#each filters.skills as skill}
                    <button
                      type="button"
                      class="filter-pill active selected-skill"
                      onclick={() => toggleSkill(skill)}
                    >
                      {skill}
                      <X size={13} strokeWidth={2.3} />
                    </button>
                  {:else}
                    <span class="hint">No skill filters selected.</span>
                  {/each}
                </div>
              {/if}
            </div>
            {#if filters.skills.length}
              <span class="hint">{filters.skills.length} skill{filters.skills.length === 1 ? '' : 's'} selected · matches any</span>
            {/if}
          {/if}

          <div class="field-row">
            <label>
              <span>Salary min</span>
              <input type="number" min="0" step="1000" bind:value={filters.salaryMin} onchange={commitFilters} placeholder="—" />
            </label>
            <label>
              <span>Salary max</span>
              <input type="number" min="0" step="1000" bind:value={filters.salaryMax} onchange={commitFilters} placeholder="—" />
            </label>
          </div>
          <div class="field-row">
            <label>
              <span>Hourly min</span>
              <input type="number" min="0" step="1" bind:value={filters.hourlyMin} onchange={commitFilters} placeholder="—" />
            </label>
            <label>
              <span>Hourly max</span>
              <input type="number" min="0" step="1" bind:value={filters.hourlyMax} onchange={commitFilters} placeholder="—" />
            </label>
          </div>
          <label class="check">
            <input type="checkbox" bind:checked={filters.includeMissingComp} onchange={commitFilters} />
            <span>Include postings with no comp listed</span>
          </label>
          <span class="hint">Ranges compare raw numbers; mixed currencies aren’t converted.</span>

          {#if filterOptions.statuses.length}
            <label>
              <span>Status</span>
              <select bind:value={filters.status} onchange={commitFilters}>
                <option value="all">All statuses</option>
                {#each filterOptions.statuses as value}
                  <option value={value}>{humanize(value)}</option>
                {/each}
              </select>
            </label>
          {/if}
          {#if filterOptions.seniorities.length}
            <label>
              <span>Seniority</span>
              <select bind:value={filters.seniority} onchange={commitFilters}>
                <option value="all">Any</option>
                {#each filterOptions.seniorities as value}
                  <option value={value}>{humanize(value)}</option>
                {/each}
              </select>
            </label>
          {/if}
          <label>
            <span>Minimum rating</span>
            <select bind:value={filters.minRating} onchange={commitFilters}>
              <option value={null}>Any</option>
              {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as rating}
                <option value={rating}>{rating}+ / 10</option>
              {/each}
            </select>
          </label>
          <div class="field-row">
            <label>
              <span>Min score</span>
              <input type="number" min="0" max="100" step="1" bind:value={filters.minScore} onchange={commitFilters} placeholder="0" />
            </label>
            <label>
              <span>Max score</span>
              <input type="number" min="0" max="100" step="1" bind:value={filters.maxScore} onchange={commitFilters} placeholder="100" />
            </label>
          </div>
        </section>
      </div>

      <footer class="drawer-foot">
        <span>{pagination.totalRecords} match{pagination.totalRecords === 1 ? '' : 'es'}</span>
        <button type="button" class="drawer-done" onclick={closeDrawer}>Done</button>
      </footer>
    </div>
  {/if}
</div>

<style>
  .card-list-wrap {
    display: grid;
    gap: 14px;
  }

  .list-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
  }

  .triage-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-weight: 800;
    text-decoration: none;
    cursor: pointer;
  }

  .triage-link:hover,
  .triage-link:focus-visible {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .list-toolbar label {
    display: grid;
    gap: 4px;
    font-weight: 800;
    color: var(--smrt-color-on-surface);
  }

  .list-toolbar > label > span,
  .review-form span {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .list-toolbar select {
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    font: inherit;
    color: var(--smrt-color-on-surface);
  }

  .filters-toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 0 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    font: inherit;
    font-weight: 800;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
  }

  .filters-toggle.active {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .filters-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-size: 11px;
    font-weight: 800;
  }

  .result-count {
    margin-left: auto;
    align-self: center;
    color: var(--smrt-color-on-surface-variant);
    font-weight: 700;
  }

  .drawer-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    border: 0;
    padding: 0;
    background: color-mix(in srgb, var(--smrt-color-scrim, #000) 45%, transparent);
    cursor: pointer;
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 61;
    display: flex;
    flex-direction: column;
    width: min(420px, 100vw);
    height: 100dvh;
    border-left: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    box-shadow: -8px 0 32px color-mix(in srgb, var(--smrt-color-scrim, #000) 28%, transparent);
  }

  .drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .drawer-head h3 {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-large-font);
  }

  .drawer-head-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .drawer-clear {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    padding: 4px 10px;
    background: var(--smrt-color-surface);
    font: inherit;
    font-size: 12px;
    font-weight: 800;
    color: var(--smrt-color-primary);
    cursor: pointer;
  }

  .drawer-close {
    display: inline-flex;
    padding: 4px;
    border: 0;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }

  .drawer-close:hover {
    color: var(--smrt-color-on-surface);
  }

  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 4px 16px 16px;
  }

  .drawer-group {
    display: grid;
    gap: 10px;
    padding: 16px 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .drawer-group:last-child {
    border-bottom: 0;
  }

  .drawer-group label {
    display: grid;
    gap: 4px;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    font-weight: 700;
  }

  .drawer-group label > span,
  .field-label {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.2 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .drawer-group select,
  .drawer-group input[type='number'],
  .drawer-input {
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    font: inherit;
    color: var(--smrt-color-on-surface);
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .check {
    display: flex !important;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    font-weight: 700;
  }

  .check span {
    font: inherit !important;
    font-size: 13px !important;
    text-transform: none !important;
    color: var(--smrt-color-on-surface) !important;
  }

  .check input {
    width: 16px;
    height: 16px;
  }

  .segmented {
    display: inline-flex;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    overflow: hidden;
  }

  .segmented button {
    flex: 1;
    min-height: 32px;
    padding: 0 10px;
    border: 0;
    border-right: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    font: inherit;
    font-size: 12px;
    font-weight: 800;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }

  .segmented button:last-child {
    border-right: 0;
  }

  .segmented button.active {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .toggle-row,
  .selected-filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .filter-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: inherit;
    font: inherit;
    font-size: 12px;
    font-weight: 800;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
  }

  .filter-pill:hover,
  .filter-pill:focus-visible {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .filter-pill.active {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .filter-pill.active:hover,
  .filter-pill.active:focus-visible {
    color: var(--smrt-color-on-primary);
  }

  .skill-search {
    display: grid;
    gap: 8px;
  }

  .skill-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 180px;
    overflow-y: auto;
    padding: 2px;
  }

  .selected-skill {
    min-width: 0;
  }

  .hint {
    color: var(--smrt-color-on-surface-variant);
    font-size: 11px;
    font-style: italic;
  }

  .drawer-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid var(--smrt-color-outline-variant);
    color: var(--smrt-color-on-surface-variant);
    font-size: 13px;
    font-weight: 700;
  }

  .drawer-done {
    min-height: 34px;
    padding: 0 16px;
    border: 1px solid var(--smrt-color-primary);
    border-radius: 6px;
    background: var(--smrt-color-primary);
    font: inherit;
    font-weight: 800;
    color: var(--smrt-color-on-primary);
    cursor: pointer;
  }

  .table-opportunity {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .title-link {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-large-font);
    text-decoration: none;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .title-link:hover {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  /* Posting opens in a new tab right beside the title; the rating is pushed to
     the far right of the title row. */
  .posting-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--smrt-color-primary);
  }

  .posting-icon:hover {
    color: var(--smrt-color-on-surface);
  }

  .table-meta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 13px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border: 1px solid currentColor;
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 9%, var(--smrt-color-surface));
    font-size: 12px;
    font-weight: 800;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .skills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    padding: 2px 9px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 700;
  }

  .chip.have {
    border-color: var(--smrt-color-success);
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .chip.preferred {
    border-style: dashed;
  }

  .card-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
    padding-top: 4px;
  }

  .decision-form {
    display: inline-flex;
    gap: 6px;
  }

  .decision {
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface);
    font: inherit;
    font-weight: 800;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
  }

  /* Apply is a commitment, not a triage verdict — give it a standing primary
     accent so it reads as the action even before it's the active status. */
  .decision.primary {
    border-color: var(--smrt-color-success);
    color: var(--smrt-color-success);
  }

  .decision.accept.active {
    border-color: var(--smrt-color-success);
    background: var(--smrt-color-success);
    color: var(--smrt-color-on-success);
  }

  .decision.maybe.active {
    border-color: var(--smrt-color-warning);
    background: var(--smrt-color-warning);
    color: var(--smrt-color-on-warning);
  }

  .decision.reject.active {
    border-color: var(--smrt-color-error);
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
  }

  .stars {
    display: inline-flex;
    gap: 2px;
  }

  .star-slot {
    position: relative;
    display: inline-flex;
    width: 18px;
    height: 18px;
  }

  /* Stacked star glyphs: a neutral outline base, then the two clipped halves
     coloured by who fills them. Transparent half-buttons sit on top for input. */
  .star-layer {
    position: absolute;
    inset: 0;
    display: inline-flex;
    pointer-events: none;
  }

  .star-layer.base {
    color: var(--smrt-color-on-surface-variant);
  }

  .half.left {
    clip-path: inset(0 50% 0 0);
  }

  .half.right {
    clip-path: inset(0 0 0 50%);
  }

  .fill-empty {
    color: transparent;
  }

  .fill-mine {
    color: var(--smrt-color-primary);
  }

  .fill-yours {
    color: var(--smrt-color-warning);
  }

  .fill-both {
    color: var(--smrt-color-success);
  }

  .half-btn {
    position: absolute;
    top: 0;
    width: 50%;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .half-btn.left {
    left: 0;
  }

  .half-btn.right {
    right: 0;
  }

  .half-btn:hover {
    background: color-mix(in srgb, var(--smrt-color-primary) 18%, transparent);
    border-radius: 2px;
  }

  .card-detail {
    display: grid;
    gap: 14px;
    padding-top: 6px;
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
  }

  .section-head h4 {
    margin: 0;
  }

  .inline-form {
    display: inline-flex;
  }

  .refresh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: 0;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }

  .refresh-btn:hover {
    color: var(--smrt-color-primary);
  }

  .detail-list {
    margin: 0;
    padding-left: 18px;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.5;
  }

  .detail-list li {
    margin: 2px 0;
  }

  .facts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px 16px;
    margin: 0;
  }

  .facts-grid .fact {
    display: grid;
    gap: 1px;
  }

  .facts-grid dt {
    color: var(--smrt-color-on-surface-variant);
    font: 800 11px/1.3 var(--smrt-font-family-mono, monospace);
    text-transform: uppercase;
  }

  .facts-grid dd {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    font-weight: 700;
  }

  .rating-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    margin: 8px 0 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    font-weight: 700;
  }

  .rating-legend .swatch {
    display: inline-block;
    width: 11px;
    height: 11px;
    margin-right: 4px;
    border-radius: 3px;
    vertical-align: -1px;
  }

  .rating-legend .swatch.mine {
    background: var(--smrt-color-primary);
  }

  .rating-legend .swatch.yours {
    background: var(--smrt-color-warning);
  }

  .rating-legend .swatch.both {
    background: var(--smrt-color-success);
  }

  .card-detail h4 {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .card-detail pre {
    max-height: 360px;
    margin: 0;
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    font: 13px/1.5 var(--smrt-font-family-mono, monospace);
    white-space: pre-wrap;
  }

  .card-detail .summary {
    margin: 0;
    color: var(--smrt-color-on-surface);
    font-size: 13px;
    line-height: 1.5;
  }

  .muted {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }

  .tone-positive { color: var(--smrt-color-on-success-container); }
  .tone-amber { color: var(--smrt-color-on-warning-container); }
  .tone-negative { color: var(--smrt-color-on-error-container); }
  .tone-neutral { color: var(--smrt-color-on-surface-variant); }

  /* Dock-selected row (mirrors the legacy `tr.selected td` convention). */
  .card-list-wrap :global(tr.data-table__row.dock-selected > td) {
    background: var(--smrt-color-warning-container);
    box-shadow: inset 3px 0 0 var(--smrt-color-warning);
  }

  /* Bulk toolbar: selection summary on the left, review controls on the right. */
  .bulk-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 10px 16px;
  }

  .selection-summary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-right: auto;
    padding: 0 10px;
    min-height: 32px;
    border: 1px solid var(--smrt-color-primary);
    border-radius: 6px;
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font-size: 13px;
  }

  .selection-summary strong {
    font-weight: 900;
  }

  .selection-clear {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 800;
    text-decoration: underline;
    cursor: pointer;
  }

  .selection-clear:hover,
  .selection-clear:focus-visible {
    color: var(--smrt-color-primary);
  }

  .bulk-toolbar-actions {
    display: flex;
    flex: 1 1 auto;
    justify-content: flex-end;
    min-width: 0;
  }

  /* Row expander: reuse the upstream button (keeps aria-expanded/aria-controls)
     but draw a chevron instead of the bordered +/− circle. */
  .card-list-wrap :global(.data-table__expand-button) {
    position: relative;
    border: 0;
    border-radius: 6px;
    color: transparent;
    font-size: 0;
    line-height: 0;
  }

  .card-list-wrap :global(.data-table__expand-button::after) {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 8px;
    height: 8px;
    border-right: 2px solid var(--smrt-color-on-surface-variant);
    border-bottom: 2px solid var(--smrt-color-on-surface-variant);
    transform: translate(-50%, -65%) rotate(-45deg);
    transition: transform 140ms ease;
  }

  .card-list-wrap :global(.data-table__expand-button:hover),
  .card-list-wrap :global(.data-table__expand-button:focus-visible) {
    background: var(--smrt-color-surface-container);
  }

  .card-list-wrap :global(.data-table__expand-button:hover::after),
  .card-list-wrap :global(.data-table__expand-button:focus-visible::after) {
    border-color: var(--smrt-color-on-surface);
  }

  .card-list-wrap :global(.data-table__expand-button[aria-expanded='true']::after) {
    transform: translate(-50%, -30%) rotate(45deg);
  }

  /* De-emphasised focus bar while a bulk selection is active. */
  .card-list-wrap :global(tr.data-table__row.dock-selected.dock-selected--muted > td) {
    background: color-mix(
      in srgb,
      var(--smrt-color-warning-container) 35%,
      var(--smrt-color-surface)
    );
    box-shadow: inset 3px 0 0
      color-mix(in srgb, var(--smrt-color-warning) 45%, transparent);
  }

</style>
