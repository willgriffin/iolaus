import type { AdminRecord } from '$lib/admin/dock';
import {
  filterStateFromSearchParams,
  type OpportunityFilterState,
} from '$lib/opportunity-filters';
import { listAdminRecords, requireAdminResource } from './admin-data';
import {
  countOpportunityRecords,
  discoveryMatchForRecord,
  listCurrentDiscoveryMatches,
  listOpportunityPageIds,
  type WorkspaceOpportunityQuery,
} from './admin-opportunity-query';
import { attachOpportunityDiscoveryContext } from './admin-resource-route';
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
  const queueFilters =
    context === 'agent' ? applyTriagePreset(filters) : filters;
  const query: WorkspaceOpportunityQuery = {
    candidateSkills,
    currentQualified: true,
    filters: queueFilters,
    reviewFilter: TRIAGE_REVIEW_FILTER,
    search: search?.trim() || undefined,
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
  if (hydrateContext) {
    const candidates = await attachOpportunityDiscoveryContext(
      ordered,
      subject,
    );
    return { candidates, limit, offset: resolvedOffset, total };
  }
  const matches = await listCurrentDiscoveryMatches(ids, subject);
  const candidates = ordered.flatMap((record) => {
    const match = discoveryMatchForRecord(matches, record);
    return match
      ? [
          {
            ...record,
            discoveryMatchStatus: match.status,
            discoveryMatchScore: match.score,
            discoveryMatchReasons: match.reasons,
          },
        ]
      : [];
  });

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
