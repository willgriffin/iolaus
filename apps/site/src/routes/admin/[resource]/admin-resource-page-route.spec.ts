import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  digDeeper: vi.fn(async () => ({ humanReviewStatus: 'maybe' })),
  review: vi.fn(async () => ({ status: 'reject' })),
  triageQueue: vi.fn(async () => ({ candidates: [], total: 0 })),
  verify: vi.fn(async () => ({ preflight: { state: 'live' } })),
}));

vi.mock('$lib/server/admin-resource-route', () => ({
  acceptFactCandidateAction: vi.fn(),
  acceptOpportunityAction: vi.fn(),
  applyInactiveOpportunitySweepAction: vi.fn(),
  bulkProcessOpportunitiesAction: vi.fn(),
  bulkProcessOpportunitiesWithLlmAction: vi.fn(),
  bulkReviewOpportunitiesAction: vi.fn(),
  crawlSourceNowAction: vi.fn(),
  createAdminResourceAction: vi.fn(),
  createDraftApplicationAction: vi.fn(),
  createFactIntakeAction: vi.fn(),
  deleteAdminResourceAction: vi.fn(),
  digDeeperOpportunityAction: mocks.digDeeper,
  loadAdminResourcePageShellData: vi.fn(),
  loadOpportunityDetailsAction: vi.fn(),
  previewInactiveOpportunitySweepAction: vi.fn(),
  processOpportunityAction: vi.fn(),
  processOpportunityWithLlmAction: vi.fn(),
  processRecommendationTaskAction: vi.fn(),
  reviewOpportunityAction: mocks.review,
  syncRecommendationTasksAction: vi.fn(),
  triageQueueAction: mocks.triageQueue,
  updateAdminResourceAction: vi.fn(),
  verifyOpportunityPostingAction: mocks.verify,
}));

function event() {
  return {
    locals: { user: { id: 'owner-1' } },
    params: { resource: 'opportunities' },
    request: new Request('http://localhost/admin/opportunities', {
      method: 'POST',
    }),
  };
}

/**
 * The triage deck is a modal over this list, so the queue read and both
 * verdicts are actions of the *list* route — the same owner-principal helpers
 * the list toolbar posts to, never a second, less audited write path.
 */
describe('admin resource route triage actions', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
  });

  it('serves the triage queue and both verdicts from the list route', async () => {
    const { actions } = await import('./+page.server');

    expect(Object.keys(actions)).toEqual(
      expect.arrayContaining([
        'digDeeper',
        'reviewOpportunity',
        'triageQueue',
        'verifyPosting',
      ]),
    );

    // The action signatures are structural here: the event carries only the
    // request and locals these three delegate.
    const input = event() as unknown as Parameters<
      typeof actions.triageQueue
    >[0];
    await actions.triageQueue(input);
    await actions.digDeeper(input);
    await actions.verifyPosting(input);

    expect(mocks.triageQueue).toHaveBeenCalledWith(input.request);
    expect(mocks.digDeeper).toHaveBeenCalledWith(input.request, input.locals);
    expect(mocks.verify).toHaveBeenCalledWith(input.request, input.locals);
    expect(input.locals.user?.id).toBe('owner-1');
  });
});
