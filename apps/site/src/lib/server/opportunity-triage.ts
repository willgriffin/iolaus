import type { AdminRecord } from '$lib/admin/dock';
import {
  filterStateFromSearchParams,
  getString,
  matchesOpportunity,
  type OpportunityFilterState,
  sortOpportunities,
} from '$lib/opportunity-filters';
import { createCandidateSkillMatcher } from '$lib/skill-matching';
import { listAdminRecords, requireAdminResource } from './admin-data';
import {
  countOpportunityRecords,
  listOpportunityPageIds,
  loadCurrentCitedOpportunitySupport,
  loadCurrentSourceOpportunityEligibility,
  normalizeOpportunityRecommendation,
  type WorkspaceOpportunityQuery,
} from './admin-opportunity-query';
import { attachOpportunityContext } from './admin-resource-route';
import { getDbConfig } from './db.js';
import {
  loadCurrentOpportunityAssessmentProjections,
  loadOpportunityAssessmentQueryContext,
} from './opportunity-assessment-store.js';
import { loadCurrentOpportunityReviewOverlays } from './opportunity-review-overlay.js';
import { getCollection } from './smrt.js';
import {
  type CandidateWorkspaceSubject,
  requireCandidateWorkspaceSubject,
  type WorkspaceSubject,
} from './workspace-subject.js';

/**
 * Browser triage uses the current list filters and order, adding only the
 * undecided-review constraint. Agent callers retain the fixed active-posting
 * preset below, with score/rejection priority or newest-first ordering.
 */

/** Only opportunities with no recorded decision are triageable. */
export const TRIAGE_REVIEW_FILTER = 'unsorted';

/**
 * Cards fetched per refill.
 *
 * Three, not five (issue #452): the deck shows one card at a time and refills
 * at two in hand, so a five-card window buys one extra card of runway and pays
 * for it on the very first paint — the read the operator actually waits on.
 */
export const TRIAGE_QUEUE_SIZE = 3;

/** Refill once fewer than this many undecided cards remain in hand. */
export const TRIAGE_QUEUE_REFILL_THRESHOLD = 2;

/** SQLite has no Postgres lateral joins; keep the local demo bounded in memory. */
const LOCAL_TRIAGE_RECORD_LIMIT = 1_001;
const DECISION_STATUSES = new Set(['apply', 'maybe', 'reject']);

/** Bounded undo history; only the most recent entry is ever offered. */
export const TRIAGE_UNDO_STACK_LIMIT = 10;

/** Default agent queue filters; browser list context does not apply them. */
export const TRIAGE_FILTER_PRESET = {
  excludeExpired: true,
  excludeStale: true,
  sortDirection: 'desc',
  status: 'all',
} as const satisfies Partial<OpportunityFilterState>;

/**
 * Overlay the triage preset on an inherited filter state.
 *
 * This is exclusively the agent-facing policy. Browser triage uses the list
 * context verbatim, while still adding the undecided review constraint.
 */
export function applyTriagePreset(
  filters: OpportunityFilterState,
  sort?: string | null,
): OpportunityFilterState {
  return {
    ...filters,
    ...TRIAGE_FILTER_PRESET,
    sort: (sort ?? filters.sort) === 'newest' ? 'newest' : 'score',
  };
}

/** Build the browser triage state from the list URL's own parameters. */
export function triageFiltersFromSearchParams(
  params: URLSearchParams,
): OpportunityFilterState {
  return filterStateFromSearchParams(params);
}

export interface TriageQueueRequest {
  candidateSkills?: readonly string[];
  /** Browser triage inherits its list state; agents retain the fixed preset. */
  context?: 'agent' | 'list';
  filters: OpportunityFilterState;
  /**
   * Attach the company, application, and score context the triage card
   * renders. The agent-facing read builds its own bounded context, so it opts
   * out entirely: the hydration pass would only add reads it does not assert
   * and then discard every field.
   */
  hydrateContext?: boolean;
  limit?: number;
  offset?: number;
  search?: string;
  /** Verified request identity used only for that user's assessment overlay. */
  workspaceSubject?: WorkspaceSubject;
}

export interface TriageQueue {
  /** Hydrated opportunity records, in triage order. */
  candidates: AdminRecord[];
  limit: number;
  offset: number;
  /** Undecided opportunities matching the preset, before paging. */
  total: number;
}

function triageOpportunityContextOptions(workspaceSubject?: WorkspaceSubject) {
  return workspaceSubject
    ? { includeActivity: false, workspaceSubject }
    : { includeActivity: false };
}

function candidateSubject(
  subject: WorkspaceSubject | undefined,
): CandidateWorkspaceSubject | null {
  try {
    return requireCandidateWorkspaceSubject(subject);
  } catch {
    return null;
  }
}

function clampOffset(offset: number | undefined, total: number): number {
  if (!Number.isFinite(offset ?? 0)) return 0;
  const value = Math.max(0, Math.trunc(offset ?? 0));
  return total > 0 ? Math.min(value, Math.max(0, total - 1)) : 0;
}

function matchesTriageSearch(record: AdminRecord, search: string | undefined) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  return [
    getString(record, 'title'),
    getString(record, 'descriptionRaw'),
    getString(record, 'descriptionSummary'),
    getString(record, 'postingUrl'),
    getString(record, 'requiredSkills'),
    getString(record, 'preferredSkills'),
  ].some((value) => value.toLowerCase().includes(needle));
}

function triageScoreRank(record: AdminRecord): number {
  const score = record.latestScore;
  return typeof score === 'number' ? score : Number.NEGATIVE_INFINITY;
}

function triageScoreTieBreak(left: AdminRecord, right: AdminRecord): number {
  const updatedAtRank = (record: AdminRecord): number => {
    const raw = record.updatedAt;
    const timestamp =
      raw instanceof Date
        ? raw.getTime()
        : typeof raw === 'number'
          ? raw
          : typeof raw === 'string'
            ? Date.parse(raw)
            : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
  };
  const leftRank = updatedAtRank(left);
  const rightRank = updatedAtRank(right);
  if (leftRank !== rightRank) return rightRank - leftRank;
  return getString(left, 'id').localeCompare(getString(right, 'id'));
}

function assessmentRanking(projection: unknown): {
  excluded: boolean;
  fitScore: number | null;
} {
  if (
    !projection ||
    typeof projection !== 'object' ||
    Array.isArray(projection)
  ) {
    return { excluded: false, fitScore: null };
  }
  const ranking = (projection as { ranking?: unknown }).ranking;
  if (!ranking || typeof ranking !== 'object' || Array.isArray(ranking)) {
    return { excluded: false, fitScore: null };
  }
  const value = ranking as { excluded?: unknown; fitScore?: unknown };
  return {
    excluded: value.excluded === true,
    fitScore: typeof value.fitScore === 'number' ? value.fitScore : null,
  };
}

function sortSqliteTriage(
  candidates: AdminRecord[],
  filters: OpportunityFilterState,
  triageRejectDepriority: boolean,
): AdminRecord[] {
  if (filters.sort !== 'score' || !triageRejectDepriority) {
    return sortOpportunities(candidates, filters.sort, filters.sortDirection);
  }
  return [...candidates].sort((left, right) => {
    const tier =
      Number(
        normalizeOpportunityRecommendation(left.latestRecommendation) ===
          'reject',
      ) -
      Number(
        normalizeOpportunityRecommendation(right.latestRecommendation) ===
          'reject',
      );
    if (tier !== 0) return tier;
    const leftScore = triageScoreRank(left);
    const rightScore = triageScoreRank(right);
    if (leftScore !== rightScore) return rightScore - leftScore;
    return triageScoreTieBreak(left, right);
  });
}

async function loadSqliteTriageQueue({
  candidateSkills,
  filters,
  hydrateContext,
  limit,
  offset,
  search,
  triageRejectDepriority,
  workspaceSubject,
}: TriageQueueRequest & {
  hydrateContext: boolean;
  limit: number;
  triageRejectDepriority: boolean;
}) {
  const subject = candidateSubject(workspaceSubject);
  if (!subject) return { candidates: [], limit, offset: 0, total: 0 };
  const opportunities = (await getCollection('Opportunity')) as unknown as {
    list: (options?: Record<string, unknown>) => Promise<unknown[]>;
  };
  const rows = await opportunities.list({
    limit: LOCAL_TRIAGE_RECORD_LIMIT,
    orderBy: 'updated_at DESC',
  });
  if (rows.length >= LOCAL_TRIAGE_RECORD_LIMIT) {
    throw new Error(
      `Local triage is bounded to ${LOCAL_TRIAGE_RECORD_LIMIT - 1} opportunities; archive or deploy this data set before continuing.`,
    );
  }
  const records = rows.map(
    (row) => JSON.parse(JSON.stringify(row)) as AdminRecord,
  );
  const opportunityIds = records
    .map((record) => record.id)
    .filter((id): id is string => typeof id === 'string');
  const [
    assessmentProjections,
    sourceEligibilityProjections,
    reviewOverlays,
    citedSupport,
  ] = await Promise.all([
    loadCurrentOpportunityAssessmentProjections({
      opportunities: records.map((record) => ({
        id: record.id,
        sourceContentFingerprint: record.sourceContentFingerprint,
        sourceContentVersion: record.sourceContentVersion,
      })),
      subject,
    }),
    loadCurrentSourceOpportunityEligibility(subject),
    loadCurrentOpportunityReviewOverlays({ opportunityIds, subject }),
    filters.sort === 'cited_support'
      ? loadCurrentCitedOpportunitySupport(subject)
      : Promise.resolve(new Map()),
  ]);
  const candidates = records
    .map((record) => {
      const assessmentProjection = record.id
        ? (assessmentProjections.get(record.id) ?? null)
        : null;
      const sourceEligibility = record.id
        ? sourceEligibilityProjections.get(record.id)
        : undefined;
      const sourceEligibilityProjection =
        sourceEligibility &&
        sourceEligibility.sourceContentFingerprint ===
          record.sourceContentFingerprint &&
        sourceEligibility.sourceContentVersion === record.sourceContentVersion
          ? sourceEligibility.projection
          : null;
      const reviewOverlay = record.id
        ? (reviewOverlays.get(record.id) ?? null)
        : null;
      const currentSupport = record.id
        ? citedSupport.get(record.id)
        : undefined;
      const partialAssessmentProjection =
        currentSupport &&
        currentSupport.sourceContentFingerprint ===
          record.sourceContentFingerprint &&
        currentSupport.sourceContentVersion === record.sourceContentVersion
          ? currentSupport.projection
          : null;
      const ranking = assessmentRanking(assessmentProjection);
      return {
        ...record,
        assessmentProjection,
        sourceEligibilityProjection,
        partialAssessmentProjection,
        humanRating: reviewOverlay?.humanRating ?? null,
        humanReviewNotes: reviewOverlay?.humanReviewNotes ?? '',
        humanReviewStatus: reviewOverlay?.humanReviewStatus ?? '',
        latestRecommendation: ranking.excluded ? 'reject' : '',
        latestScore: ranking.fitScore,
        reviewOverlay,
      };
    })
    .filter((record) => {
      const review = getString(record, 'humanReviewStatus')
        .trim()
        .toLowerCase();
      return (
        (filters.status !== 'all' ||
          getString(record, 'status') !== 'archived') &&
        !DECISION_STATUSES.has(review) &&
        matchesTriageSearch(record, search) &&
        matchesOpportunity(record, filters, {
          hasSkill: createCandidateSkillMatcher(candidateSkills ?? []),
        })
      );
    });
  const ordered = sortSqliteTriage(candidates, filters, triageRejectDepriority);
  const total = ordered.length;
  const resolvedOffset = clampOffset(offset, total);
  const page = ordered.slice(resolvedOffset, resolvedOffset + limit);
  return {
    candidates: hydrateContext
      ? await attachOpportunityContext(
          page,
          triageOpportunityContextOptions(subject),
        )
      : page,
    limit,
    offset: resolvedOffset,
    total,
  };
}

/**
 * Load one window of the triage queue.
 *
 * The total is counted first because it bounds the offset, then one id page and
 * one hydration pass attach company, application, score, and intake context —
 * the same context the list cards render from, so the triage card needs no
 * bespoke query of its own.
 */
export async function loadTriageQueue({
  candidateSkills = [],
  context = 'agent',
  filters,
  hydrateContext = true,
  limit = TRIAGE_QUEUE_SIZE,
  offset = 0,
  search,
  workspaceSubject,
}: TriageQueueRequest): Promise<TriageQueue> {
  const subject = candidateSubject(workspaceSubject);
  if (!subject) return { candidates: [], limit, offset: 0, total: 0 };
  const assessmentContext =
    await loadOpportunityAssessmentQueryContext(subject);
  const queueFilters =
    context === 'agent' ? applyTriagePreset(filters) : filters;
  const triageRejectDepriority =
    context === 'agent' && queueFilters.sort === 'score';
  if (getDbConfig().type === 'sqlite') {
    return await loadSqliteTriageQueue({
      candidateSkills,
      filters: queueFilters,
      hydrateContext,
      limit,
      offset,
      search,
      triageRejectDepriority,
      workspaceSubject: subject,
    });
  }
  const query: WorkspaceOpportunityQuery = {
    ...assessmentContext,
    candidateSkills,
    filters: queueFilters,
    reviewFilter: TRIAGE_REVIEW_FILTER,
    search: search?.trim() || undefined,
    triageRejectDepriority,
    workspaceSubject: subject,
  };
  const total = await countOpportunityRecords(query);
  const resolvedOffset = clampOffset(offset, total);
  if (total === 0) {
    return { candidates: [], limit, offset: resolvedOffset, total };
  }

  const ids = await listOpportunityPageIds({
    ...query,
    limit,
    offset: resolvedOffset,
  });
  if (ids.length === 0) {
    return { candidates: [], limit, offset: resolvedOffset, total };
  }

  const resource = requireAdminResource('opportunities');
  const rawRecords = await listAdminRecords(resource, {
    limit: ids.length,
    where: { 'id in': ids },
  });
  const byId = new Map(
    rawRecords
      .map((record) => [record.id, record] as const)
      .filter(
        (entry): entry is readonly [string, AdminRecord] =>
          typeof entry[0] === 'string' && entry[0].length > 0,
      ),
  );
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((record): record is AdminRecord => Boolean(record));
  /*
   * Issue #452: the deck renders company, score and the posting's own fields
   * and reads no part of the `AgentRun`/`FactIntake` activity trail, which is
   * the bulk of the hydrated payload (roughly 20KB per card against 5KB for
   * everything shown). Skipping it drops two of the five hydration reads and
   * about 80% of the bytes the operator waits on for the first card.
   */
  const candidates = hydrateContext
    ? await attachOpportunityContext(
        ordered,
        triageOpportunityContextOptions(workspaceSubject),
      )
    : ordered;

  return { candidates, limit, offset: resolvedOffset, total };
}

export interface NextTriageCandidate {
  candidate: AdminRecord | null;
  /** 1-based position of `candidate` in the queue; 0 when the queue is empty. */
  position: number;
  /** Undecided opportunities still behind this one, including it. */
  remaining: number;
  total: number;
}

/**
 * The single-candidate read behind the agent-facing triage tool. Agents have
 * no client-side skip list, so they advance strictly by `offset`.
 */
export async function nextTriageCandidate(
  request: Omit<TriageQueueRequest, 'hydrateContext' | 'limit'>,
): Promise<NextTriageCandidate> {
  // The tool summarises the raw row against its own `relatedContext`, so the
  // admin hydration pass would only add unasserted `AgentRun` and `FactIntake`
  // reads to the run and then throw the result away.
  const queue = await loadTriageQueue({
    ...request,
    hydrateContext: false,
    limit: 1,
  });
  // `loadTriageQueue` clamps the offset so a deep-linked browser URL still
  // lands on a card. An agent has no such URL: raising the offset is its only
  // way to pass, and a null candidate is its only termination signal, so a
  // clamped offset past the end would re-serve the last candidate forever.
  const requested = Number.isFinite(request.offset ?? 0)
    ? Math.max(0, Math.trunc(request.offset ?? 0))
    : 0;
  const [candidate = null] = requested >= queue.total ? [] : queue.candidates;
  return {
    candidate,
    position: candidate ? queue.offset + 1 : 0,
    remaining: candidate ? Math.max(0, queue.total - queue.offset) : 0,
    total: queue.total,
  };
}
