<script lang="ts">
import {
  CollectionList,
  DataTable,
  type DataTableColumn,
  type SortState,
} from '@happyvertical/smrt-ui/data';
import { Button, Pagination } from '@happyvertical/smrt-ui/ui';
import Building2 from '@lucide/svelte/icons/building-2';
import ExternalLink from '@lucide/svelte/icons/external-link';
import Heart from '@lucide/svelte/icons/heart';
import Layers from '@lucide/svelte/icons/layers';
import MapPin from '@lucide/svelte/icons/map-pin';
import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
import Sparkles from '@lucide/svelte/icons/sparkles';
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
  type AssessmentEligibilityBucket,
  assessmentCoverageMessages,
  assessmentEligibilityLabels,
  assessmentMatchReadinessLabel,
  getOpportunityAssessmentProjection,
  getOpportunityEligibilityProjection,
} from '$lib/opportunity-assessment-projection';
import {
  countActiveFilters,
  DEFAULT_OPPORTUNITY_FILTERS,
  filterStateFromSearchParams,
  normalizeFilterState,
  getNumber as num,
  type OpportunityFilterOptions,
  type OpportunityFilterState,
  type OpportunitySort,
  getString as str,
  writeFilterStateSearchParams,
} from '$lib/opportunity-filters';
import {
  completeReviewLabel,
  getCurrentCompleteOpportunityReview,
  hasUnavailableCompleteOpportunityReview,
} from '$lib/opportunity-resume-fit-review-projection';
import {
  filtersForOpportunityTableSort,
  opportunityTableSort,
} from '$lib/opportunity-table-sorting';
import {
  currentQuestionScreeningRank,
  getCurrentQuestionScreeningProjection,
  questionScreeningLabel,
} from '$lib/question-screening-projection';
import AddUrlIntake from './AddUrlIntake.svelte';
import { ADMIN_RESOURCE_REFRESH_EVENT } from './admin-resource-hydration';
import OpportunityTriageModal from './OpportunityTriageModal.svelte';
import OpportunityVideoRequirements from './OpportunityVideoRequirements.svelte';
import { getCurrentPartialOpportunityAssessmentProjection } from './PartialOpportunityEvidence.svelte';

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
  selectedIds = new Set<string>(),
  onSelectedIdsChange,
  allMatchingSelected = false,
  canSelectAllMatching = false,
  onSelectAllMatching,
  onClearSelection,
  dockSelectedId = null,
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
const VIEW_STORAGE_KEY = 'iolaus.admin.opportunities.view.v1';
type OpportunityView = 'list' | 'columns' | 'table';
const opportunityViews: { value: OpportunityView; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'columns', label: 'Columns' },
  { value: 'table', label: 'Table' },
];
let opportunityView = $state<OpportunityView>('table');

function setOpportunityView(value: OpportunityView): void {
  opportunityView = value;
  writePreference(VIEW_STORAGE_KEY, value);
}
const OPPORTUNITY_SORT_VALUES: readonly OpportunitySort[] = [
  'best',
  'eligibility',
  'cited_support',
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
    label: 'Match assessment',
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

let drawerOpen = $state(page.url.searchParams.has('facets'));
let skillQuery = $state('');
let skillSearchActive = $state(false);
let filters = $state<OpportunityFilterState>(
  filtersFromListSearchParams(page.url.searchParams),
);
let lastUrlSearch = $state(page.url.search);
let preferencesReady = $state(false);
let lastRefreshAt = 0;

$effect(() => {
  if (page.url.search === lastUrlSearch) return;
  lastUrlSearch = page.url.search;
  filters = filtersFromListSearchParams(page.url.searchParams);
  drawerOpen = page.url.searchParams.has('facets');
});

$effect(() => {
  if (!preferencesReady) return;
  rememberReviewFilter(activeReviewFilter);
  rememberSort(filters.sort);
});

onMount(() => {
  const storedView = readPreference(VIEW_STORAGE_KEY);
  if (
    storedView === 'list' ||
    storedView === 'columns' ||
    storedView === 'table'
  ) {
    opportunityView = storedView;
  }
  const cleanupRefreshListeners = installOpportunityListRefreshListeners();
  const url = new URL(page.url);
  let changed = removeActionSearchParams(url.searchParams);
  const hasReviewParam = url.searchParams.has('review');
  const hasLegacyTriageSort = url.searchParams.has(TRIAGE_SORT_URL_PARAM);
  const hasSortParam = url.searchParams.has('sort') || hasLegacyTriageSort;

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
    if (hasLegacyTriageSort) {
      url.searchParams.delete(TRIAGE_SORT_URL_PARAM);
      writeFilterStateSearchParams(url.searchParams, filters);
      changed = true;
    }
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

/**
 * `triageSort` was the retired deck-only ordering parameter. Keep old links
 * useful by translating its two supported values into the list's sort state;
 * a real list `sort` remains authoritative.
 */
function filtersFromListSearchParams(
  params: URLSearchParams,
): OpportunityFilterState {
  const filters = filterStateFromSearchParams(params);
  if (params.has('sort')) return filters;
  const legacySort = params.get(TRIAGE_SORT_URL_PARAM);
  if (legacySort === 'score' || legacySort === 'newest') {
    return { ...filters, sort: legacySort, sortDirection: 'desc' };
  }
  return filters;
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

/**
 * Triage runs the list's current filter and ordering, while the deck
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
let singleOpportunity = $state<AdminRecord | null>(null);
function openTriage(): void {
  singleOpportunity = null;
  triageOpen = true;
}

/**
 * Closing is the session boundary: the list refreshes so decided rows drop
 * out. When the deck was deep-linked, dropping `?triage=1` re-runs the route,
 * which is the same refresh by another name.
 */
function closeTriage(): void {
  triageOpen = false;
  if (singleOpportunity) {
    singleOpportunity = null;
    return;
  }
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

function toggleArrayValue<T extends string>(values: T[], value: T): T[] {
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

function toggleEligibilityBucket(bucket: AssessmentEligibilityBucket): void {
  setFilters({
    ...filters,
    eligibilityBuckets: toggleArrayValue(filters.eligibilityBuckets, bucket),
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

function questionScreeningTooltip(record: AdminRecord): string {
  const current = getCurrentQuestionScreeningProjection(
    record.questionScreeningProjection,
    record.questionScreeningStatus,
  );
  if (!current)
    return record.questionScreeningStatus === 'unknown'
      ? 'Screening needs refresh. Questions, captured source or candidate evidence may have changed.'
      : 'Screening questions have not been run for this opportunity.';
  if (current.rolePreScreen)
    return 'Title-only pre-screen against your target roles. Full questions have not been assessed; open the opportunity to run full screening anyway.';
  const coverage = current.aggregate.evidenceCoveragePercent;
  return [
    'Weighted alignment with your enabled questions. Unknowns earn no points; this is not hiring probability.',
    `Evidence coverage: ${coverage === null ? 'Unknown' : `${coverage.toFixed(1)}%`}.`,
    `${current.aggregate.mustHaveConflictIds.length} must-have conflicts; ${current.aggregate.unresolvedMustHaveIds.length} unresolved must-haves.`,
    'Open the opportunity to review questions, answers and evidence.',
  ].join(' ');
}

// Score only — the recommendation is still conveyed by the badge's tone color
// (toneFor(latestRecommendation) on the badge) and by the status badge.
function scoreLabel(record: AdminRecord): string {
  const questionRank = currentQuestionScreeningRank(record);
  if (questionRank.enabled) {
    const questions = getCurrentQuestionScreeningProjection(
      record.questionScreeningProjection,
      record.questionScreeningStatus,
    );
    return questions
      ? questionScreeningLabel(questions)
      : record.questionScreeningStatus === 'unknown'
        ? 'Screening needs refresh'
        : 'Recommendation unknown';
  }
  const complete = getCurrentCompleteOpportunityReview(
    record.resumeFitReviewProjection,
    record.completeReviewStatus,
  );
  if (complete?.evidenceFit) return completeReviewLabel(complete);
  if (hasUnavailableCompleteOpportunityReview(record))
    return 'Complete review needs refresh';
  const assessment = getOpportunityAssessmentProjection(
    record.assessmentProjection,
  );
  return assessment.matchReadiness === 'assessable'
    ? `${assessment.fitScore}/100`
    : assessment.sourceStatus !== 'current' &&
        getCurrentPartialOpportunityAssessmentProjection(
          record.partialAssessmentProjection,
        )
      ? 'Partial assessment'
      : assessmentMatchReadinessLabel(assessment);
}

function eligibilityLabel(record: AdminRecord): string {
  const bucket = getOpportunityEligibilityProjection(
    record.sourceEligibilityProjection,
    record.assessmentProjection,
  ).buckets[0];
  return bucket ? assessmentEligibilityLabels[bucket] : 'Unknown';
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
const pageIds = $derived(
  visibleRecords.map((record: AdminRecord) => String(record.id)),
);
const allPageSelected = $derived(
  pageIds.length > 0 && pageIds.every((id: string) => selectedIds.has(id)),
);
const somePageSelected = $derived(
  pageIds.some((id: string) => selectedIds.has(id)),
);

function togglePageSelection(): void {
  const next = new Set(selectedIds);
  for (const id of pageIds) {
    if (allPageSelected) next.delete(id);
    else next.add(id);
  }
  onSelectedIdsChange?.(next);
}

function handleSelectionChange(ids: Set<string | number>): void {
  onSelectedIdsChange?.(new Set([...ids].map(String)));
}

function handleRowClick(record: AdminRecord): void {
  if (!record.id) return;
  singleOpportunity = record;
  triageOpen = true;
}

function refreshAfterSingleDecision(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ADMIN_RESOURCE_REFRESH_EVENT));
  }
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
        <option value="eligibility">Eligibility for your work location</option>
        <option value="cited_support">Cited support</option>
        <option value="recommendation">Recommendation</option>
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
    <a class="triage-link" href="/admin/preferences/screening-questions">Screening Questions</a>
    <div class="view-selector" role="group" aria-label="Opportunity view">
      {#each opportunityViews as view}
        <Button
          variant={opportunityView === view.value ? 'primary' : 'secondary'}
          aria-pressed={opportunityView === view.value}
          onclick={() => setOpportunityView(view.value)}
        >{view.label}</Button>
      {/each}
    </div>
    <AddUrlIntake />
    <span class="result-count">{resultCountLabel}</span>
  </div>

  <OpportunityTriageModal
    bind:open={triageOpen}
    {candidateSkills}
    search={triageSearch}
    {singleOpportunity}
    onClose={closeTriage}
    onDecision={refreshAfterSingleDecision}
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
    {@const posting = postingUrlFor(record)}
    {#if column.id === 'opportunity'}
      <div class="table-opportunity">
        <span
          class="title-link"
        >
          {str(record, 'title') || 'Untitled opportunity'}
        </span>
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
      <span class="badge neutral" title={currentQuestionScreeningRank(record).enabled ? questionScreeningTooltip(record) : hasUnavailableCompleteOpportunityReview(record) ? 'Saved complete review could not be validated for current material.' : getCurrentCompleteOpportunityReview(record.resumeFitReviewProjection, record.completeReviewStatus)?.evidenceFit ? 'Current complete material review. Candidate support and source uncertainty are shown separately.' : getOpportunityAssessmentProjection(record.assessmentProjection).sourceStatus !== 'current' && getCurrentPartialOpportunityAssessmentProjection(record.partialAssessmentProjection) ? 'Overall fit not yet established. Review the evidenced criteria and unresolved source clauses.' : assessmentCoverageMessages(getOpportunityAssessmentProjection(record.assessmentProjection)).join(' ')}>
        <Sparkles size={12} strokeWidth={2.4} /> {scoreLabel(record)}
      </span>
      <OpportunityVideoRequirements requirements={record.videoRequirements} compact />
    {:else if column.id === 'status'}
      <span class={`badge ${toneFor(str(record, 'status'))}`}>
        {humanize(str(record, 'status'), 'unknown')}
      </span>
    {:else if column.id === 'compensation'}
      {salaryLabel(record) || '—'}
    {/if}
  {/snippet}


  {#if opportunityView === 'table'}
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
    rowLabel={(record) => str(record, 'title') || 'Untitled opportunity'}
    caption="Opportunities"
    stickyHeader
    hoverable
    dense
    cell={opportunityCell}
  />
  {:else}
    <section aria-label="Opportunities" aria-busy={loading || refreshing}>
      {@render tableToolbar()}
      {#if error}
        <div role="alert">{error instanceof Error ? error.message : error}
          {#if onRetry}<Button variant="secondary" onclick={onRetry}>Retry</Button>{/if}
        </div>
      {/if}
      {#if refreshing}<p role="status">Refreshing opportunities…</p>
      {:else if stale}<p role="status">Showing previously loaded opportunities.</p>{/if}
      <label class="page-selection">
        <input type="checkbox" aria-label="Select all rows on this page"
          checked={allPageSelected} indeterminate={somePageSelected && !allPageSelected}
          disabled={visibleRecords.length === 0 || loading} onchange={togglePageSelection} />
        Select this page
      </label>
      <CollectionList
        items={visibleRecords} itemKey="id" title="title"
        layout={opportunityView === 'columns' ? 'grid' : 'list'}
        selectable selected={tableSelected} onselectionchange={handleSelectionChange}
        {loading} item={collectionOpportunity}
      />
      <Pagination currentPage={pagination.page} totalPages={pagination.totalPages}
        onPageChange={navigateToPage} aria-label="Opportunity pages" />
    </section>
  {/if}

  {#snippet collectionOpportunity({ item: record }: { item: AdminRecord; index: number; selected: boolean })}
    <div class="collection-opportunity">
      <button type="button" class="collection-review" onclick={() => handleRowClick(record)}
        aria-label={`Review ${str(record, 'title') || 'Untitled opportunity'}`}>
        <strong>{str(record, 'title') || 'Untitled opportunity'}</strong>
        <span class="table-meta"><Building2 size={13} /> {companyLabel(record)}</span>
        <span class="table-meta"><MapPin size={13} /> {locationLabel(record)}</span>
        <span class="eligibility-label">{eligibilityLabel(record)}</span>
        <span title={questionScreeningTooltip(record)}>{scoreLabel(record)} · {humanize(str(record, 'status'), 'unknown')}</span>
        {#if salaryLabel(record)}<span>{salaryLabel(record)}</span>{/if}
        <OpportunityVideoRequirements requirements={record.videoRequirements} compact />
      </button>
      {#if postingUrlFor(record)}
        <a href={postingUrlFor(record)} target="_blank" rel="noreferrer">View posting</a>
      {/if}
    </div>
  {/snippet}

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

          <span class="field-label">Eligibility for your work location</span>
          <div class="toggle-row" role="group" aria-label="Eligibility for your work location">
            <button type="button" class="filter-pill" class:active={filters.eligibilityBuckets.includes('eligible')} onclick={() => toggleEligibilityBucket('eligible')}>Eligible for your work location</button>
            <button type="button" class="filter-pill" class:active={filters.eligibilityBuckets.includes('sponsorship_possible')} onclick={() => toggleEligibilityBucket('sponsorship_possible')}>Sponsorship possible</button>
            <button type="button" class="filter-pill" class:active={filters.eligibilityBuckets.includes('location_restriction')} onclick={() => toggleEligibilityBucket('location_restriction')}>Location or authorization restriction</button>
            <button type="button" class="filter-pill" class:active={filters.eligibilityBuckets.includes('unknown')} onclick={() => toggleEligibilityBucket('unknown')}>Unknown</button>
            <button type="button" class="filter-pill" class:active={filters.eligibilityBuckets.includes('conflicting')} onclick={() => toggleEligibilityBucket('conflicting')}>Conflicting</button>
          </div>

          <span class="field-label">Fit</span>
          <div class="segmented" role="group" aria-label="Skill fit">
            <button type="button" class:active={filters.fit === 'all'} onclick={() => setFilters({ ...filters, fit: 'all' })}>All</button>
            <button type="button" class:active={filters.fit === 'have'} onclick={() => setFilters({ ...filters, fit: 'have' })}>Reviewed criteria supported</button>
            <button type="button" class:active={filters.fit === 'gaps'} onclick={() => setFilters({ ...filters, fit: 'gaps' })}>Needs evidence</button>
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
  .view-selector { display: inline-flex; flex-wrap: wrap; gap: 0; }
  .view-selector :global(.button) { border-radius: 0; min-height: 44px; }
  .view-selector :global(.button:first-child) { border-start-start-radius: var(--smrt-radius-medium); border-end-start-radius: var(--smrt-radius-medium); }
  .view-selector :global(.button:last-child) { border-start-end-radius: var(--smrt-radius-medium); border-end-end-radius: var(--smrt-radius-medium); }
  .view-selector :global(.button[aria-pressed='true']) { box-shadow: inset 0 0 0 2px currentColor; }
  .page-selection { display: flex; align-items: center; gap: var(--smrt-spacing-2); min-height: 44px; }
  .page-selection input { width: 1.125rem; height: 1.125rem; }
  .collection-opportunity { display: grid; gap: var(--smrt-spacing-2); min-width: 0; }
  .collection-review { display: grid; gap: var(--smrt-spacing-1); width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; overflow-wrap: anywhere; }
  .collection-review:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }

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
    min-width: 0;
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
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
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
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
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
    min-width: 0;
    display: inline-flex;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    overflow: hidden;
  }

  .segmented button {
    min-width: 0;
    overflow-wrap: anywhere;
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

  .eligibility-label {
    flex: 0 1 auto;
    color: var(--smrt-color-on-surface-variant);
    font-size: 12px;
    overflow-wrap: anywhere;
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
