import { InMemoryDataSurfaceActionStateStore } from '@happyvertical/smrt-agents/server';
import type { DataSurfaceActionRequest } from '@happyvertical/smrt-ui/data';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPPORTUNITY_BULK_MAX_SELECTION_SIZE,
  OPPORTUNITY_BULK_WORKFLOW_IDS,
  OPPORTUNITY_DATA_SURFACE_IDENTITY,
} from '$lib/opportunity-bulk-workflows';
import { DEFAULT_OPPORTUNITY_FILTERS } from '$lib/opportunity-filters';

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  enqueue: vi.fn(),
  fingerprint: vi.fn(),
  getOpportunity: vi.fn(),
  matchingIds: vi.fn(),
  pageIds: vi.fn(),
  revisionsByIds: vi.fn(),
  updateReview: vi.fn(),
}));

vi.mock('./admin-opportunity-query.js', () => ({
  countOpportunityRecords: mocks.count,
  createOpportunityQueryFingerprint: mocks.fingerprint,
  listOpportunityMatchingIds: mocks.matchingIds,
  listOpportunityPageIds: mocks.pageIds,
  listOpportunityRevisionsByIds: mocks.revisionsByIds,
  OPPORTUNITY_TABLE_PAGE_SIZE: 100,
}));

vi.mock('./application-package.js', () => ({
  updateOpportunityReview: mocks.updateReview,
}));

class FakeEnqueueError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = 'OpportunityIntelligenceEnqueueError';
    this.code = code;
  }
}

vi.mock('./opportunity-intelligence-job.js', () => ({
  enqueueOpportunityIntelligenceWithStatus: mocks.enqueue,
  OpportunityIntelligenceEnqueueError: FakeEnqueueError,
}));

vi.mock('./owner-principal.js', () => ({
  isOwnerAuthorityDenial: () => false,
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({ get: mocks.getOpportunity })),
}));

const QUERY_FINGERPRINT = 'query-fp';

// The shape the adapter snapshots: ExecuteAsPrincipalOptions, whose own
// `principal` is the binding carrying the fail-closed tool allow-list.
const principal = {
  agentClass: 'iolaus.localhost/owner',
  onBehalfOfUserId: 'user-1',
  permissions: [],
  principal: {
    runAsUserId: 'user-1',
    allowedTools: ['opportunity_bulk_review', 'opportunity_bulk_process_llm'],
  },
} as never;

/**
 * The adapter enters a principal itself. Stubbing that seam keeps these tests
 * about selection resolution and per-row outcomes, which is where this
 * module's own logic lives; the authority wiring is covered by the route spec
 * and owner-principal.spec.
 */
function principalStub() {
  return async (_options: unknown, fn: (run: unknown) => Promise<unknown>) =>
    await fn({
      assertToolAllowed: () => undefined,
      assertOperation: async () => ({ allowed: true }),
      context: { userId: 'user-1' },
      permissions: [],
      allowedTools: [],
    });
}

async function createAdapter(overrides: Record<string, unknown> = {}) {
  const { createOpportunityDataSurfaceAdapter } = await import(
    './opportunity-data-surface-actions.js'
  );
  return createOpportunityDataSurfaceAdapter({
    state: new InMemoryDataSurfaceActionStateStore(),
    resolveQueryTarget: () => ({
      candidateSkills: [],
      filters: DEFAULT_OPPORTUNITY_FILTERS,
      page: 1,
      reviewFilter: 'unsorted',
    }),
    runAsPrincipal: principalStub(),
    ...overrides,
  } as never);
}

function request(
  overrides: Partial<DataSurfaceActionRequest> & Record<string, unknown> = {},
): never {
  return {
    version: 1,
    requestId: 'req-1',
    identity: OPPORTUNITY_DATA_SURFACE_IDENTITY,
    actionId: OPPORTUNITY_BULK_WORKFLOW_IDS.review,
    phase: 'preview',
    expectedRevision: 0,
    selection: { scope: 'explicit-ids', rowIds: ['opp-1'] },
    payload: { humanReviewStatus: 'apply' },
    ...overrides,
  } as never;
}

function openRow(overrides: Record<string, unknown> = {}) {
  return {
    humanRating: 7,
    humanReviewNotes: 'existing note',
    humanReviewStatus: 'needs_input',
    reviewedByProfileId: 'profile-1',
    sourceContentFingerprint: 'fp-1',
    status: 'found',
    ...overrides,
  };
}

describe('opportunity data-surface actions', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.fingerprint.mockReturnValue(QUERY_FINGERPRINT);
    mocks.revisionsByIds.mockResolvedValue([
      { id: 'opp-1', updatedAt: '2026-09-02T08:00:00.000Z' },
    ]);
    mocks.getOpportunity.mockResolvedValue(openRow());
    mocks.updateReview.mockResolvedValue({ humanReviewStatus: 'apply' });
    mocks.enqueue.mockResolvedValue({ enqueued: true, job: {} });
  });

  // A selection the server will not resolve is not an action outcome -- there
  // is no set to report per-row results for -- so it is raised out of
  // resolveSelection and mapped to a refusal by the transport.
  it('refuses an all-matching selection whose filters have drifted', async () => {
    const { OpportunitySelectionError } = await import(
      './opportunity-data-surface-actions.js'
    );
    const adapter = await createAdapter();

    await expect(
      adapter.preview(
        request({
          selection: { scope: 'all-matching', queryFingerprint: 'stale-fp' },
        }),
        { principal },
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        constructor: OpportunitySelectionError,
        reason: 'stale_query_fingerprint',
      }) as never,
    );
    expect(mocks.updateReview).not.toHaveBeenCalled();
  });

  it('refuses an all-matching selection larger than the cap', async () => {
    mocks.count.mockResolvedValue(OPPORTUNITY_BULK_MAX_SELECTION_SIZE + 1);
    const adapter = await createAdapter();

    await expect(
      adapter.preview(
        request({
          selection: {
            scope: 'all-matching',
            queryFingerprint: QUERY_FINGERPRINT,
          },
        }),
        { principal },
      ),
    ).rejects.toMatchObject({ reason: 'limit_exceeded' });
    // Refused on the count alone, without listing half a table first.
    expect(mocks.matchingIds).not.toHaveBeenCalled();
  });

  it('refuses when the matching set changes between count and listing', async () => {
    mocks.count.mockResolvedValue(3);
    mocks.matchingIds.mockResolvedValue([
      { id: 'opp-1', updatedAt: '2026-09-02T08:00:00.000Z' },
      { id: 'opp-2', updatedAt: '2026-09-02T08:00:00.000Z' },
    ]);
    const adapter = await createAdapter();

    await expect(
      adapter.preview(
        request({
          selection: {
            scope: 'all-matching',
            queryFingerprint: QUERY_FINGERPRINT,
          },
        }),
        { principal },
      ),
    ).rejects.toMatchObject({ reason: 'matching_count_drifted' });
  });

  it('resolves explicit ids directly rather than through the capped filter query', async () => {
    const adapter = await createAdapter();

    const result = await adapter.preview(request(), { principal });

    expect(result.ok).toBe(true);
    expect(mocks.revisionsByIds).toHaveBeenCalledWith(['opp-1']);
    // An explicit selection must not be bounded by how many rows the current
    // filter happens to match.
    expect(mocks.matchingIds).not.toHaveBeenCalled();
  });

  it('reports an explicit id that no longer exists as not_found', async () => {
    // The lookup returns nothing for a deleted row. Dropping it from the
    // resolved set would shrink the batch silently, because the adapter only
    // reports outcomes for rows the selection resolved.
    mocks.revisionsByIds.mockResolvedValue([]);
    mocks.getOpportunity.mockResolvedValue(null);
    const adapter = await createAdapter();

    const result = await adapter.preview(request(), { principal });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.details)).toContain('not_found');
  });

  it('re-derives the current page from the filter state, not the browser', async () => {
    mocks.pageIds.mockResolvedValue(['opp-1']);
    const adapter = await createAdapter();

    await adapter.preview(request({ selection: { scope: 'current-page' } }), {
      principal,
    });

    expect(mocks.pageIds).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 0 }),
    );
    expect(mocks.revisionsByIds).toHaveBeenCalledWith(['opp-1']);
  });

  it('rejects a review payload with an unknown disposition', async () => {
    const adapter = await createAdapter();

    const result = await adapter.preview(
      request({ payload: { humanReviewStatus: 'archived' } }),
      { principal },
    );

    expect(result.ok).toBe(false);
  });

  it('skips an archived row rather than re-reviewing a closed decision', async () => {
    mocks.getOpportunity.mockResolvedValue(openRow({ status: 'archived' }));
    const adapter = await createAdapter();

    const result = await adapter.preview(request(), { principal });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.details)).toContain(
      'invalid_status_transition',
    );
  });

  it('skips an LLM row with no stored posting content', async () => {
    mocks.getOpportunity.mockResolvedValue(
      openRow({ sourceContentFingerprint: '' }),
    );
    const adapter = await createAdapter();

    const result = await adapter.preview(
      request({
        actionId: OPPORTUNITY_BULK_WORKFLOW_IDS.processWithLlm,
        payload: undefined,
      }),
      { principal },
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.details)).toContain('posting_content_missing');
  });

  it('carries over rating, notes, and reviewer the caller did not mention', async () => {
    const adapter = await createAdapter();
    const preview = await adapter.preview(request(), { principal });

    await adapter.apply(
      request({
        phase: 'apply',
        confirmationToken: preview.confirmationToken,
        idempotencyKey: 'key-1',
      }),
      { principal },
    );

    expect(mocks.updateReview).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: '2026-09-02T08:00:00.000Z',
        humanRating: 7,
        humanReviewNotes: 'existing note',
        humanReviewStatus: 'apply',
        reviewedByProfileId: 'profile-1',
      }),
    );
  });

  it('requires a confirmation from a preview before applying', async () => {
    const adapter = await createAdapter();

    const result = await adapter.apply(
      request({ phase: 'apply', idempotencyKey: 'key-1' }),
      { principal },
    );

    expect(result.ok).toBe(false);
    expect(mocks.updateReview).not.toHaveBeenCalled();
  });

  it('reports an already-queued LLM row instead of enqueuing twice', async () => {
    mocks.enqueue.mockResolvedValue({ enqueued: false, job: {} });
    const adapter = await createAdapter();
    const llmRequest = {
      actionId: OPPORTUNITY_BULK_WORKFLOW_IDS.processWithLlm,
      payload: undefined,
    };
    const preview = await adapter.preview(request(llmRequest), { principal });

    const result = await adapter.apply(
      request({
        ...llmRequest,
        phase: 'apply',
        confirmationToken: preview.confirmationToken,
        idempotencyKey: 'key-2',
      }),
      { principal },
    );

    expect(result.ok).toBe(true);
    // It must not count as applied: the adapter classifies every normal
    // return as accepted, so an already-queued row reported as a value would
    // be indistinguishable from one this batch actually queued.
    expect(result.details).toMatchObject({ accepted: 0, failed: 1 });
    expect(JSON.stringify(result.details)).toContain('already_queued');
  });

  it('attributes each queued LLM job to the acting operator', async () => {
    mocks.enqueue.mockResolvedValue({ enqueued: true, job: { id: 'job-1' } });
    const adapter = await createAdapter();
    const llmRequest = {
      actionId: OPPORTUNITY_BULK_WORKFLOW_IDS.processWithLlm,
      payload: undefined,
    };
    const preview = await adapter.preview(request(llmRequest), { principal });

    await adapter.apply(
      request({
        ...llmRequest,
        phase: 'apply',
        confirmationToken: preview.confirmationToken,
        idempotencyKey: 'key-attribution',
      }),
      { principal },
    );

    // Without this the job records an empty initiatedByUserId and the batch
    // audit cannot restore per-job attribution.
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      {},
      { user: { id: 'user-1' } },
    );
  });
});
