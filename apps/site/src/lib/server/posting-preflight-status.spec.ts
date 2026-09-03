import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(async (_options?: Record<string, unknown>) => [] as unknown[]),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    if (className !== 'AgentRun') throw new Error(`Unexpected ${className}`);
    return { list: mocks.list };
  }),
}));

function run(
  output: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'run-1',
    runType: 'posting_preflight',
    startedAt: '2026-08-30T10:00:00.000Z',
    finishedAt: '2026-08-30T10:00:01.000Z',
    outputJson: JSON.stringify(output),
    ...extra,
  };
}

describe('posting preflight status', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.list.mockResolvedValue([]);
  });

  it('reports never_preflighted without any audit', async () => {
    const { latestPostingPreflightStatus, postingPreflightStatusFromAgentRun } =
      await import('./posting-preflight-status');

    expect(postingPreflightStatusFromAgentRun(null)).toEqual({
      state: 'never_preflighted',
      checkedAt: null,
      reason: '',
      evidence: null,
      evidenceRef: null,
    });
    expect(await latestPostingPreflightStatus('opp-1')).toMatchObject({
      state: 'never_preflighted',
    });
    expect(mocks.list).toHaveBeenCalledWith({
      limit: 1,
      orderBy: 'started_at DESC',
      where: { opportunityId: 'opp-1', runType: 'posting_preflight' },
    });
  });

  it('distinguishes live, closed, and inconclusive verdicts with evidence references', async () => {
    const { postingPreflightStatusFromAgentRun } = await import(
      './posting-preflight-status'
    );
    const evidence = {
      checkedAt: '2026-08-30T09:59:59.000Z',
      evidenceExcerpt: '',
      finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
      provider: 'greenhouse',
      redirected: false,
      responseStatus: 200,
    };

    expect(
      postingPreflightStatusFromAgentRun(
        run({ evidence, outcome: 'live', reason: 'verified_live' }),
      ),
    ).toEqual({
      state: 'live',
      checkedAt: '2026-08-30T09:59:59.000Z',
      reason: 'verified_live',
      evidence: {
        finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
        provider: 'greenhouse',
        redirected: false,
        responseStatus: 200,
        excerpt: '',
      },
      evidenceRef: {
        agentRunId: 'run-1',
        adminUrl: '/admin/agent-runs/run-1/',
      },
    });
    expect(
      postingPreflightStatusFromAgentRun(
        run({
          evidence: {
            ...evidence,
            evidenceExcerpt: 'x'.repeat(500),
            responseStatus: 404,
          },
          outcome: 'closed',
          reason: 'closed_status',
        }),
      ),
    ).toMatchObject({
      state: 'closed',
      reason: 'closed_status',
      evidence: { responseStatus: 404 },
    });
    const inconclusive = postingPreflightStatusFromAgentRun(
      run(
        { evidence: { ...evidence, checkedAt: '' }, outcome: 'inconclusive' },
        { error: 'fetch_error' },
      ),
    );
    expect(inconclusive.state).toBe('inconclusive');
    expect(inconclusive.reason).toBe('fetch_error');
    expect(inconclusive.checkedAt).toBe('2026-08-30T10:00:01.000Z');
  });

  it('bounds the evidence excerpt and treats unknown outcomes as inconclusive', async () => {
    const { postingPreflightStatusFromAgentRun } = await import(
      './posting-preflight-status'
    );
    const status = postingPreflightStatusFromAgentRun(
      run({
        evidence: { evidenceExcerpt: 'y'.repeat(1_000) },
        outcome: 'mystery',
      }),
    );
    expect(status.state).toBe('inconclusive');
    expect(status.evidence?.excerpt.length).toBeLessThanOrEqual(241);
    expect(JSON.stringify(status)).not.toContain('overrideReason');
  });
});
