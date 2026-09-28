import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  control: {
    id: 'control-1',
    scoreRefreshCursor: '',
    save: vi.fn(async () => {}),
  },
  enqueue: vi.fn(async () => ({ enqueued: true, job: { id: 'job-1' } })),
  listScores: vi.fn<() => Promise<Record<string, unknown>[]>>(async () => []),
  opportunity: new Map<string, Record<string, unknown>>(),
  query: vi.fn(),
  collectionOptions: vi.fn(),
  scoreMaterial: vi.fn(async (opportunity: Record<string, unknown>) => ({
    fingerprint: `material-${opportunity.id}`,
    sourceContentFingerprint: opportunity.sourceContentFingerprint,
    sourceContentVersion: 1,
  })),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({ query: mocks.query })),
}));
vi.mock('@happyvertical/smrt-agents', () => ({
  AgentScheduleCollection: {
    create: vi.fn(async () => ({ getOrUpsert: vi.fn() })),
  },
}));
vi.mock('./db.js', () => ({
  getDbConfig: vi.fn(() => ({})),
  getSmrtOptions: vi.fn(() => ({})),
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  ensureOpportunityIntelligenceControl: vi.fn(async () => {}),
  OPPORTUNITY_INTELLIGENCE_CONTROL_KEY: 'opportunity-intelligence',
}));
vi.mock('./opportunity-intelligence-job.js', () => ({
  enqueueOpportunityIntelligenceWithStatus: mocks.enqueue,
}));
vi.mock('./opportunity-intelligence.js', () => ({
  scoringMaterialForOpportunity: mocks.scoreMaterial,
}));
vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(
    async (name: string, options?: Record<string, unknown>) => {
      mocks.collectionOptions(name, options);
      if (name === 'Opportunity')
        return { get: async (id: string) => mocks.opportunity.get(id) ?? null };
      if (name === 'EvaluationScore') return { list: mocks.listScores };
      return { list: async () => [mocks.control] };
    },
  ),
}));

describe('saved opportunity score refresh', () => {
  beforeEach(() => {
    mocks.control.scoreRefreshCursor = '';
    mocks.control.save.mockClear();
    mocks.enqueue.mockClear();
    mocks.listScores.mockReset();
    mocks.listScores.mockResolvedValue([]);
    mocks.opportunity.clear();
    mocks.query.mockReset();
    mocks.collectionOptions.mockClear();
    mocks.scoreMaterial.mockClear();
  });

  it('pages, persists the target, and queues one fenced score refresh', async () => {
    mocks.opportunity.set('opp-1', {
      id: 'opp-1',
      scoringRefreshAttempts: 0,
      scoringRefreshFingerprint: '',
      sourceContentFingerprint: 'source-1',
    });
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'opp-1' }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const { reconcileSavedOpportunityScores } = await import(
      './opportunity-score-refresh'
    );

    await expect(
      reconcileSavedOpportunityScores(mocks.control as never),
    ).resolves.toMatchObject({
      cursor: '',
      enqueued: 1,
      scanned: 1,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'opp-1',
      expect.objectContaining({
        contentFingerprint: 'source-1',
        modes: 'score',
        scoringMaterialFingerprint: 'material-opp-1',
      }),
      expect.any(Object),
    );
    expect(mocks.query.mock.calls.map(([sql]) => String(sql))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('scoring_material_fingerprint'),
        expect.stringContaining('UPDATE opportunity_intelligence_controls'),
      ]),
    );
    expect(mocks.control.save).not.toHaveBeenCalled();
    expect(mocks.collectionOptions).toHaveBeenCalledWith(
      'Opportunity',
      expect.objectContaining({ db: expect.anything() }),
    );
  });

  it('preserves a source-current human score and does not enqueue it', async () => {
    mocks.opportunity.set('opp-1', {
      id: 'opp-1',
      sourceContentFingerprint: 'source-1',
    });
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('SELECT CAST(id AS TEXT)')
        ? { rows: [{ id: 'opp-1' }], rowCount: 1 }
        : sql.includes('SELECT 1')
          ? { rows: [{ current: 1 }], rowCount: 1 }
          : { rows: [], rowCount: 1 },
    );
    const { reconcileSavedOpportunityScores } = await import(
      './opportunity-score-refresh'
    );
    await reconcileSavedOpportunityScores(mocks.control as never);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('backs off a failed material target and resets attempts when material changes', async () => {
    mocks.opportunity.set('opp-1', {
      id: 'opp-1',
      sourceContentFingerprint: 'source-1',
      scoringMaterialFingerprint: 'material-opp-1',
      scoringRefreshAttempts: 3,
      scoringRefreshFingerprint: 'material-opp-1',
      scoringRefreshNextAttemptAt: new Date('2030-01-01T00:00:00Z'),
    });
    mocks.query.mockImplementation(async (sql: string, args?: unknown[]) => {
      if (sql.includes('SELECT CAST(id AS TEXT)'))
        return { rows: [{ id: 'opp-1' }], rowCount: 1 };
      if (sql.includes('SELECT 1')) return { rows: [], rowCount: 0 };
      if (sql.includes('SET scoring_material_fingerprint')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const { reconcileSavedOpportunityScores } = await import(
      './opportunity-score-refresh'
    );
    await reconcileSavedOpportunityScores(mocks.control as never, {
      now: new Date('2029-01-01T00:00:00Z'),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    mocks.scoreMaterial.mockResolvedValueOnce({
      fingerprint: 'material-new',
      sourceContentFingerprint: 'source-1',
      sourceContentVersion: 1,
    });
    await reconcileSavedOpportunityScores(mocks.control as never, {
      now: new Date('2029-01-01T00:00:00Z'),
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'opp-1',
      expect.objectContaining({ scoringMaterialFingerprint: 'material-new' }),
      expect.any(Object),
    );
  });
});
