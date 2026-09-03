import type { PrincipalRun } from '@happyvertical/smrt-agents';
import {
  createDataSurfaceActionAdapter,
  type DataSurfaceActionAdapter,
  type DataSurfaceActionAdapterOptions,
  type DataSurfaceActionEligibility,
  type DataSurfaceActionStateStore,
  type DataSurfaceServerActionDefinition,
  type DataSurfaceServerActionRequest,
  type ResolvedDataSurfaceActions,
  type ResolvedDataSurfaceSelection,
} from '@happyvertical/smrt-agents/server';

/**
 * The adapter passes an invocation to every action callback but does not
 * export its type; deriving it from the callback signature keeps this file
 * bound to the real contract rather than a hand-copied duplicate.
 */
type DataSurfaceActionInvocation = Parameters<
  DataSurfaceServerActionDefinition['eligible']
>[0];

import type {
  DataSurfaceDescriptor,
  DataSurfaceIdentity,
  DataSurfaceJsonValue,
  DataSurfaceRowId,
  DataSurfaceSelectionReference,
} from '@happyvertical/smrt-ui/data';
import {
  OPPORTUNITY_BULK_MAX_SELECTION_SIZE,
  OPPORTUNITY_BULK_PROCESS_LLM_TOOL,
  OPPORTUNITY_BULK_REVIEW_TOOL,
  OPPORTUNITY_BULK_WORKFLOW_IDS,
  OPPORTUNITY_DATA_SURFACE_IDENTITY,
} from '$lib/opportunity-bulk-workflows';
import type { OpportunityFilterState } from '$lib/opportunity-filters';
import {
  countOpportunityRecords,
  createOpportunityQueryFingerprint,
  listOpportunityMatchingIds,
  listOpportunityPageIds,
  listOpportunityRevisionsByIds,
  OPPORTUNITY_TABLE_PAGE_SIZE,
  type OpportunityMatchingRow,
  type OpportunityQuery,
} from './admin-opportunity-query.js';
import { updateOpportunityReview } from './application-package.js';
import {
  enqueueOpportunityIntelligenceWithStatus,
  OpportunityIntelligenceEnqueueError,
} from './opportunity-intelligence-job.js';
import { isOwnerAuthorityDenial } from './owner-principal.js';
import { getCollection } from './smrt.js';

/** Review dispositions a bulk review may set. */
const BULK_REVIEW_STATUSES = ['needs_input', 'maybe', 'apply', 'reject'];
/** An archived posting is a closed decision; re-reviewing it in bulk is a mistake. */
const ARCHIVED_STATUS = 'archived';
const MAX_REVIEW_NOTES_LENGTH = 2000;

/** The filter state and page a bulk request claims to have been issued from. */
export interface OpportunityBulkQueryTarget {
  candidateSkills: readonly string[];
  filters: OpportunityFilterState;
  page: number;
  reviewFilter: string;
  search?: string;
}

export interface OpportunityDataSurfaceOptions {
  state: DataSurfaceActionStateStore;
  /**
   * The filter state the caller claims. Supplied by the route from the
   * request body and validated against the fingerprint the caller returns, so
   * a mismatch is refused before any row is touched.
   */
  resolveQueryTarget(
    request: DataSurfaceServerActionRequest,
  ): OpportunityBulkQueryTarget;
  now?: () => number;
  createToken?: () => string;
  tokenTtlMs?: number;
  /**
   * The principal-entry seam. Production passes `executeAsPrincipal`, which
   * the adapter re-enters around each of preview and apply so authorization
   * and eligibility are re-checked at apply time rather than inherited from
   * the preview.
   */
  runAsPrincipal?: DataSurfaceActionAdapterOptions['runAsPrincipal'];
}

function toQuery(target: OpportunityBulkQueryTarget): OpportunityQuery {
  return {
    candidateSkills: target.candidateSkills,
    filters: target.filters,
    reviewFilter: target.reviewFilter,
    search: target.search,
  };
}

function rowIdList(rows: readonly OpportunityMatchingRow[]): string[] {
  return rows.map((row) => row.id);
}

/**
 * Per-request cache of the rows a selection resolved to.
 *
 * `eligible()` and `apply()` are called per row by the adapter, and both need
 * the row's current state and the revision the selection was resolved at.
 * Reading each row once per phase keeps a 500-row action to two passes rather
 * than two per row, and guarantees eligibility and application agree about
 * what they saw.
 */
interface RowSnapshot {
  humanRating: unknown;
  humanReviewNotes: string;
  humanReviewStatus: string;
  reviewedByProfileId: string;
  sourceContentFingerprint: string;
  status: string;
  updatedAt?: string;
}

const rowCaches = new WeakMap<
  DataSurfaceServerActionRequest,
  Map<string, RowSnapshot | null>
>();
const revisionByRequest = new WeakMap<
  DataSurfaceServerActionRequest,
  Map<string, string>
>();

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function loadRow(
  request: DataSurfaceServerActionRequest,
  rowId: DataSurfaceRowId,
): Promise<RowSnapshot | null> {
  let cache = rowCaches.get(request);
  if (!cache) {
    cache = new Map();
    rowCaches.set(request, cache);
  }
  const key = String(rowId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const collection = await getCollection('Opportunity');
  const row = (await collection.get(key)) as Record<string, unknown> | null;
  const snapshot: RowSnapshot | null = row
    ? {
        humanRating: row.humanRating,
        humanReviewNotes: stringOf(row.humanReviewNotes),
        humanReviewStatus: stringOf(row.humanReviewStatus),
        reviewedByProfileId: stringOf(row.reviewedByProfileId),
        sourceContentFingerprint: stringOf(row.sourceContentFingerprint),
        status: stringOf(row.status),
        updatedAt: revisionByRequest.get(request)?.get(key),
      }
    : null;
  cache.set(key, snapshot);
  return snapshot;
}

function reviewPayload(payload: DataSurfaceJsonValue | undefined): {
  humanRating?: unknown;
  humanReviewNotes?: string;
  humanReviewStatus: string;
  reviewedByProfileId?: string;
} | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const humanReviewStatus = stringOf(record.humanReviewStatus);
  if (!BULK_REVIEW_STATUSES.includes(humanReviewStatus)) return null;

  const rating = record.humanRating;
  if (
    rating !== undefined &&
    rating !== null &&
    (typeof rating !== 'number' ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 10)
  ) {
    return null;
  }

  const notes = record.humanReviewNotes;
  if (notes !== undefined && typeof notes !== 'string') return null;
  if (typeof notes === 'string' && notes.length > MAX_REVIEW_NOTES_LENGTH) {
    return null;
  }

  const reviewedByProfileId = record.reviewedByProfileId;
  if (
    reviewedByProfileId !== undefined &&
    typeof reviewedByProfileId !== 'string'
  ) {
    return null;
  }

  return {
    humanRating: rating,
    humanReviewNotes: typeof notes === 'string' ? notes : undefined,
    humanReviewStatus,
    reviewedByProfileId:
      typeof reviewedByProfileId === 'string' ? reviewedByProfileId : undefined,
  };
}

const REVIEW_INPUT_SCHEMA = {
  type: 'object',
  required: ['humanReviewStatus'],
  additionalProperties: false,
  properties: {
    humanReviewStatus: { type: 'string', enum: [...BULK_REVIEW_STATUSES] },
    humanRating: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
    humanReviewNotes: { type: 'string', maxLength: MAX_REVIEW_NOTES_LENGTH },
    reviewedByProfileId: { type: 'string' },
  },
} as const;

function opportunityDescriptor(): DataSurfaceDescriptor {
  return {
    version: 1,
    identity: OPPORTUNITY_DATA_SURFACE_IDENTITY,
    schemaVersion: 1,
    label: 'Opportunities',
    description: 'Job postings under review.',
    rowKey: 'id',
    columns: [
      {
        id: 'id',
        label: 'Id',
        capabilities: ['read'],
        role: 'row-key',
        fieldName: 'id',
      },
      {
        id: 'title',
        label: 'Title',
        capabilities: ['read', 'project'],
        fieldName: 'title',
      },
      {
        id: 'companyId',
        label: 'Company',
        capabilities: ['read', 'project'],
        fieldName: 'companyId',
      },
      {
        id: 'status',
        label: 'Status',
        capabilities: ['read', 'project'],
        role: 'status',
        fieldName: 'status',
      },
      {
        id: 'humanReviewStatus',
        label: 'Review',
        capabilities: ['read', 'project'],
        role: 'status',
        fieldName: 'humanReviewStatus',
        sensitivity: 'personal',
      },
      {
        id: 'humanRating',
        label: 'Rating',
        capabilities: ['read', 'project'],
        fieldName: 'humanRating',
        sensitivity: 'personal',
      },
      {
        id: 'score',
        label: 'Score',
        capabilities: ['read', 'project'],
        role: 'computed',
      },
    ],
    query: {
      modes: ['rows', 'count'],
      projectableColumnIds: [
        'title',
        'companyId',
        'status',
        'humanReviewStatus',
        'humanRating',
        'score',
      ],
    },
    controls: [],
    actions: [
      {
        id: OPPORTUNITY_BULK_WORKFLOW_IDS.review,
        label: 'Set review decision',
        description:
          'Record a human review disposition on every selected opportunity.',
        sensitivity: 'sensitive',
        selectionScopes: ['explicit-ids', 'current-page', 'all-matching'],
        requiresConfirmation: true,
        columnIds: ['humanReviewStatus', 'humanRating'],
      },
      {
        id: OPPORTUNITY_BULK_WORKFLOW_IDS.processWithLlm,
        label: 'Process with LLM',
        description:
          'Queue opportunity intelligence for every selected opportunity.',
        sensitivity: 'public',
        selectionScopes: ['explicit-ids', 'current-page', 'all-matching'],
        requiresConfirmation: true,
        columnIds: ['status'],
      },
    ],
    limits: {
      maxQueryRows: OPPORTUNITY_TABLE_PAGE_SIZE,
      maxQueryBytes: 1_000_000,
      maxSelectionSize: OPPORTUNITY_BULK_MAX_SELECTION_SIZE,
    },
  };
}

/**
 * Create the opportunity bulk-action adapter.
 *
 * Selection resolution is the security-relevant part. Browser-supplied ids
 * are only ever hints: `current-page` and `all-matching` are both re-derived
 * from the caller's filter state on the server, and that filter state is
 * itself checked against the fingerprint the page was rendered under. An
 * action therefore applies to the rows the operator's filters describe *now*,
 * or it is refused -- it never applies to a set assembled in the browser.
 */
export function createOpportunityDataSurfaceAdapter(
  options: OpportunityDataSurfaceOptions,
): DataSurfaceActionAdapter {
  const reviewAction: DataSurfaceServerActionDefinition = {
    descriptor: opportunityDescriptor().actions[0],
    inputSchema: REVIEW_INPUT_SCHEMA as never,
    validatePayload: (payload) =>
      reviewPayload(payload)
        ? { valid: true }
        : {
            valid: false,
            reason: 'A valid review disposition is required.',
          },
    confirmation: 'required',
    execution: 'foreground',
    tool: OPPORTUNITY_BULK_REVIEW_TOOL,
    operation: {
      id: 'opportunities:update',
      collection: 'opportunities',
      action: 'update',
    },
    authorize: () => true,
    eligible: async (invocation, rowId) => eligibleForReview(invocation, rowId),
    apply: async (invocation, rowId) => {
      const payload = reviewPayload(invocation.request.payload);
      if (!payload) return undefined;
      const row = await loadRow(invocation.request, rowId);
      // The selection resolved no revision for this row, so it did not exist
      // when the set was built. If it exists now it is a different row than
      // the operator confirmed, and there is nothing to pin the write to.
      if (row && !row.updatedAt) {
        throw new OpportunitySelectionError('row_revision_drifted');
      }
      const record = await updateOpportunityReview({
        // Pin the write to the revision the selection resolved at, so a row
        // edited since then fails rather than losing the newer value.
        expectedUpdatedAt: row?.updatedAt,
        // Rating, notes, and reviewer carry over when the caller omits them:
        // a bulk disposition change must not silently erase an existing
        // rating or note that the operator never mentioned.
        humanRating:
          payload.humanRating === undefined
            ? row?.humanRating
            : payload.humanRating,
        humanReviewNotes: payload.humanReviewNotes ?? row?.humanReviewNotes,
        humanReviewStatus: payload.humanReviewStatus,
        opportunityId: String(rowId),
        reviewedByProfileId:
          payload.reviewedByProfileId ?? row?.reviewedByProfileId,
        user: { id: invocation.run.context.userId ?? undefined },
      });
      return {
        humanReviewStatus: stringOf(
          (record as Record<string, unknown>).humanReviewStatus,
        ),
      };
    },
  };

  const processWithLlmAction: DataSurfaceServerActionDefinition = {
    descriptor: opportunityDescriptor().actions[1],
    inputSchema: null,
    validatePayload: (payload) =>
      payload === undefined || payload === null
        ? { valid: true }
        : { valid: false, reason: 'This action takes no arguments.' },
    confirmation: 'required',
    execution: 'foreground',
    tool: OPPORTUNITY_BULK_PROCESS_LLM_TOOL,
    operation: {
      id: 'opportunities:update',
      collection: 'opportunities',
      action: 'update',
    },
    authorize: () => true,
    eligible: async (invocation, rowId) => {
      const row = await loadRow(invocation.request, rowId);
      if (!row) return { eligible: false, reason: 'not_found' };
      if (row.status === ARCHIVED_STATUS) {
        return { eligible: false, reason: 'invalid_status_transition' };
      }
      // Intelligence reads the stored posting content; without a fingerprint
      // there is nothing to analyse and the job would only fail later.
      if (!row.sourceContentFingerprint) {
        return { eligible: false, reason: 'posting_content_missing' };
      }
      return { eligible: true };
    },
    // Foreground is correct despite the work being expensive: this only
    // inserts durable, idempotent intelligence jobs. The analysis itself
    // already runs in the jobs worker, so there is nothing left to defer.
    apply: async (invocation, rowId) => {
      const result = await enqueueOpportunityIntelligenceWithStatus(
        String(rowId),
        {},
        // The form action this replaces attributed each job to the operator.
        // Without it every bulk-queued job records an empty
        // `initiatedByUserId`, and the batch's own audit line cannot restore
        // per-job attribution after the fact.
        { user: { id: invocation.run.context.userId ?? undefined } },
      );
      // A row that already has an active job queued nothing. The adapter
      // classifies every normal return as `accepted`, so reporting this as a
      // value would count it as applied and hide it from the operator's
      // summary; raising it instead produces a real per-row outcome carrying
      // `already_queued`.
      if (!result.enqueued) {
        throw new OpportunitySelectionError('already_queued');
      }
      return { enqueued: true };
    },
  };

  async function eligibleForReview(
    invocation: DataSurfaceActionInvocation,
    rowId: DataSurfaceRowId,
  ): Promise<DataSurfaceActionEligibility> {
    const row = await loadRow(invocation.request, rowId);
    if (!row) return { eligible: false, reason: 'not_found' };
    if (row.status === ARCHIVED_STATUS) {
      return { eligible: false, reason: 'invalid_status_transition' };
    }
    return { eligible: true };
  }

  const actions: Record<string, DataSurfaceServerActionDefinition> = {
    [OPPORTUNITY_BULK_WORKFLOW_IDS.review]: reviewAction,
    [OPPORTUNITY_BULK_WORKFLOW_IDS.processWithLlm]: processWithLlmAction,
  };

  async function resolveSurface(
    _run: PrincipalRun,
    _identity: DataSurfaceIdentity,
  ): Promise<ResolvedDataSurfaceActions> {
    return { descriptor: opportunityDescriptor(), revision: 0, actions };
  }

  async function resolveSelection(
    invocation: Omit<DataSurfaceActionInvocation, 'selection'>,
    selection: DataSurfaceSelectionReference,
  ): Promise<ResolvedDataSurfaceSelection> {
    const target = options.resolveQueryTarget(invocation.request);
    const query = toQuery(target);
    const queryFingerprint = createOpportunityQueryFingerprint(query);

    const rows = await resolveRows(selection, target, query, queryFingerprint);
    // Remember each row's revision for this request so apply() can pin its
    // write to the row as it was when the selection was resolved.
    const revisions = new Map<string, string>();
    for (const row of rows) revisions.set(row.id, row.updatedAt);
    revisionByRequest.set(invocation.request, revisions);
    rowCaches.delete(invocation.request);

    return {
      revision: 0,
      queryFingerprint,
      rowIds: rowIdList(rows),
    };
  }

  async function resolveRows(
    selection: DataSurfaceSelectionReference,
    target: OpportunityBulkQueryTarget,
    query: OpportunityQuery,
    queryFingerprint: string,
  ): Promise<OpportunityMatchingRow[]> {
    if (selection.scope === 'explicit-ids') {
      const ids = [
        ...new Set(
          selection.rowIds.map((rowId) => String(rowId)).filter(Boolean),
        ),
      ];
      if (ids.length > OPPORTUNITY_BULK_MAX_SELECTION_SIZE) {
        throw new OpportunitySelectionError('limit_exceeded');
      }
      // The ids name the rows; their revisions still come from the database,
      // never from the browser. Looked up directly rather than intersected
      // with the filter query, whose own result is capped -- an explicit
      // selection must not lose rows just because the filter matches more
      // than the cap.
      const known = new Map(
        (await listOpportunityRevisionsByIds(ids)).map((row) => [
          row.id,
          row.updatedAt,
        ]),
      );
      // Keep an id the lookup did not find. Dropping it here would shrink the
      // batch silently, because the adapter only reports outcomes for rows the
      // selection resolved; carried through, `eligible()` fails to load it and
      // reports `not_found`, which is the documented per-row outcome. It
      // carries no revision, so it can never be written unguarded.
      return ids.map((id) => ({ id, updatedAt: known.get(id) ?? '' }));
    }

    if (selection.scope === 'current-page') {
      // Re-derived from the filter state and page number, so the rows are the
      // ones that page holds now, not the ones the browser last rendered.
      const page = Math.max(1, Math.trunc(target.page) || 1);
      const pageIds = await listOpportunityPageIds({
        ...query,
        limit: OPPORTUNITY_TABLE_PAGE_SIZE,
        offset: (page - 1) * OPPORTUNITY_TABLE_PAGE_SIZE,
      });
      return await listOpportunityRevisionsByIds(pageIds);
    }

    // all-matching
    if (selection.queryFingerprint !== queryFingerprint) {
      throw new OpportunitySelectionError('stale_query_fingerprint');
    }
    const total = await countOpportunityRecords(query);
    if (total > OPPORTUNITY_BULK_MAX_SELECTION_SIZE) {
      throw new OpportunitySelectionError('limit_exceeded');
    }
    const rows = await listOpportunityMatchingIds(query, {
      limit: OPPORTUNITY_BULK_MAX_SELECTION_SIZE + 1,
    });
    if (rows.length > OPPORTUNITY_BULK_MAX_SELECTION_SIZE) {
      throw new OpportunitySelectionError('limit_exceeded');
    }
    if (rows.length !== total) {
      // The set changed between the count and the listing, so neither
      // describes what the operator confirmed.
      throw new OpportunitySelectionError('matching_count_drifted');
    }
    return rows;
  }

  return createDataSurfaceActionAdapter({
    resolveSurface,
    resolveSelection,
    state: options.state,
    now: options.now,
    createToken: options.createToken,
    tokenTtlMs: options.tokenTtlMs,
    runAsPrincipal: options.runAsPrincipal,
    /**
     * The filter state is part of the decision the operator confirmed, so it
     * must participate in the confirmation and idempotency fingerprints. Two
     * applies with the same action and arguments but different filters are
     * different decisions and must not share a confirmation or an
     * idempotency key.
     */
    requestFingerprintExtension: (request) => {
      const target = options.resolveQueryTarget(request);
      return {
        queryFingerprint: createOpportunityQueryFingerprint(toQuery(target)),
        page: target.page,
      };
    },
    mapError: (error) => {
      if (error instanceof OpportunitySelectionError) return error.reason;
      if (error instanceof OpportunityIntelligenceEnqueueError) {
        return error.code;
      }
      if (isOwnerAuthorityDenial(error)) return 'denied';
      if (isRevisionConflict(error)) return 'row_revision_drifted';
      if (isNotFound(error)) return 'not_found';
      return undefined;
    },
  });
}

/** A selection the server refuses to resolve, with the reason to report. */
export class OpportunitySelectionError extends Error {
  reason: string;

  constructor(reason: string) {
    super(`Opportunity selection refused: ${reason}`);
    this.name = 'OpportunitySelectionError';
    this.reason = reason;
  }
}

function isRevisionConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'RUNTIME_REVISION_CONFLICT'
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}
