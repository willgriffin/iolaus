import { describe, expect, it, vi } from 'vitest';

const records = vi.hoisted(() => {
  const rows: Array<
    Record<string, unknown> & { save: ReturnType<typeof vi.fn> }
  > = [];
  const collection = {
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const row = {
        id: `run-${rows.length + 1}`,
        save: vi.fn(async () => {}),
        ...payload,
      };
      rows.push(row);
      return row;
    }),
    get: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
  };
  return { collection, rows };
});

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => records.collection),
}));

vi.mock('./opportunity-intelligence-config.js', () => ({
  resolveOpportunityIntelligenceBudgetConfig: () => ({
    run: { calls: 4, inputTokens: 20_000, spendMicros: 100_000 },
  }),
}));

import {
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';

const subject = {
  profileId: 'profile-a',
  tenantId: 'tenant-a',
  userId: 'user-a',
};

describe('candidate-owned opportunity intelligence runs', () => {
  it('persists the verified workspace tuple on a candidate assessment run', async () => {
    const runId = await startOpportunityIntelligenceAgentRun({
      opportunityId: 'opportunity-a',
      sourceId: 'source-a',
      workspaceSubject: subject,
    });

    expect(records.rows.find((row) => row.id === runId)).toMatchObject({
      candidateProfileId: subject.profileId,
      initiatedByUserId: subject.userId,
      opportunityId: 'opportunity-a',
      ownerUserId: subject.userId,
      tenantId: subject.tenantId,
    });
  });

  it('refuses to finish a run through a foreign workspace tuple', async () => {
    const runId = await startOpportunityIntelligenceAgentRun({
      opportunityId: 'opportunity-b',
      workspaceSubject: subject,
    });

    await expect(
      finishOpportunityIntelligenceAgentRun(runId, 'succeeded', '', {
        ...subject,
        profileId: 'profile-b',
      }),
    ).rejects.toThrow('outside the verified workspace subject');
    expect(records.rows.find((row) => row.id === runId)?.status).toBe(
      'running',
    );
  });
});
