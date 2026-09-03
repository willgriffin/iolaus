import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureCompanyResearch: vi.fn(async () => ({
    careersSourceCreated: true,
    careersSourceId: 'src-1',
    companyId: 'co-1',
    researchTaskId: 'task-1',
  })),
  enqueueIntelligence: vi.fn(async () => ({
    enqueued: true,
    job: { id: 'job-1' },
  })),
  get: vi.fn(
    async (): Promise<Record<string, unknown> | null> => ({
      companyId: 'co-1',
      humanRating: 7,
      humanReviewNotes: 'Existing note.',
      id: 'opp-1',
      title: 'Staff platform engineer',
    }),
  ),
  latestPreflight: vi.fn(
    async (): Promise<{
      checkedAt: string | null;
      reason: string;
      state: string;
    }> => ({
      checkedAt: null,
      reason: '',
      state: 'never_preflighted',
    }),
  ),
  updateReview: vi.fn(async () => ({ id: 'opp-1' })),
  verify: vi.fn(async () => ({
    opportunityId: 'opp-1',
    preflight: { checkedAt: null, reason: 'http_ok', state: 'live' },
  })),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({ get: mocks.get })),
}));

vi.mock('./application-package.js', () => ({
  updateOpportunityReview: mocks.updateReview,
}));

vi.mock('./opportunity-intelligence-job.js', () => ({
  enqueueOpportunityIntelligenceWithStatus: mocks.enqueueIntelligence,
}));

vi.mock('./job-search-webmcp.js', () => ({
  verifyJobPosting: mocks.verify,
}));

vi.mock('./posting-preflight-status.js', () => ({
  latestPostingPreflightStatus: mocks.latestPreflight,
}));

vi.mock('./application-workflow.js', () => ({
  ensureCompanyResearch: mocks.ensureCompanyResearch,
}));

async function digDeeper(overrides: Record<string, unknown> = {}) {
  const { digDeeperOnOpportunity } = await import('./opportunity-deep-dive');
  return await digDeeperOnOpportunity({
    opportunityId: 'opp-1',
    user: { id: 'owner-1' },
    ...overrides,
  });
}

describe('digDeeperOnOpportunity', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
  });

  it('records the maybe verdict and queues all three follow-ups', async () => {
    const result = await digDeeper();

    expect(mocks.updateReview).toHaveBeenCalledWith(
      expect.objectContaining({
        humanReviewStatus: 'maybe',
        opportunityId: 'opp-1',
      }),
    );
    expect(mocks.enqueueIntelligence).toHaveBeenCalledWith(
      'opp-1',
      { modes: 'all' },
      expect.objectContaining({ reason: 'triage_dig_deeper' }),
    );
    expect(mocks.verify).toHaveBeenCalledWith(
      { opportunityId: 'opp-1' },
      { id: 'owner-1' },
    );
    expect(mocks.ensureCompanyResearch).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'co-1', opportunityId: 'opp-1' }),
    );
    expect(result.humanReviewStatus).toBe('maybe');
    expect(result.steps.map((step) => step.name)).toEqual([
      'intelligence',
      'verify',
      'research',
    ]);
    expect(result.steps.every((step) => step.status === 'queued')).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.preflight).toMatchObject({ state: 'live' });
  });

  it('keeps the verdict when every follow-up step fails', async () => {
    // The operator swiped right: that decision is recorded truth. Losing it
    // because a queue was unreachable would silently re-serve the card.
    mocks.enqueueIntelligence.mockRejectedValueOnce(new Error('queue down'));
    mocks.verify.mockRejectedValueOnce(new Error('fetch failed'));
    mocks.ensureCompanyResearch.mockRejectedValueOnce(new Error('no company'));

    const result = await digDeeper();

    expect(mocks.updateReview).toHaveBeenCalledTimes(1);
    expect(result.humanReviewStatus).toBe('maybe');
    expect(result.failed.map((step) => step.name)).toEqual([
      'intelligence',
      'verify',
      'research',
    ]);
    expect(result.failed.map((step) => step.message)).toEqual([
      'queue down',
      'fetch failed',
      'no company',
    ]);
    // A later step still runs after an earlier one failed.
    expect(mocks.ensureCompanyResearch).toHaveBeenCalledTimes(1);
    expect(result.preflight).toBeNull();
  });

  it('reports an already-queued intelligence job as queued, not as new work', async () => {
    mocks.enqueueIntelligence.mockResolvedValueOnce({
      enqueued: false,
      job: { id: 'job-9' },
    });

    const [intelligence] = (await digDeeper()).steps;

    expect(intelligence.status).toBe('queued');
    expect(intelligence.message).toContain('already queued as job job-9');
  });

  it('skips company research when no company is linked yet', async () => {
    mocks.get.mockResolvedValueOnce({ id: 'opp-2', title: 'Backend' });

    const result = await digDeeper({ opportunityId: 'opp-2' });

    expect(mocks.ensureCompanyResearch).not.toHaveBeenCalled();
    expect(result.steps.at(-1)).toMatchObject({
      name: 'research',
      status: 'skipped',
    });
    expect(result.failed).toEqual([]);
  });

  it('keeps the notes and rating already on the record when none are supplied', async () => {
    await digDeeper();

    expect(mocks.updateReview).toHaveBeenCalledWith(
      expect.objectContaining({
        humanRating: 7,
        humanReviewNotes: 'Existing note.',
      }),
    );
  });

  it('overwrites the notes when the caller supplies them, empty included', async () => {
    await digDeeper({ humanReviewNotes: '' });

    expect(mocks.updateReview).toHaveBeenCalledWith(
      expect.objectContaining({ humanReviewNotes: '' }),
    );
  });

  it('refuses an unknown opportunity before writing anything', async () => {
    mocks.get.mockResolvedValueOnce(null);

    await expect(digDeeper({ opportunityId: 'missing' })).rejects.toMatchObject(
      { status: 404 },
    );
    expect(mocks.updateReview).not.toHaveBeenCalled();
  });

  it('refuses an empty opportunity id', async () => {
    await expect(digDeeper({ opportunityId: '  ' })).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.updateReview).not.toHaveBeenCalled();
  });
});

/**
 * The posting check is the only step that leaves this system on the request
 * path. Keyboard triage can put several right swipes per second through it, and
 * a backlog is often several roles at one employer.
 */
describe('digDeeperOnOpportunity posting-check throttle', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
  });

  it('reuses a recorded verdict that is still fresh instead of refetching', async () => {
    mocks.latestPreflight.mockResolvedValueOnce({
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      reason: 'http_ok',
      state: 'live',
    });

    const result = await digDeeper();

    expect(mocks.verify).not.toHaveBeenCalled();
    const verify = result.steps.find((entry) => entry.name === 'verify');
    expect(verify?.status).toBe('recent');
    expect(verify?.message).toContain('reused');
    // The card still shows a verdict — the reused one.
    expect(result.preflight).toMatchObject({ state: 'live' });
    expect(result.failed).toHaveLength(0);
    // The verdict and the other follow-ups are untouched by the throttle.
    expect(result.humanReviewStatus).toBe('maybe');
    expect(mocks.enqueueIntelligence).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCompanyResearch).toHaveBeenCalledTimes(1);
  });

  it('runs a fresh check once the recorded one has aged out', async () => {
    const { DEEP_DIVE_PREFLIGHT_MAX_AGE_MS } = await import(
      './opportunity-deep-dive'
    );
    mocks.latestPreflight.mockResolvedValueOnce({
      checkedAt: new Date(
        Date.now() - DEEP_DIVE_PREFLIGHT_MAX_AGE_MS - 1000,
      ).toISOString(),
      reason: 'http_ok',
      state: 'live',
    });

    const result = await digDeeper();

    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(result.steps.find((entry) => entry.name === 'verify')?.status).toBe(
      'queued',
    );
  });

  it('runs a check when nothing usable is recorded', async () => {
    // A never-checked posting, and one whose recorded run carries no usable
    // timestamp, both have to be checked rather than silently trusted.
    await digDeeper();
    expect(mocks.verify).toHaveBeenCalledTimes(1);

    mocks.verify.mockClear();
    mocks.latestPreflight.mockResolvedValueOnce({
      checkedAt: null,
      reason: 'http_ok',
      state: 'live',
    });
    await digDeeper();
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });
});
