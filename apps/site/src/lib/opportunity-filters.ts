import type { AdminRecord } from '$lib/admin/dock';

// Status ordering for the default "best fit" sort — active/early stages first,
// terminal last. Shared with the list component so sort and grouping agree.
export const OPPORTUNITY_STATUS_ORDER = [
  'apply',
  'applied',
  'interviewing',
  'offer',
  'recommended',
  'found',
  'maybe',
  'needs_input',
  'archived',
  'reject',
  'rejected',
  'closed',
] as const;

/**
 * The human-review dispositions that mean the owner has decided about a
 * posting. They are independent of the lifecycle `status`: "Maybe" and an
 * admin review deliberately leave the row in `found`/`recommended`, so any
 * consumer that must not disturb a decided row has to check this field too.
 */
export const DECISION_REVIEW_STATUSES = ['apply', 'maybe', 'reject'] as const;

export type OpportunitySort = 'best' | 'newest' | 'score' | 'salary' | 'rating';
export type OpportunitySortDirection = 'asc' | 'desc';

export type FitFilter = 'all' | 'have' | 'gaps';

export interface OpportunityFilterState {
  status: string;
  fit: FitFilter;
  skills: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  hourlyMin: number | null;
  hourlyMax: number | null;
  includeMissingComp: boolean;
  postedWithinDays: number | null;
  excludeExpired: boolean;
  excludeStale: boolean;
  freshness: string;
  employmentTypes: string[];
  workModes: string[];
  seniority: string;
  relocationOnly: boolean;
  visaOnly: boolean;
  founderOnly: boolean;
  greenfieldOnly: boolean;
  freshOnly: boolean;
  minRating: number | null;
  minScore: number | null;
  maxScore: number | null;
  sort: OpportunitySort;
  sortDirection: OpportunitySortDirection;
}

export const DEFAULT_OPPORTUNITY_FILTERS: OpportunityFilterState = {
  status: 'all',
  fit: 'all',
  skills: [],
  salaryMin: null,
  salaryMax: null,
  hourlyMin: null,
  hourlyMax: null,
  includeMissingComp: true,
  postedWithinDays: null,
  excludeExpired: false,
  excludeStale: false,
  freshness: 'all',
  employmentTypes: [],
  workModes: [],
  seniority: 'all',
  relocationOnly: false,
  visaOnly: false,
  founderOnly: false,
  greenfieldOnly: false,
  freshOnly: false,
  minRating: null,
  minScore: null,
  maxScore: null,
  sort: 'best',
  sortDirection: 'desc',
};

const OPPORTUNITY_FILTER_PARAM_KEYS = [
  'status',
  'fit',
  'skill',
  'salaryMin',
  'salaryMax',
  'hourlyMin',
  'hourlyMax',
  'includeMissingComp',
  'postedWithinDays',
  'excludeExpired',
  'excludeStale',
  'freshness',
  'employmentType',
  'workMode',
  'seniority',
  'relocationOnly',
  'visaOnly',
  'founderOnly',
  'greenfieldOnly',
  'freshOnly',
  'minRating',
  'minScore',
  'maxScore',
  'sort',
  'sortDirection',
] as const;

export const EMPTY_OPPORTUNITY_FILTER_OPTIONS: OpportunityFilterOptions = {
  employmentTypes: [],
  freshness: [],
  seniorities: [],
  skills: [],
  statuses: [],
  workModes: [],
};

export function getString(record: AdminRecord, key: string): string {
  const raw = record[key];
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

export function getNumber(record: AdminRecord, key: string): number | null {
  const raw = record[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw)))
    return Number(raw);
  return null;
}

function getBoolean(record: AdminRecord, key: string): boolean {
  const raw = record[key];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

function getDate(record: AdminRecord, key: string): Date | null {
  const raw = record[key];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Split a comma/newline-delimited skills string into a deduped, trimmed list,
// preserving the first-seen casing for display.
export function parseSkillList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[\n,]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function recordSkills(record: AdminRecord): string[] {
  return [
    ...parseSkillList(getString(record, 'requiredSkills')),
    ...parseSkillList(getString(record, 'preferredSkills')),
  ];
}

export interface OpportunityFilterOptions {
  statuses: string[];
  employmentTypes: string[];
  workModes: string[];
  seniorities: string[];
  freshness: string[];
  skills: string[];
}

// Build the option lists the drawer offers, drawn from the records actually
// present so we never show a filter value that can match nothing.
export function collectOpportunityOptions(
  records: AdminRecord[],
): OpportunityFilterOptions {
  const statuses = new Set<string>();
  const employmentTypes = new Set<string>();
  const workModes = new Set<string>();
  const seniorities = new Set<string>();
  const freshness = new Set<string>();
  const skillsByKey = new Map<string, string>();

  for (const record of records) {
    const status = getString(record, 'status').trim();
    if (status) statuses.add(status);
    const employmentType = getString(record, 'employmentType').trim();
    if (employmentType && employmentType !== 'unknown')
      employmentTypes.add(employmentType);
    const workMode = getString(record, 'workMode').trim();
    if (workMode && workMode !== 'unknown') workModes.add(workMode);
    const seniority = getString(record, 'seniority').trim();
    if (seniority && seniority !== 'unknown') seniorities.add(seniority);
    const fresh = getString(record, 'freshness').trim();
    if (fresh && fresh !== 'unknown') freshness.add(fresh);
    for (const skill of recordSkills(record)) {
      const key = skill.toLowerCase();
      if (!skillsByKey.has(key)) skillsByKey.set(key, skill);
    }
  }

  const sortAlpha = (a: string, b: string) => a.localeCompare(b);
  return {
    statuses: [...statuses].sort(sortAlpha),
    employmentTypes: [...employmentTypes].sort(sortAlpha),
    workModes: [...workModes].sort(sortAlpha),
    seniorities: [...seniorities].sort(sortAlpha),
    freshness: [...freshness].sort(sortAlpha),
    skills: [...skillsByKey.values()].sort(sortAlpha),
  };
}

// True when at least one of `record`'s required skills is NOT matched by the
// candidate. A posting with no listed required skills has no gaps.
function hasSkillGap(
  record: AdminRecord,
  hasSkill: (skill: string) => boolean,
): boolean {
  const required = parseSkillList(getString(record, 'requiredSkills'));
  return required.some((skill) => !hasSkill(skill));
}

function rangeOverlaps(
  recordMin: number | null,
  recordMax: number | null,
  filterMin: number | null,
  filterMax: number | null,
): boolean {
  const lo = recordMin ?? recordMax;
  const hi = recordMax ?? recordMin;
  if (lo === null || hi === null) return false;
  if (filterMin !== null && hi < filterMin) return false;
  if (filterMax !== null && lo > filterMax) return false;
  return true;
}

export interface MatchContext {
  hasSkill: (skill: string) => boolean;
  now?: Date;
}

export function matchesOpportunity(
  record: AdminRecord,
  filters: OpportunityFilterState,
  context: MatchContext,
): boolean {
  const now = context.now ?? new Date();

  if (
    filters.status !== 'all' &&
    getString(record, 'status') !== filters.status
  )
    return false;

  if (filters.fit === 'have' && hasSkillGap(record, context.hasSkill))
    return false;
  if (filters.fit === 'gaps' && !hasSkillGap(record, context.hasSkill))
    return false;

  if (filters.skills.length > 0) {
    const owned = new Set(recordSkills(record).map((s) => s.toLowerCase()));
    const wanted = filters.skills.map((s) => s.toLowerCase());
    if (!wanted.some((skill) => owned.has(skill))) return false;
  }

  if (filters.salaryMin !== null || filters.salaryMax !== null) {
    const min = getNumber(record, 'salaryMin');
    const max = getNumber(record, 'salaryMax');
    if (min === null && max === null) {
      if (!filters.includeMissingComp) return false;
    } else if (!rangeOverlaps(min, max, filters.salaryMin, filters.salaryMax)) {
      return false;
    }
  }

  if (filters.hourlyMin !== null || filters.hourlyMax !== null) {
    const min = getNumber(record, 'hourlyMin');
    const max = getNumber(record, 'hourlyMax');
    if (min === null && max === null) {
      if (!filters.includeMissingComp) return false;
    } else if (!rangeOverlaps(min, max, filters.hourlyMin, filters.hourlyMax)) {
      return false;
    }
  }

  if (filters.postedWithinDays !== null) {
    const posted =
      getDate(record, 'postedAt') ?? getDate(record, 'firstSeenAt');
    if (!posted) return false;
    const cutoff = now.getTime() - filters.postedWithinDays * 86_400_000;
    if (posted.getTime() < cutoff) return false;
  }

  if (filters.excludeExpired) {
    const expires = getDate(record, 'expiresAt');
    if (expires && expires.getTime() < now.getTime()) return false;
  }

  if (
    filters.excludeStale &&
    getString(record, 'freshness').trim().toLowerCase() === 'stale'
  ) {
    return false;
  }

  if (
    filters.freshness !== 'all' &&
    getString(record, 'freshness') !== filters.freshness
  ) {
    return false;
  }

  if (
    filters.employmentTypes.length > 0 &&
    !filters.employmentTypes.includes(getString(record, 'employmentType'))
  )
    return false;

  if (
    filters.workModes.length > 0 &&
    !filters.workModes.includes(getString(record, 'workMode'))
  )
    return false;

  if (
    filters.seniority !== 'all' &&
    getString(record, 'seniority') !== filters.seniority
  )
    return false;

  if (filters.relocationOnly && !getBoolean(record, 'relocationSupported'))
    return false;
  if (filters.visaOnly && !getBoolean(record, 'visaOrEorPossible'))
    return false;
  if (filters.founderOnly && !getBoolean(record, 'founderSignal')) return false;
  if (filters.greenfieldOnly && !getBoolean(record, 'greenfieldSignal'))
    return false;
  if (
    filters.freshOnly &&
    getString(record, 'freshness').trim().toLowerCase() !== 'fresh'
  )
    return false;

  if (filters.minRating !== null) {
    const rating = getNumber(record, 'humanRating');
    if (rating === null || rating < filters.minRating) return false;
  }

  if (filters.minScore !== null || filters.maxScore !== null) {
    const score = getNumber(record, 'latestScore');
    if (score === null) return false;
    if (filters.minScore !== null && score < filters.minScore) return false;
    if (filters.maxScore !== null && score > filters.maxScore) return false;
  }

  return true;
}

function statusRank(record: AdminRecord): number {
  const index = OPPORTUNITY_STATUS_ORDER.indexOf(
    getString(record, 'status') as (typeof OPPORTUNITY_STATUS_ORDER)[number],
  );
  return index === -1 ? OPPORTUNITY_STATUS_ORDER.length : index;
}

function salaryRank(record: AdminRecord): number {
  return (
    getNumber(record, 'salaryMax') ??
    getNumber(record, 'salaryMin') ??
    Number.NEGATIVE_INFINITY
  );
}

// Recency rank for the "newest" sort: prefer postedAt, fall back to firstSeenAt
// (same precedence as the postedWithinDays filter). Missing dates rank last.
// Note: cannot collapse to `postedAt || firstSeenAt` on raw timestamps — a
// 1970 epoch (0) is falsy and a missing-date sentinel must not be truthy.
function postedRank(record: AdminRecord): number {
  const date = getDate(record, 'postedAt') ?? getDate(record, 'firstSeenAt');
  return date ? date.getTime() : Number.NEGATIVE_INFINITY;
}

export function sortOpportunities(
  records: AdminRecord[],
  sort: OpportunitySort,
  direction: OpportunitySortDirection = 'desc',
): AdminRecord[] {
  const sorted = [...records];
  const compare = (left: number, right: number): number =>
    direction === 'asc' ? left - right : right - left;
  switch (sort) {
    case 'newest':
      sorted.sort((a, b) => compare(postedRank(a), postedRank(b)));
      break;
    case 'score':
      sorted.sort((a, b) =>
        compare(
          getNumber(a, 'latestScore') ?? -1,
          getNumber(b, 'latestScore') ?? -1,
        ),
      );
      break;
    case 'salary':
      sorted.sort((a, b) => compare(salaryRank(a), salaryRank(b)));
      break;
    case 'rating':
      sorted.sort((a, b) =>
        compare(
          getNumber(a, 'humanRating') ?? -1,
          getNumber(b, 'humanRating') ?? -1,
        ),
      );
      break;
    default:
      sorted.sort((a, b) => {
        const ra = statusRank(a);
        const rb = statusRank(b);
        if (ra !== rb) return ra - rb;
        return (
          (getNumber(b, 'latestScore') ?? -1) -
          (getNumber(a, 'latestScore') ?? -1)
        );
      });
  }
  return sorted;
}

// Number of distinct filter dimensions that are narrowing the list. Drives the
// badge on the drawer toggle. Sort is excluded — it reorders, it doesn't filter.
export function countActiveFilters(filters: OpportunityFilterState): number {
  let count = 0;
  if (filters.status !== 'all') count++;
  if (filters.fit !== 'all') count++;
  if (filters.skills.length > 0) count++;
  const hasCompRange =
    filters.salaryMin !== null ||
    filters.salaryMax !== null ||
    filters.hourlyMin !== null ||
    filters.hourlyMax !== null;
  if (filters.salaryMin !== null || filters.salaryMax !== null) count++;
  if (filters.hourlyMin !== null || filters.hourlyMax !== null) count++;
  // includeMissingComp only narrows results when a comp range is active, so
  // don't let an otherwise-inert toggle inflate the active-filter badge.
  if (!filters.includeMissingComp && hasCompRange) count++;
  if (filters.postedWithinDays !== null) count++;
  if (filters.excludeExpired) count++;
  if (filters.excludeStale) count++;
  if (filters.freshness !== 'all') count++;
  if (filters.employmentTypes.length > 0) count++;
  if (filters.workModes.length > 0) count++;
  if (filters.seniority !== 'all') count++;
  if (filters.relocationOnly) count++;
  if (filters.visaOnly) count++;
  if (filters.founderOnly) count++;
  if (filters.greenfieldOnly) count++;
  if (filters.freshOnly) count++;
  if (filters.minRating !== null) count++;
  if (filters.minScore !== null || filters.maxScore !== null) count++;
  return count;
}

// Merge a possibly-partial / stale persisted blob onto defaults, keeping only
// known keys so a schema change can't poison the in-memory state.
export function normalizeFilterState(raw: unknown): OpportunityFilterState {
  if (!raw || typeof raw !== 'object')
    return { ...DEFAULT_OPPORTUNITY_FILTERS };
  const input = raw as Record<string, unknown>;
  const base: OpportunityFilterState = { ...DEFAULT_OPPORTUNITY_FILTERS };

  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const stringOr = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value ? value : fallback;
  const boolOr = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  const stringArrayOr = (value: unknown, legacyValue?: unknown): string[] => {
    const raw = Array.isArray(value)
      ? value
      : typeof legacyValue === 'string'
        ? [legacyValue]
        : [];
    return raw.filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim() !== '' && entry !== 'all',
    );
  };

  base.status = stringOr(input.status, 'all');
  if (input.fit === 'have' || input.fit === 'gaps' || input.fit === 'all')
    base.fit = input.fit;
  if (Array.isArray(input.skills))
    base.skills = input.skills.filter(
      (s): s is string => typeof s === 'string',
    );
  base.salaryMin = numberOrNull(input.salaryMin);
  base.salaryMax = numberOrNull(input.salaryMax);
  base.hourlyMin = numberOrNull(input.hourlyMin);
  base.hourlyMax = numberOrNull(input.hourlyMax);
  base.includeMissingComp = boolOr(input.includeMissingComp, true);
  base.postedWithinDays = numberOrNull(input.postedWithinDays);
  base.excludeExpired = boolOr(input.excludeExpired, false);
  base.excludeStale = boolOr(input.excludeStale, false);
  base.freshness = stringOr(input.freshness, 'all');
  base.employmentTypes = stringArrayOr(
    input.employmentTypes,
    input.employmentType,
  );
  base.workModes = stringArrayOr(input.workModes, input.workMode);
  base.seniority = stringOr(input.seniority, 'all');
  base.relocationOnly = boolOr(input.relocationOnly, false);
  base.visaOnly = boolOr(input.visaOnly, false);
  base.founderOnly = boolOr(input.founderOnly, false);
  base.greenfieldOnly = boolOr(input.greenfieldOnly, false);
  base.freshOnly = boolOr(input.freshOnly, false);
  base.minRating = numberOrNull(input.minRating);
  base.minScore = numberOrNull(input.minScore);
  base.maxScore = numberOrNull(input.maxScore);
  if (
    input.sort === 'best' ||
    input.sort === 'newest' ||
    input.sort === 'score' ||
    input.sort === 'salary' ||
    input.sort === 'rating'
  )
    base.sort = input.sort;
  if (input.sortDirection === 'asc' || input.sortDirection === 'desc')
    base.sortDirection = input.sortDirection;
  return base;
}

function numberFromSearchParam(
  params: URLSearchParams,
  key: string,
): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function trueFromSearchParam(params: URLSearchParams, key: string): boolean {
  const raw = params.get(key);
  if (raw === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function filterStateFromSearchParams(
  params: URLSearchParams,
): OpportunityFilterState {
  return normalizeFilterState({
    employmentTypes: params.getAll('employmentType'),
    excludeExpired: trueFromSearchParam(params, 'excludeExpired'),
    excludeStale: trueFromSearchParam(params, 'excludeStale'),
    fit: params.get('fit') ?? undefined,
    founderOnly: trueFromSearchParam(params, 'founderOnly'),
    freshOnly: trueFromSearchParam(params, 'freshOnly'),
    freshness: params.get('freshness') ?? undefined,
    greenfieldOnly: trueFromSearchParam(params, 'greenfieldOnly'),
    hourlyMax: numberFromSearchParam(params, 'hourlyMax'),
    hourlyMin: numberFromSearchParam(params, 'hourlyMin'),
    includeMissingComp: params.get('includeMissingComp') !== 'false',
    maxScore: numberFromSearchParam(params, 'maxScore'),
    minRating: numberFromSearchParam(params, 'minRating'),
    minScore: numberFromSearchParam(params, 'minScore'),
    postedWithinDays: numberFromSearchParam(params, 'postedWithinDays'),
    relocationOnly: trueFromSearchParam(params, 'relocationOnly'),
    salaryMax: numberFromSearchParam(params, 'salaryMax'),
    salaryMin: numberFromSearchParam(params, 'salaryMin'),
    seniority: params.get('seniority') ?? undefined,
    skills: parseSkillList(params.getAll('skill').join('\n')),
    sort: params.get('sort') ?? undefined,
    sortDirection: params.get('sortDirection') ?? undefined,
    status: params.get('status') ?? undefined,
    visaOnly: trueFromSearchParam(params, 'visaOnly'),
    workModes: params.getAll('workMode'),
  });
}

function setNumberSearchParam(
  params: URLSearchParams,
  key: string,
  value: number | null,
): void {
  if (value !== null) params.set(key, String(value));
}

function setTrueSearchParam(
  params: URLSearchParams,
  key: string,
  value: boolean,
): void {
  if (value) params.set(key, 'true');
}

export function writeFilterStateSearchParams(
  params: URLSearchParams,
  filters: OpportunityFilterState,
): void {
  for (const key of OPPORTUNITY_FILTER_PARAM_KEYS) {
    params.delete(key);
  }

  const normalized = normalizeFilterState(filters);
  if (normalized.status !== DEFAULT_OPPORTUNITY_FILTERS.status)
    params.set('status', normalized.status);
  if (normalized.fit !== DEFAULT_OPPORTUNITY_FILTERS.fit)
    params.set('fit', normalized.fit);
  for (const skill of normalized.skills) {
    params.append('skill', skill);
  }
  setNumberSearchParam(params, 'salaryMin', normalized.salaryMin);
  setNumberSearchParam(params, 'salaryMax', normalized.salaryMax);
  setNumberSearchParam(params, 'hourlyMin', normalized.hourlyMin);
  setNumberSearchParam(params, 'hourlyMax', normalized.hourlyMax);
  if (!normalized.includeMissingComp) params.set('includeMissingComp', 'false');
  setNumberSearchParam(params, 'postedWithinDays', normalized.postedWithinDays);
  setTrueSearchParam(params, 'excludeExpired', normalized.excludeExpired);
  setTrueSearchParam(params, 'excludeStale', normalized.excludeStale);
  if (normalized.freshness !== DEFAULT_OPPORTUNITY_FILTERS.freshness)
    params.set('freshness', normalized.freshness);
  for (const employmentType of normalized.employmentTypes) {
    params.append('employmentType', employmentType);
  }
  for (const workMode of normalized.workModes) {
    params.append('workMode', workMode);
  }
  if (normalized.seniority !== DEFAULT_OPPORTUNITY_FILTERS.seniority)
    params.set('seniority', normalized.seniority);
  setTrueSearchParam(params, 'relocationOnly', normalized.relocationOnly);
  setTrueSearchParam(params, 'visaOnly', normalized.visaOnly);
  setTrueSearchParam(params, 'founderOnly', normalized.founderOnly);
  setTrueSearchParam(params, 'greenfieldOnly', normalized.greenfieldOnly);
  setTrueSearchParam(params, 'freshOnly', normalized.freshOnly);
  setNumberSearchParam(params, 'minRating', normalized.minRating);
  setNumberSearchParam(params, 'minScore', normalized.minScore);
  setNumberSearchParam(params, 'maxScore', normalized.maxScore);
  if (normalized.sort !== DEFAULT_OPPORTUNITY_FILTERS.sort)
    params.set('sort', normalized.sort);
  if (normalized.sortDirection !== DEFAULT_OPPORTUNITY_FILTERS.sortDirection)
    params.set('sortDirection', normalized.sortDirection);
}
