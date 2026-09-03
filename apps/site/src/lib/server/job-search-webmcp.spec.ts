import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockRecord = Record<string, unknown> & {
  id: string;
  save: ReturnType<typeof vi.fn>;
};

function record(data: Record<string, unknown>): MockRecord {
  return {
    id: String(data.id ?? 'record-1'),
    save: vi.fn(async () => {}),
    ...data,
  } as MockRecord;
}

type MockWhere = Record<string, unknown> | Record<string, unknown>[][];

function matchesObject(
  record: MockRecord,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key.endsWith(' in') && Array.isArray(value)) {
      return value.includes(record[key.slice(0, -3)]);
    }
    return record[key] === value;
  });
}

function matches(record: MockRecord, where: MockWhere): boolean {
  return Array.isArray(where)
    ? where.some((group) =>
        group.every((condition) => matchesObject(record, condition)),
      )
    : matchesObject(record, where);
}

function collection(records: MockRecord[] = []) {
  return {
    records,
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const created = record({
        id: `created-${records.length + 1}`,
        ...payload,
      });
      records.push(created);
      return created;
    }),
    delete: vi.fn(async (id: string) => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    }),
    get: vi.fn(
      async (id: string) => records.find((item) => item.id === id) ?? null,
    ),
    list: vi.fn(async ({ where }: { where?: MockWhere } = {}) =>
      where ? records.filter((item) => matches(item, where)) : records,
    ),
  };
}

const mocks = vi.hoisted(() => ({
  audit: vi.fn(async (_options: Record<string, unknown>) => ({})),
  collections: new Map<string, ReturnType<typeof collection>>(),
  count: vi.fn(async () => 0),
  createFetch: vi.fn(),
  decision: vi.fn(async () => ({
    applicationId: '',
    decision: { id: 'decision-1' },
    opportunityId: 'opp-1',
    status: 'maybe',
    taskId: '',
  })),
  details: vi.fn(
    async (
      _opportunityId: string,
      _fetch: unknown,
      _options?: {
        normalizeCanonicalUrl?: (canonicalUrl: string) => Promise<string>;
      },
    ) => ({
      provider: 'greenhouse',
      status: 'resolved',
    }),
  ),
  fetch: vi.fn(),
  ids: vi.fn(async () => [] as string[]),
  importLockTails: new Map<string, Promise<void>>(),
  preflight: vi.fn(async (_options: Record<string, unknown>) => ({
    agentRun: { id: 'run-1' },
    evidence: {
      checkedAt: '2026-08-30T10:00:00.000Z',
      evidenceExcerpt: '',
      finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
      provider: 'greenhouse',
      redirected: false,
      responseStatus: 200,
    },
    outcome: 'live',
    reason: 'verified_live',
  })),
  requestDatabase: vi.fn(),
  relatedContext: vi.fn(async () => [] as Record<string, unknown>[]),
  transaction: vi.fn(),
  validateUrl: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({
    transaction: mocks.transaction,
  })),
}));

vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: mocks.requestDatabase,
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const value = mocks.collections.get(className);
    if (!value) throw new Error(`Missing collection ${className}`);
    return value;
  }),
}));

vi.mock('./admin-opportunity-query.js', () => ({
  countOpportunityRecords: mocks.count,
  listLatestOpportunityRelatedContext: mocks.relatedContext,
  listOpportunityPageIds: mocks.ids,
}));

vi.mock('./application-workflow.js', () => ({
  recordAgentAudit: mocks.audit,
  recordExplicitOpportunityDecision: mocks.decision,
}));

vi.mock('./opportunity-details.js', () => ({
  loadOpportunityDetails: mocks.details,
}));

vi.mock('./posting-preflight.js', () => ({
  recordPostingPreflight: mocks.preflight,
}));

vi.mock('./public-https.js', () => ({
  createPublicHttpsFetch: mocks.createFetch,
  PUBLIC_HTTPS_TIMEOUT_MS: 15_000,
  validatePublicHttpsUrl: mocks.validateUrl,
}));

describe('job-search WebMCP service', () => {
  beforeEach(() => {
    mocks.transaction.mockReset();
    mocks.transaction.mockImplementation(
      async (
        action: (database: { query: ReturnType<typeof vi.fn> }) => unknown,
      ) => {
        const releaseLocks: Array<() => void> = [];
        const database = {
          query: vi.fn(async (statement: string, values?: unknown[]) => {
            if (
              statement.includes('FROM opportunities') &&
              statement.includes('FOR UPDATE')
            ) {
              const opportunities = mocks.collections.get('Opportunity');
              const ids = new Set((values ?? []).map(String));
              return {
                rows: (opportunities?.records ?? [])
                  .filter((item) => ids.has(item.id))
                  .map((item) => ({ id: item.id })),
              };
            }
            if (statement.includes('UPDATE source_crawl_items')) {
              const [survivorId, aliasId] = (values ?? []).map(String);
              const items = mocks.collections.get('SourceCrawlItem');
              let rowCount = 0;
              for (const item of items?.records ?? []) {
                if (item.opportunityId !== aliasId) continue;
                item.opportunityId = survivorId;
                rowCount += 1;
              }
              return { rowCount, rows: [] };
            }
            if (
              statement.includes('FROM source_crawl_items') &&
              statement.includes('COUNT(*)')
            ) {
              const [aliasId] = (values ?? []).map(String);
              const count = (
                mocks.collections.get('SourceCrawlItem')?.records ?? []
              ).filter((item) => item.opportunityId === aliasId).length;
              return { rows: [{ count }] };
            }
            if (!statement.includes('pg_advisory_xact_lock'))
              return { rows: [] };
            const key = String(values?.[0] ?? '');
            const previous =
              mocks.importLockTails.get(key) ?? Promise.resolve();
            mocks.importLockTails.set(
              key,
              new Promise<void>((resolve) => {
                releaseLocks.push(resolve);
              }),
            );
            await previous;
            return { rows: [] };
          }),
        };
        try {
          return await action(database);
        } finally {
          for (const releaseLock of releaseLocks) releaseLock();
        }
      },
    );
    mocks.collections.clear();
    mocks.audit.mockClear();
    mocks.count.mockReset();
    mocks.count.mockResolvedValue(0);
    mocks.createFetch.mockReset();
    mocks.createFetch.mockImplementation(() => mocks.fetch);
    mocks.decision.mockClear();
    mocks.details.mockClear();
    mocks.fetch.mockReset();
    mocks.ids.mockReset();
    mocks.ids.mockResolvedValue([]);
    mocks.importLockTails.clear();
    mocks.requestDatabase.mockReset();
    mocks.requestDatabase.mockReturnValue(undefined);
    mocks.relatedContext.mockReset();
    mocks.relatedContext.mockResolvedValue([]);
    mocks.validateUrl.mockReset();
    mocks.validateUrl.mockImplementation(async (value: unknown) => {
      const url = new URL(String(value));
      if (url.protocol !== 'https:' || url.hostname === '127.0.0.1') {
        throw new Error(
          'Unsafe posting URL: a public DNS hostname is required.',
        );
      }
      url.hash = '';
      return {
        address: { address: '93.184.216.34', family: 4 },
        url,
      };
    });
    mocks.collections.set('Opportunity', collection());
    mocks.collections.set('Application', collection());
    mocks.collections.set('AgentRun', collection());
    mocks.collections.set('EvaluationScore', collection());
    mocks.collections.set('Company', collection());
    mocks.collections.set('SourceCrawlItem', collection());
    mocks.preflight.mockClear();
  });

  it('reports the recorded posting preflight verdict on inspect', async () => {
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opp-1', title: 'Platform Engineer' })]),
    );
    const { inspectJobOpportunity } = await import('./job-search-webmcp');

    const never = await inspectJobOpportunity({ opportunityId: 'opp-1' });
    expect(never.preflight).toEqual({
      state: 'never_preflighted',
      checkedAt: null,
      reason: '',
      evidence: null,
      evidenceRef: null,
    });

    mocks.collections.set(
      'AgentRun',
      collection([
        record({
          id: 'run-1',
          opportunityId: 'opp-1',
          runType: 'posting_preflight',
          outputJson: JSON.stringify({
            evidence: {
              checkedAt: '2026-08-30T10:00:00.000Z',
              finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
              provider: 'greenhouse',
              responseStatus: 404,
            },
            outcome: 'closed',
            reason: 'closed_status',
          }),
        }),
        record({
          id: 'run-override',
          opportunityId: 'opp-1',
          runType: 'posting_preflight_override',
          inputJson: JSON.stringify({ overrideReason: 'Recruiter confirmed.' }),
        }),
      ]),
    );
    const closed = await inspectJobOpportunity({ opportunityId: 'opp-1' });
    expect(closed.preflight).toMatchObject({
      state: 'closed',
      checkedAt: '2026-08-30T10:00:00.000Z',
      reason: 'closed_status',
      evidenceRef: {
        agentRunId: 'run-1',
        adminUrl: '/admin/agent-runs/run-1/',
      },
    });
    expect(JSON.stringify(closed)).not.toContain('Recruiter confirmed.');
    expect(JSON.stringify(closed)).not.toContain('overrideReason');
  });

  it('verifies one posting through the recorded preflight without changing lifecycle state', async () => {
    const opportunity = record({
      id: 'opp-1',
      postingUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
      status: 'recommended',
      title: 'Platform Engineer',
    });
    mocks.collections.set('Opportunity', collection([opportunity]));
    const { verifyJobPosting } = await import('./job-search-webmcp');

    const result = await verifyJobPosting(
      { opportunityId: 'opp-1' },
      { id: 'user-1' },
    );

    expect(mocks.preflight).toHaveBeenCalledTimes(1);
    expect(mocks.preflight.mock.calls[0]?.[0]).toMatchObject({
      opportunity: { id: 'opp-1' },
      user: { id: 'user-1' },
    });
    expect(mocks.preflight.mock.calls[0]?.[0]).not.toHaveProperty(
      'overrideReason',
    );
    expect(result).toMatchObject({
      opportunityId: 'opp-1',
      preflight: {
        state: 'live',
        checkedAt: '2026-08-30T10:00:00.000Z',
        reason: 'verified_live',
        evidence: { provider: 'greenhouse', responseStatus: 200 },
        evidenceRef: { agentRunId: 'run-1' },
      },
    });
    expect(opportunity.save).not.toHaveBeenCalled();
    expect(opportunity.status).toBe('recommended');

    await expect(
      verifyJobPosting({ opportunityId: 'missing' }, { id: 'user-1' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('reuses the bounded opportunity query and returns curated decision context', async () => {
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          companyId: 'company-1',
          descriptionSummary: 'Build a developer platform',
          freshness: 'fresh',
          humanReviewStatus: 'needs_input',
          id: 'opp-1',
          postingUrl: 'https://jobs.example.com/platform',
          requiredSkills: 'TypeScript, Kubernetes',
          sourceContentFingerprint: 'fingerprint-1',
          status: 'found',
          title: 'Platform Engineer',
          workMode: 'remote',
        }),
      ]),
    );
    mocks.relatedContext.mockResolvedValue([
      {
        applicationId: 'app-1',
        applicationStatus: 'draft',
        opportunityId: 'opp-1',
        recommendation: 'recommend',
        score: 88,
        scoreId: 'score-1',
      },
    ]);
    mocks.collections.set(
      'Company',
      collection([record({ id: 'company-1', name: 'Example Co' })]),
    );
    mocks.count.mockResolvedValue(1);
    mocks.ids.mockResolvedValue(['opp-1']);
    const { browseJobOpportunities } = await import('./job-search-webmcp');

    const result = await browseJobOpportunities({
      decision: 'unsorted',
      limit: '5',
      query: 'platform',
      workMode: 'remote',
    });

    expect(mocks.ids).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 5,
        reviewFilter: 'unsorted',
        search: 'platform',
      }),
    );
    expect(result).toMatchObject({
      items: [
        {
          id: 'opp-1',
          company: 'Example Co',
          score: 88,
          application: {
            id: 'app-1',
            adminUrl: '/admin/applications/app-1/',
          },
        },
      ],
      total: 1,
    });
    expect(JSON.stringify(result)).not.toContain('sourceContentFingerprint');
    expect(mocks.relatedContext).toHaveBeenCalledOnce();
    expect(mocks.relatedContext).toHaveBeenCalledWith(['opp-1']);
  });

  it('never returns private candidate contact or reusable-answer data', async () => {
    // Private profile facts and reusable answers exist in the data layer; no
    // WebMCP read may surface them. See docs/webmcp-audit.md.
    mocks.collections.set(
      'CandidateProfile',
      collection([
        record({
          active: true,
          email: 'will@example.com',
          firstName: 'Example',
          lastName: 'Candidate',
          linkedinUrl: 'https://www.linkedin.com/in/iolaus',
          githubUrl: 'https://github.com/iolaus',
          id: 'profile-1',
          location: 'Boulder, CO',
          phone: '+1 303 555 0123',
          profileKey: 'default',
          workAuthorization: 'US citizen; no sponsorship needed',
        }),
      ]),
    );
    mocks.collections.set(
      'CandidateAnswer',
      collection([
        record({
          active: true,
          id: 'answer-1',
          label: 'Why this role?',
          labelKey: 'why this role',
          profileKey: 'default',
          value: 'Saved reusable answer.',
        }),
      ]),
    );
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          id: 'opp-1',
          postingUrl: 'https://jobs.example.com/platform',
          status: 'found',
          title: 'Platform Engineer',
        }),
      ]),
    );
    mocks.count.mockResolvedValue(1);
    mocks.ids.mockResolvedValue(['opp-1']);
    const { browseJobOpportunities, inspectJobOpportunity } = await import(
      './job-search-webmcp'
    );

    const browsed = await browseJobOpportunities({ limit: '5' });
    const inspected = await inspectJobOpportunity({ opportunityId: 'opp-1' });

    for (const result of [browsed, inspected]) {
      const serialized = JSON.stringify(result);
      for (const secret of [
        'will@example.com',
        '+1 303 555 0123',
        'Boulder, CO',
        'linkedin.com/in/iolaus',
        'github.com/iolaus',
        'US citizen; no sponsorship needed',
        'Saved reusable answer.',
        'profileKey',
        'candidateProfiles',
        'candidateAnswers',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it('bounds every list-valued field by item and aggregate character budgets', async () => {
    const oversized = 'x'.repeat(50_000);
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          id: 'opp-1',
          locations: oversized,
          preferredSkills: oversized,
          qualifications: oversized,
          requiredSkills: oversized,
          responsibilities: oversized,
          title: 'Bounded role',
        }),
      ]),
    );
    const { inspectJobOpportunity } = await import('./job-search-webmcp');

    const result = await inspectJobOpportunity({ opportunityId: 'opp-1' });
    for (const values of [
      result.locations,
      result.preferredSkills,
      result.qualifications,
      result.requiredSkills,
      result.responsibilities,
    ]) {
      expect(values).toHaveLength(1);
      expect(values[0]?.length).toBeLessThanOrEqual(240);
      expect(values.join('').length).toBeLessThanOrEqual(4_000);
    }
  });

  it('rejects non-public posting URLs before creating an opportunity', async () => {
    const { importJobOpportunity } = await import('./job-search-webmcp');

    await expect(
      importJobOpportunity(
        { url: 'http://127.0.0.1:3000/private' },
        { id: 'user-1' },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.collections.get('Opportunity')?.create).not.toHaveBeenCalled();
  });

  it('imports a new HTTPS posting through detail loading and records agent audit', async () => {
    const { importJobOpportunity } = await import('./job-search-webmcp');

    const result = await importJobOpportunity(
      {
        title: 'Staff Engineer',
        url: 'https://jobs.example.com/staff#apply',
      },
      { id: 'user-1' },
    );

    const created = mocks.collections.get('Opportunity')?.records[0];
    expect(created).toMatchObject({
      canonicalUrl: 'https://jobs.example.com/staff',
      humanReviewStatus: 'needs_input',
      postingUrl: 'https://jobs.example.com/staff',
      status: 'found',
      title: 'Staff Engineer',
    });
    expect(mocks.details).toHaveBeenCalledWith(
      created?.id,
      mocks.fetch,
      expect.objectContaining({
        db: expect.any(Object),
        normalizeCanonicalUrl: expect.any(Function),
      }),
    );
    expect(mocks.validateUrl).toHaveBeenCalledWith(
      'https://jobs.example.com/staff#apply',
      undefined,
      expect.any(Number),
    );
    expect(mocks.createFetch).toHaveBeenCalledWith({
      deadlineAt: expect.any(Number),
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        application: { opportunityId: created?.id },
        database: expect.any(Object),
        runType: 'webmcp_import_opportunity',
        user: { id: 'user-1' },
      }),
    );
    expect(result.created).toBe(true);
    expect(result.detail).toEqual({
      message: '',
      provider: 'greenhouse',
      status: 'resolved',
    });
  });

  it('keeps the successful import audit inside the import transaction', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('Audit storage failed'));
    const { importJobOpportunity } = await import('./job-search-webmcp');

    await expect(
      importJobOpportunity(
        { url: 'https://jobs.example.com/staff' },
        { id: 'user-1' },
      ),
    ).rejects.toThrow('Audit storage failed');

    expect(mocks.audit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        database: expect.any(Object),
        runType: 'webmcp_import_opportunity',
        status: 'completed',
      }),
    );
    expect(mocks.audit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runType: 'webmcp_import_opportunity',
        status: 'failed',
      }),
    );
  });

  it('reuses one stable transaction proxy for successful import audits', async () => {
    const { importJobOpportunity } = await import('./job-search-webmcp');

    await importJobOpportunity(
      { url: 'https://jobs.example.com/first' },
      { id: 'user-1' },
    );
    await importJobOpportunity(
      { url: 'https://jobs.example.com/second' },
      { id: 'user-1' },
    );

    const completedAudits = mocks.audit.mock.calls.filter(
      ([options]) => options.status === 'completed',
    );
    expect(completedAudits).toHaveLength(2);
    expect(completedAudits[0]?.[0].database).toBe(
      completedAudits[1]?.[0].database,
    );
  });

  it('records a failed audit when posting detail loading fails', async () => {
    mocks.details.mockRejectedValueOnce(new Error('Posting fetch failed'));
    const { importJobOpportunity } = await import('./job-search-webmcp');

    await expect(
      importJobOpportunity(
        { url: 'https://jobs.example.com/staff' },
        { id: 'user-1' },
      ),
    ).rejects.toThrow('Posting fetch failed');

    const created = mocks.collections.get('Opportunity')?.records[0];
    expect(mocks.audit).toHaveBeenCalledWith({
      application: { opportunityId: created?.id },
      error: 'Posting fetch failed',
      input: {
        refreshExisting: false,
        url: 'https://jobs.example.com/staff',
      },
      output: { created: true, opportunityId: created?.id },
      runType: 'webmcp_import_opportunity',
      status: 'failed',
      user: { id: 'user-1' },
    });
  });

  it('records explicit decisions with the authenticated user and returns the next safe step', async () => {
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opp-1', status: 'maybe', title: 'Role' })]),
    );
    const { recordJobOpportunityDecision } = await import(
      './job-search-webmcp'
    );

    const result = await recordJobOpportunityDecision(
      {
        decision: 'maybe',
        opportunityId: 'opp-1',
        preflightOverrideReason: 'The agent says the posting is open.',
        reason: 'Need compensation details',
      },
      { id: 'user-1' },
    );

    expect(mocks.decision).toHaveBeenCalledWith({
      deciderProfileId: '',
      decision: 'maybe',
      opportunityId: 'opp-1',
      reason: 'Need compensation details',
      user: { id: 'user-1' },
    });
    expect(result.next).toContain('Return to this opportunity');
  });

  it('rejects a missing decision instead of silently recording Maybe', async () => {
    const { recordJobOpportunityDecision } = await import(
      './job-search-webmcp'
    );

    await expect(
      recordJobOpportunityDecision(
        { opportunityId: 'opp-1' },
        { id: 'user-1' },
      ),
    ).rejects.toMatchObject({
      body: { message: 'Decision is required.' },
      status: 400,
    });
    expect(mocks.decision).not.toHaveBeenCalled();
  });

  it('retries detail loading for an unresolved existing import', async () => {
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          canonicalUrl: 'https://jobs.example.com/staff',
          descriptionRaw: '',
          id: 'opp-1',
          postingUrl: 'https://jobs.example.com/staff',
          status: 'found',
        }),
      ]),
    );
    const { importJobOpportunity } = await import('./job-search-webmcp');

    const result = await importJobOpportunity(
      { url: 'https://jobs.example.com/staff' },
      { id: 'user-1' },
    );

    expect(mocks.details).toHaveBeenCalledWith(
      'opp-1',
      mocks.fetch,
      expect.objectContaining({
        db: expect.any(Object),
        normalizeCanonicalUrl: expect.any(Function),
      }),
    );
    expect(result.created).toBe(false);
  });

  it('serializes concurrent imports of the same normalized URL', async () => {
    const opportunities = mocks.collections.get('Opportunity');
    if (!opportunities) throw new Error('Missing Opportunity collection');
    let finishFirst = () => {};
    const firstCanFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let firstStarted = () => {};
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    mocks.details.mockImplementationOnce(async (opportunityId: string) => {
      firstStarted();
      await firstCanFinish;
      const opportunity = opportunities.records.find(
        (record) => record.id === opportunityId,
      );
      if (opportunity) opportunity.descriptionRaw = 'Loaded posting';
      return { provider: 'generic', status: 'resolved' };
    });

    const { importJobOpportunity } = await import('./job-search-webmcp');
    const first = importJobOpportunity(
      { url: 'https://jobs.example.com/concurrent#apply' },
      { id: 'user-1' },
    );
    await firstDidStart;
    const second = importJobOpportunity(
      { url: 'https://jobs.example.com/concurrent' },
      { id: 'user-1' },
    );
    finishFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.created).toBe(true);
    expect(secondResult.created).toBe(false);
    expect(opportunities.create).toHaveBeenCalledTimes(1);
    expect(mocks.details).toHaveBeenCalledTimes(1);
  });

  it('reconciles concurrent alias and canonical URL imports', async () => {
    const opportunities = mocks.collections.get('Opportunity');
    if (!opportunities) throw new Error('Missing Opportunity collection');
    const canonicalUrl = 'https://jobs.example.com/canonical-role';
    let started = 0;
    let releaseBoth = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    mocks.details.mockImplementation(async (opportunityId: string) => {
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      const opportunity = opportunities.records.find(
        (record) => record.id === opportunityId,
      );
      if (opportunity) {
        opportunity.canonicalUrl = canonicalUrl;
        opportunity.descriptionRaw = 'Loaded posting';
        opportunity.postingUrl = canonicalUrl;
      }
      return { provider: 'generic', status: 'resolved' };
    });

    const { importJobOpportunity } = await import('./job-search-webmcp');
    const [aliasResult, canonicalResult] = await Promise.all([
      importJobOpportunity(
        { url: 'https://jobs.example.com/alias-role' },
        { id: 'user-1' },
      ),
      importJobOpportunity({ url: canonicalUrl }, { id: 'user-1' }),
    ]);

    expect(opportunities.records).toHaveLength(1);
    expect(opportunities.records[0]).toMatchObject({
      canonicalUrl,
      postingUrl: canonicalUrl,
    });
    expect([aliasResult.created, canonicalResult.created].sort()).toEqual([
      false,
      true,
    ]);
    expect(opportunities.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsafe resolver-supplied canonical URL before it is stored', async () => {
    const opportunities = mocks.collections.get('Opportunity');
    if (!opportunities) throw new Error('Missing Opportunity collection');
    mocks.details.mockImplementationOnce(
      async (
        _opportunityId: string,
        _fetch: unknown,
        options?: {
          normalizeCanonicalUrl?: (canonicalUrl: string) => Promise<string>;
        },
      ) => {
        if (!options?.normalizeCanonicalUrl) {
          throw new Error('Missing canonical URL guard');
        }
        await options.normalizeCanonicalUrl('https://127.0.0.1/private');
        return { provider: 'generic', status: 'resolved' };
      },
    );

    const { importJobOpportunity } = await import('./job-search-webmcp');
    await expect(
      importJobOpportunity(
        { url: 'https://jobs.example.com/safe-role' },
        { id: 'user-1' },
      ),
    ).rejects.toMatchObject({
      body: {
        message: expect.stringContaining('public DNS hostname is required'),
      },
      status: 400,
    });

    expect(opportunities.records).toHaveLength(1);
    expect(opportunities.records[0]).toMatchObject({
      canonicalUrl: 'https://jobs.example.com/safe-role',
      postingUrl: 'https://jobs.example.com/safe-role',
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        runType: 'webmcp_import_opportunity',
        status: 'failed',
      }),
    );
  });

  it('refreshes the canonical record that survives alias reconciliation', async () => {
    const aliasUrl = 'https://jobs.example.com/alias-role';
    const canonicalUrl = 'https://jobs.example.com/canonical-role';
    const alias = record({
      canonicalUrl: aliasUrl,
      descriptionRaw: '',
      id: 'alias-1',
      postingUrl: aliasUrl,
      status: 'found',
    });
    const canonical = record({
      canonicalUrl,
      descriptionRaw: 'Stale canonical posting',
      descriptionSummary: 'Stale canonical summary',
      id: 'canonical-1',
      postingUrl: canonicalUrl,
      status: 'found',
    });
    const opportunities = collection([alias, canonical]);
    const baseList = opportunities.list.getMockImplementation();
    opportunities.list.mockImplementation(async (options = {}) => {
      const matches = (await baseList?.(options)) ?? [];
      const where = options.where as Record<string, unknown> | undefined;
      const canonicalLookup =
        where?.postingUrl === canonicalUrl ||
        where?.canonicalUrl === canonicalUrl;
      return canonicalLookup
        ? matches.map((candidate) =>
            candidate.id === canonical.id
              ? record({
                  ...candidate,
                  descriptionRaw: 'Stale canonical posting',
                  descriptionSummary: 'Stale canonical summary',
                })
              : candidate,
          )
        : matches;
    });
    mocks.collections.set('Opportunity', opportunities);
    mocks.details.mockImplementation(async (opportunityId: string) => {
      if (opportunityId === 'alias-1') {
        alias.canonicalUrl = canonicalUrl;
        alias.descriptionRaw = 'Resolved through alias';
        alias.postingUrl = canonicalUrl;
      } else if (opportunityId === 'canonical-1') {
        canonical.descriptionRaw = 'Fresh canonical posting';
        canonical.descriptionSummary = 'Fresh canonical summary';
      }
      return { provider: 'generic', status: 'resolved' };
    });

    const { importJobOpportunity } = await import('./job-search-webmcp');
    const result = await importJobOpportunity(
      { refreshExisting: true, url: aliasUrl },
      { id: 'user-1' },
    );

    expect(mocks.details.mock.calls.map(([id]) => id)).toEqual([
      'alias-1',
      'canonical-1',
    ]);
    expect(canonical.descriptionRaw).toBe('Fresh canonical posting');
    expect(alias.status).toBe('archived');
    expect(result.opportunity.id).toBe('canonical-1');
    expect(result.opportunity.summary).toBe('Fresh canonical summary');
  });

  it('audits a canonical reconciliation refresh failure', async () => {
    const aliasUrl = 'https://jobs.example.com/alias-role';
    const canonicalUrl = 'https://jobs.example.com/canonical-role';
    const alias = record({
      canonicalUrl: aliasUrl,
      descriptionRaw: '',
      id: 'alias-1',
      postingUrl: aliasUrl,
      status: 'found',
    });
    const canonical = record({
      canonicalUrl,
      descriptionRaw: 'Stale canonical posting',
      id: 'canonical-1',
      postingUrl: canonicalUrl,
      status: 'found',
    });
    mocks.collections.set('Opportunity', collection([alias, canonical]));
    mocks.details.mockImplementation(async (opportunityId: string) => {
      if (opportunityId === alias.id) {
        alias.canonicalUrl = canonicalUrl;
        alias.postingUrl = canonicalUrl;
        return { provider: 'generic', status: 'resolved' };
      }
      throw new Error('Canonical refresh failed');
    });

    const { importJobOpportunity } = await import('./job-search-webmcp');
    await expect(
      importJobOpportunity(
        { refreshExisting: true, url: aliasUrl },
        { id: 'user-1' },
      ),
    ).rejects.toThrow('Canonical refresh failed');

    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith({
      application: { opportunityId: alias.id },
      error: 'Canonical refresh failed',
      input: { refreshExisting: true, url: aliasUrl },
      output: { created: false, opportunityId: alias.id },
      runType: 'webmcp_import_opportunity',
      status: 'failed',
      user: { id: 'user-1' },
    });
    expect(alias.status).toBe('found');
  });

  it('archives a pre-existing alias when refresh discovers a canonical row', async () => {
    const canonicalUrl = 'https://jobs.example.com/canonical-role';
    const aliasUrl = 'https://jobs.example.com/legacy-alias';
    const alias = record({
      canonicalUrl: aliasUrl,
      descriptionRaw: '',
      id: 'legacy-alias',
      postingUrl: aliasUrl,
      status: 'found',
    });
    const opportunities = collection([alias]);
    mocks.collections.set('Opportunity', opportunities);
    let started = 0;
    let releaseBoth = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    mocks.details.mockImplementation(async (opportunityId: string) => {
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      const opportunity = opportunities.records.find(
        (record) => record.id === opportunityId,
      );
      if (opportunity) {
        opportunity.canonicalUrl = canonicalUrl;
        opportunity.descriptionRaw = 'Loaded posting';
        opportunity.postingUrl = canonicalUrl;
      }
      return { provider: 'generic', status: 'resolved' };
    });

    const { importJobOpportunity } = await import('./job-search-webmcp');
    const [aliasResult, canonicalResult] = await Promise.all([
      importJobOpportunity({ url: aliasUrl }, { id: 'user-1' }),
      importJobOpportunity({ url: canonicalUrl }, { id: 'user-1' }),
    ]);

    expect(alias).toMatchObject({
      canonicalUrl: aliasUrl,
      humanReviewStatus: 'archived',
      postingUrl: aliasUrl,
      status: 'archived',
    });
    expect(alias.humanReviewNotes).toContain(canonicalResult.opportunity.id);
    expect(aliasResult.opportunity.id).toBe(canonicalResult.opportunity.id);
    expect(
      opportunities.records.filter((record) => record.status !== 'archived'),
    ).toHaveLength(1);
    expect(opportunities.delete).not.toHaveBeenCalled();
  });

  it('opens an existing application without creating another decision', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          applicationUrl: 'https://jobs.example.com/apply',
          id: 'app-1',
          opportunityId: 'opp-1',
          status: 'awaiting_user',
        }),
      ]),
    );
    const { openJobApplication } = await import('./job-search-webmcp');

    const result = await openJobApplication(
      { opportunityId: 'opp-1' },
      { id: 'user-1' },
    );

    expect(mocks.decision).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      application: {
        adminUrl: '/admin/applications/app-1/',
        id: 'app-1',
      },
      created: false,
    });
  });

  it('does not pass an agent-authored posting override into a new application', async () => {
    const { openJobApplication } = await import('./job-search-webmcp');

    await expect(
      openJobApplication(
        {
          opportunityId: 'opp-1',
          preflightOverrideReason: 'The agent says the posting is open.',
        },
        { id: 'user-1' },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.decision).toHaveBeenCalledWith({
      deciderProfileId: '',
      decision: 'apply',
      opportunityId: 'opp-1',
      reason: 'Opened through the WebMCP job-search workflow.',
      reuseExistingApplication: true,
      user: { id: 'user-1' },
    });
  });
});
