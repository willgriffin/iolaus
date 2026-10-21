import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  context: null as unknown,
  job: null as unknown,
  query: vi.fn(),
  ensure: vi.fn(),
  claim: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@happyvertical/smrt-core', async (original) => ({
  ...(await original<object>()),
  resolveDatabase: async () => ({ query: state.query }),
}));
vi.mock('@happyvertical/smrt-jobs', () => ({
  getActiveJobExecutionContext: () => state.context,
  SmrtJobCollection: {
    create: async () => ({
      get: async () => state.job,
      enqueueJob: state.enqueue,
    }),
  },
}));
vi.mock('./opportunity-analysis.js', () => ({
  ensureOpportunityAnalysis: state.ensure,
}));
vi.mock('./opportunity-analysis-maintenance.js', () => ({
  claimAnalysisWindowSlot: state.claim,
}));
vi.mock('./db.js', () => ({
  getDbConfig: () => ({}),
  getSmrtOptions: () => ({}),
}));

import {
  enqueueOpportunityAnalysis,
  executeOpportunityAnalysisJob,
} from './opportunity-analysis-job.js';

const args = {
  analysis: {
    analysisVersion: 'opportunity-analysis/v1',
    sourceContentFingerprint: 'f',
    sourceContentVersion: 1,
    enrich: false,
    budgetMicros: 0,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  state.context = {
    job: {
      jobId: 'job',
      objectType: '@willgriffin/iolaus-site:Opportunity',
      method: 'analyzeSourcePosting',
      queue: 'opportunity-analysis',
      tenantId: '',
    },
  };
  state.job = { objectId: 'o', status: 'running', args };
  state.query.mockResolvedValue({
    rows: [{ source_content_fingerprint: 'f', source_content_version: 1 }],
  });
  state.claim.mockResolvedValue(true);
  state.ensure.mockResolvedValue({ id: 'analysis', status: 'deterministic' });
});
describe('native analysis authority', () => {
  it('executes current durable intent and enqueues source-bound shared work', async () => {
    expect(await executeOpportunityAnalysisJob('o', args)).toEqual({
      analysisId: 'analysis',
      status: 'deterministic',
    });
    await enqueueOpportunityAnalysis('o');
    expect(state.enqueue.mock.calls[0][0]).toMatchObject({
      objectId: 'o',
      tenantId: '',
      queue: 'opportunity-analysis',
      args,
    });
  });
  it('denies missing runner, forged target and mutated intent', async () => {
    state.context = null;
    await expect(executeOpportunityAnalysisJob('o', args)).rejects.toThrow(
      'active',
    );
    state.context = {
      job: {
        jobId: 'job',
        objectType: '@willgriffin/iolaus-site:Opportunity',
        method: 'analyzeSourcePosting',
        queue: 'opportunity-analysis',
        tenantId: '',
      },
    };
    await expect(
      executeOpportunityAnalysisJob('foreign', args),
    ).rejects.toThrow('target');
    await expect(
      executeOpportunityAnalysisJob('o', {
        analysis: { ...args.analysis, enrich: true, budgetMicros: 1000 },
      }),
    ).rejects.toThrow('intent');
    expect(state.ensure).not.toHaveBeenCalled();
  });
  it('does not analyze obsolete versions or exceed global admission', async () => {
    state.query.mockResolvedValueOnce({
      rows: [
        { source_content_fingerprint: 'changed', source_content_version: 2 },
      ],
    });
    expect(await executeOpportunityAnalysisJob('o', args)).toEqual({
      status: 'obsolete',
    });
    state.claim.mockResolvedValue(false);
    await expect(executeOpportunityAnalysisJob('o', args)).rejects.toThrow(
      'exhausted',
    );
    expect(state.ensure).not.toHaveBeenCalled();
  });
});
