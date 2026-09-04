import type { AdminRecord } from '$lib/admin/dock';
import {
  normalizeTriageSort,
  type TriageSort,
} from '$lib/admin/triage-session';
import {
  filterStateFromSearchParams,
  getString,
  matchesOpportunity,
  type OpportunityFilterState,
  sortOpportunities,
} from '$lib/opportunity-filters';
import { listAdminRecords, requireAdminResource } from './admin-data';
import {
  countOpportunityRecords,
  listOpportunityPageIds,
} from './admin-opportunity-query';
import { attachOpportunityContext } from './admin-resource-route';
import { getDbConfig } from './db.js';
import { getCollection } from './smrt.js';

/**
 * One-at-a-time opportunity triage (issue #425).
 *
 * The queue is deliberately *not* a second query language: it is the existing
 * opportunity browse filter with a fixed preset applied on top, so the triage
 * view and the list can never disagree about what is decidable. The preset is
 * the whole policy:
 *
 * - `reviewFilter: 'unsorted'` — only rows with no recorded Apply/Maybe/Reject.
 * - `status: 'all'` — which is what makes the browse query drop archived rows
 *   (see `admin-opportunity-query`: the archived exclusion is applied exactly
 *   when no explicit status is named). Triage never inherits `status=archived`.
 * - `excludeExpired` / `excludeStale` — a closed or no-longer-seen posting is
 *   not worth a decision.
 * - `sortDirection: 'desc'`, over one of the two orderings the deck offers:
 *   `score` (best match first, the default) or `newest`. The query's own
 *   tiebreak (`updated_at DESC, id ASC`) makes either order stable, so a refill
 *   cannot re-serve a card that was just decided. Any other sort the operator
 *   carried in from the list is normalised back onto those two.
 *
 * Everything else — skills, comp, work mode, seniority, search — is inherited
 * from whatever filter state the operator carried in from the list.
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

/** The filter dimensions triage owns outright, whatever the caller passed. */
export const TRIAGE_FILTER_PRESET = {
  excludeExpired: true,
  excludeStale: true,
  sortDirection: 'desc',
  status: 'all',
} as const satisfies Partial<OpportunityFilterState>;

/**
 * Overlay the triage preset on an inherited filter state.
 *
 * `sort` is the one preset dimension the operator (or an agent) chooses, and
 * only between the deck's two orderings; anything else falls back to `score`.
 */
export function applyTriagePreset(
  filters: OpportunityFilterState,
  sort?: TriageSort | string | null,
): OpportunityFilterState {
  return {
    ...filters,
    ...TRIAGE_FILTER_PRESET,
    sort: normalizeTriageSort(sort ?? filters.sort),
  };
}

/** Build the triage filter state from a route or tool URL's own parameters. */
export function triageFiltersFromSearchParams(
  params: URLSearchParams,
): OpportunityFilterState {
  const filters = filterStateFromSearchParams(params);
  return applyTriagePreset(filters, params.get('sort') ?? filters.sort);
}

export interface TriageQueueRequest {
  candidateSkills?: readonly string[];
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
}

export interface TriageQueue {
  /** Hydrated opportunity records, in triage order. */
  candidates: AdminRecord[];
  limit: number;
  offset: number;
  /** Undecided opportunities matching the preset, before paging. */
  total: number;
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

async function loadSqliteTriageQueue({
  filters,
  hydrateContext,
  limit,
  offset,
  search,
}: TriageQueueRequest & { hydrateContext: boolean; limit: number }) {
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
  const candidates = rows
    .map((row) => JSON.parse(JSON.stringify(row)) as AdminRecord)
    .filter((record) => {
      const review = getString(record, 'humanReviewStatus').toLowerCase();
      return (
        getString(record, 'status') !== 'archived' &&
        !DECISION_STATUSES.has(review) &&
        matchesTriageSearch(record, search) &&
        matchesOpportunity(record, filters, { hasSkill: () => false })
      );
    });
  const ordered = sortOpportunities(
    candidates,
    filters.sort,
    filters.sortDirection,
  );
  const total = ordered.length;
  const resolvedOffset = clampOffset(offset, total);
  const page = ordered.slice(resolvedOffset, resolvedOffset + limit);
  return {
    candidates: hydrateContext
      ? await attachOpportunityContext(page, { includeActivity: false })
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
  filters,
  hydrateContext = true,
  limit = TRIAGE_QUEUE_SIZE,
  offset = 0,
  search,
}: TriageQueueRequest): Promise<TriageQueue> {
  const preset = applyTriagePreset(filters);
  if (getDbConfig().type === 'sqlite') {
    return await loadSqliteTriageQueue({
      candidateSkills,
      filters: preset,
      hydrateContext,
      limit,
      offset,
      search,
    });
  }
  const query = {
    candidateSkills,
    filters: preset,
    reviewFilter: TRIAGE_REVIEW_FILTER,
    search: search?.trim() || undefined,
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
    ? await attachOpportunityContext(ordered, { includeActivity: false })
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
