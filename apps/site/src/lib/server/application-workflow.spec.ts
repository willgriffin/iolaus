import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveApplicationForClosedPosting,
  cancelStaleOpportunityIntelligenceTasks,
  closeReviewTasksForArchivedOpportunities,
  ensureCompanyResearch,
  normalizeAccountStatus,
  processRecommendationTask,
  recordAgentAudit,
  recordApplicationFormAnswers,
  recordApplicationSubmission,
  recordApplicationSubmissionBlocker,
  recordExplicitOpportunityDecision,
  revokeReusableAnswerByLabelKey,
  routeApplicationToAnswerCollection,
  runWithFreshPostingPreflight,
  syncApplicationWorkflowTasks,
  syncRecommendedOpportunityDecisionTasks,
  syncSourceAccountTasks,
  validateSubmittedApplicationPayload,
} from './application-workflow';

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

function matchesWhere(
  item: MockRecord,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => item[key] === value);
}

function collection(records: MockRecord[] = []) {
  return {
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const created = record({
        id: `created-${records.length + 1}`,
        ...payload,
      });
      records.push(created);
      return created;
    }),
    get: vi.fn(
      async (id: string) => records.find((item) => item.id === id) ?? null,
    ),
    list: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (!where) return records;
      return records.filter((item) => matchesWhere(item, where));
    }),
    records,
  };
}

async function expectHttpError(
  action: () => Promise<unknown>,
  message: string,
  status = 400,
) {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({
    body: { message },
    status,
  });
}

const mocks = vi.hoisted(() => ({
  collectionOptions: [] as Array<{ db?: Record<string, unknown> } | undefined>,
  collections: new Map<string, ReturnType<typeof collection>>(),
  databaseAcquireSession: vi.fn(),
  databaseQuery: vi.fn(async () => ({ rows: [] })),
  databaseReleaseSession: vi.fn(async () => {}),
  databaseSessionQuery: vi.fn(
    async (_statement: string, _values?: unknown[]) => ({
      rows: [] as Array<Record<string, unknown>>,
    }),
  ),
  databaseTransaction: vi.fn(),
  databaseUpdate: vi.fn(async () => ({ affected: 1 })),
  lifecycleSessionIsActive: true,
  lifecycleEvents: [] as string[],
  processOpportunityIntelligence: vi.fn(async () => {
    mocks.lifecycleEvents.push('planning');
    return { status: 'processed' };
  }),
  routeClosedPostingToExistingState: vi.fn(async (opportunity: MockRecord) => {
    Object.assign(opportunity, {
      freshness: 'stale',
      humanReviewStatus: 'archived',
      status: 'archived',
    });
  }),
  requestScopedDatabase: vi.fn(),
  requireFreshPostingPreflight: vi.fn(async () => ({
    evidence: {
      checkedAt: '2026-08-28T00:00:00.000Z',
      evidenceExcerpt: 'Verified test posting.',
      finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
      provider: 'greenhouse',
      redirected: false,
      responseStatus: 200,
    },
    outcome: 'live' as const,
    overridden: false,
    reason: 'verified_live' as const,
  })),
  transactionDatabases: [] as Array<Record<string, unknown>>,
}));

vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: mocks.requestScopedDatabase,
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({
    acquireSession: mocks.databaseAcquireSession,
    transaction: async (
      action: (transaction: {
        query: typeof mocks.databaseQuery;
        update: typeof mocks.databaseUpdate;
      }) => Promise<unknown>,
    ) => {
      mocks.databaseTransaction();
      mocks.lifecycleEvents.push('transaction:start');
      const transaction = {
        query: mocks.databaseQuery,
        update: mocks.databaseUpdate,
      };
      mocks.transactionDatabases.push(transaction);
      const recordsBeforeTransaction = new Map(
        [...mocks.collections].map(([className, value]) => [
          className,
          value.records.map((item) => ({ ...item })),
        ]),
      );
      try {
        return await action(transaction);
      } catch (cause) {
        for (const [className, records] of recordsBeforeTransaction) {
          const target = mocks.collections.get(className)?.records;
          if (!target) continue;
          target.splice(
            0,
            target.length,
            ...records.map((item) => record(item)),
          );
        }
        throw cause;
      } finally {
        mocks.lifecycleEvents.push('transaction:end');
      }
    },
    update: mocks.databaseUpdate,
  })),
}));

const bumpTaskChangeFeed = vi.hoisted(() => vi.fn(async () => 0));

vi.mock('./db.js', () => ({
  getDbConfig: () => ({ type: 'postgres', url: 'postgresql://example/test' }),
}));

vi.mock('./change-feed.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bumpTaskChangeFeed,
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(
    async (className: string, options?: { db?: Record<string, unknown> }) => {
      mocks.collectionOptions.push(options);
      const found = mocks.collections.get(className);
      if (!found) throw new Error(`Missing collection ${className}`);
      return found;
    },
  ),
}));

vi.mock('./opportunity-intelligence.js', () => ({
  processOpportunityIntelligence: mocks.processOpportunityIntelligence,
}));

vi.mock('./opportunity-source-crawler.js', () => ({
  detectJobBoard: vi.fn(async () => ({
    platformName: 'Generic careers',
    type: 'generic-careers',
  })),
}));

vi.mock('./posting-preflight.js', () => ({
  requireFreshPostingPreflight: mocks.requireFreshPostingPreflight,
  routeClosedPostingToExistingState: mocks.routeClosedPostingToExistingState,
}));

beforeEach(() => {
  mocks.lifecycleSessionIsActive = true;
  mocks.databaseAcquireSession.mockReset();
  mocks.databaseReleaseSession.mockReset();
  mocks.databaseReleaseSession.mockResolvedValue(undefined);
  mocks.databaseSessionQuery.mockReset();
  mocks.databaseSessionQuery.mockImplementation(async (statement: string) => ({
    rows: statement.includes('pg_try_advisory_lock')
      ? [{ acquired: true }]
      : [],
  }));
  mocks.databaseAcquireSession.mockImplementation(async () => ({
    isActive: () => mocks.lifecycleSessionIsActive,
    query: mocks.databaseSessionQuery,
    release: mocks.databaseReleaseSession,
  }));
  mocks.requestScopedDatabase.mockReset();
  mocks.requestScopedDatabase.mockReturnValue(undefined);
  mocks.requireFreshPostingPreflight.mockReset();
  mocks.requireFreshPostingPreflight.mockResolvedValue({
    evidence: {
      checkedAt: '2026-08-28T00:00:00.000Z',
      evidenceExcerpt: 'Verified test posting.',
      finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
      provider: 'greenhouse',
      redirected: false,
      responseStatus: 200,
    },
    outcome: 'live',
    overridden: false,
    reason: 'verified_live',
  });
});

describe('recordAgentAudit', () => {
  it('binds the audit collection to an explicit transaction database', async () => {
    mocks.collections.clear();
    mocks.collectionOptions.length = 0;
    mocks.collections.set('AgentRun', collection());
    const database = { query: vi.fn(async () => ({ rows: [] })) };

    await recordAgentAudit({
      database: database as never,
      runType: 'webmcp_import_opportunity',
      status: 'completed',
    });

    expect(mocks.collectionOptions).toContainEqual({ db: database });
  });

  it('records the opportunity organization scope when there is no application', async () => {
    mocks.collections.clear();
    const agentRuns = collection();
    mocks.collections.set('AgentRun', agentRuns);

    await recordAgentAudit({
      input: {
        action: 'posting_preflight',
        postingUrl: 'https://job-boards.greenhouse.io/temporal/jobs/123',
      },
      opportunity: {
        id: 'opp-1',
        organizationProfileId: 'org-1',
        sourceId: 'source-1',
      },
      output: {
        evidence: {
          checkedAt: '2026-08-28T00:00:00.000Z',
          finalUrl: 'https://job-boards.greenhouse.io/temporal/jobs/123',
        },
      },
      runType: 'posting_preflight',
      status: 'completed',
    });

    expect(agentRuns.records[0]).toMatchObject({
      opportunityId: 'opp-1',
      organizationProfileId: 'org-1',
      sourceId: 'source-1',
    });
    expect(JSON.parse(String(agentRuns.records[0].inputJson))).toEqual({
      action: 'posting_preflight',
      postingUrl: 'https://job-boards.greenhouse.io/temporal/jobs/123',
    });
    expect(JSON.parse(String(agentRuns.records[0].outputJson))).toEqual({
      evidence: {
        checkedAt: '2026-08-28T00:00:00.000Z',
        finalUrl: 'https://job-boards.greenhouse.io/temporal/jobs/123',
      },
    });
    expect(agentRuns.records[0].save).toHaveBeenCalledOnce();
  });
});

describe('ensureCompanyResearch source provenance', () => {
  it('records an automatically discovered careers page as unknown and inactive', async () => {
    mocks.collections.clear();
    mocks.collections.set(
      'Company',
      collection([
        record({
          careersUrl: 'https://example.com/careers',
          id: 'company-1',
          name: 'Example',
          researchStatus: 'done',
        }),
      ]),
    );
    const sources = collection();
    mocks.collections.set('Source', sources);
    mocks.collections.set('Task', collection());

    await expect(
      ensureCompanyResearch({
        companyId: 'company-1',
        createdBy: 'automation',
        sourceId: 'discovery-source-1',
      }),
    ).resolves.toMatchObject({ careersSourceCreated: true });

    expect(sources.records[0]).toMatchObject({
      isActive: false,
      parentSourceId: null,
      provider: 'generic-careers',
      sourceRole: 'unknown',
    });
  });
});

describe('syncRecommendedOpportunityDecisionTasks', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.databaseQuery.mockClear();
    mocks.databaseTransaction.mockClear();
    mocks.processOpportunityIntelligence.mockClear();
    mocks.processOpportunityIntelligence.mockResolvedValue({
      status: 'processed',
    });
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          descriptionSummary: 'Strong AI platform role',
          id: 'opp-1',
          postingUrl: 'https://example.com/job',
          status: 'recommended',
          title: 'AI Platform Engineer',
        }),
        record({ id: 'opp-2', status: 'found', title: 'Unscored role' }),
      ]),
    );
    mocks.collections.set('Task', collection());
  });

  it('creates one active Will decision task per recommended opportunity', async () => {
    await expect(
      syncRecommendedOpportunityDecisionTasks(),
    ).resolves.toMatchObject({
      closed: 0,
      created: 1,
      existing: 0,
      scanned: 1,
    });
    await expect(
      syncRecommendedOpportunityDecisionTasks(),
    ).resolves.toMatchObject({
      closed: 0,
      created: 0,
      existing: 1,
      scanned: 1,
    });

    expect(mocks.collections.get('Task')?.records).toHaveLength(1);
    expect(mocks.collections.get('Task')?.records[0]).toMatchObject({
      assigneeRole: 'owner',
      externalTaskId: 'review-recommendation:opp-1',
      kanbanColumn: 'needs_user_decision',
      opportunityId: 'opp-1',
      taskType: 'review_recommendation',
    });
  });

  it('cancels stale recommendation tasks when the opportunity is no longer recommended', async () => {
    mocks.collections.set(
      'Task',
      collection([
        record({
          externalTaskId: 'review-recommendation:opp-2',
          id: 'task-stale',
          kanbanColumn: 'needs_user_decision',
          opportunityId: 'opp-2',
          status: 'open',
          taskType: 'review_recommendation',
        }),
      ]),
    );

    await expect(
      syncRecommendedOpportunityDecisionTasks(),
    ).resolves.toMatchObject({
      closed: 1,
      created: 1,
      scanned: 1,
    });

    expect(
      mocks.collections
        .get('Task')
        ?.records.find((task) => task.id === 'task-stale'),
    ).toMatchObject({
      completedAt: expect.any(Date),
      kanbanColumn: 'rejected_archived',
      status: 'canceled',
    });
  });
});

describe('cancelStaleOpportunityIntelligenceTasks', () => {
  it('conditionally cancels only versioned automation tasks from strictly older content', async () => {
    const staleUpdatedAt = new Date('2026-07-14T12:00:00.000Z');
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValue({ affected: 1 });
    const tasks = collection([
      record({
        artifactRefsJson: JSON.stringify({
          opportunityIntelligence: {
            contentFingerprint: 'fingerprint-v1',
            contentVersion: 1,
          },
        }),
        createdBy: 'automation',
        externalTaskId: 'company-research:opp-1:fingerprint-v1',
        id: 'stale-versioned',
        opportunityId: 'opp-1',
        status: 'open',
        taskType: 'research_company',
        updated_at: staleUpdatedAt,
      }),
      record({
        artifactRefsJson: '{}',
        createdBy: 'automation',
        externalTaskId: 'revise-score:opp-1',
        id: 'stale-legacy',
        opportunityId: 'opp-1',
        status: 'blocked',
        taskType: 'score_opportunity',
        updated_at: new Date('2026-07-14T12:01:00.000Z'),
      }),
      record({
        artifactRefsJson: JSON.stringify({
          opportunityIntelligence: {
            contentFingerprint: 'fingerprint-v2',
            contentVersion: 2,
          },
        }),
        createdBy: 'automation',
        externalTaskId: 'company-research:opp-1:fingerprint-v2',
        id: 'current',
        opportunityId: 'opp-1',
        status: 'open',
        taskType: 'research_company',
        updated_at: new Date('2026-07-14T12:02:00.000Z'),
      }),
      record({
        artifactRefsJson: JSON.stringify({
          opportunityIntelligence: {
            contentFingerprint: 'fingerprint-v3',
            contentVersion: 3,
          },
        }),
        createdBy: 'automation',
        externalTaskId: 'revise-score:opp-1:fingerprint-v3',
        id: 'newer',
        opportunityId: 'opp-1',
        status: 'open',
        taskType: 'score_opportunity',
        updated_at: new Date('2026-07-14T12:03:00.000Z'),
      }),
      record({
        artifactRefsJson: JSON.stringify({
          opportunityIntelligence: {
            contentFingerprint: 'fingerprint-v1',
            contentVersion: 1,
          },
        }),
        createdBy: 'owner',
        externalTaskId: 'company-research:opp-1:fingerprint-v1',
        id: 'human-task',
        opportunityId: 'opp-1',
        status: 'open',
        taskType: 'research_company',
        updated_at: new Date('2026-07-14T12:04:00.000Z'),
      }),
    ]);
    mocks.collections.set('Task', tasks);

    await expect(
      cancelStaleOpportunityIntelligenceTasks('opp-1', 'fingerprint-v2', 2),
    ).resolves.toBe(1);

    expect(mocks.databaseUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.databaseUpdate).toHaveBeenCalledWith(
      'tasks',
      expect.objectContaining({
        artifact_refs_json: tasks.records[0].artifactRefsJson,
        created_by: 'automation',
        external_task_id: 'company-research:opp-1:fingerprint-v1',
        id: 'stale-versioned',
        opportunity_id: 'opp-1',
        status: 'open',
        task_type: 'research_company',
        updated_at: staleUpdatedAt,
      }),
      expect.objectContaining({
        kanban_column: 'rejected_archived',
        status: 'canceled',
      }),
    );
  });

  it('does not count a cancellation that loses a concurrent task update', async () => {
    const updatedAt = new Date('2026-07-14T12:00:00.000Z');
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValue({ affected: 0 });
    mocks.collections.set(
      'Task',
      collection([
        record({
          artifactRefsJson: JSON.stringify({
            opportunityIntelligence: {
              contentFingerprint: 'fingerprint-v1',
              contentVersion: 1,
            },
          }),
          createdBy: 'automation',
          externalTaskId: 'revise-score:opp-1:fingerprint-v1',
          id: 'stale-versioned',
          opportunityId: 'opp-1',
          status: 'open',
          taskType: 'score_opportunity',
          updated_at: updatedAt,
        }),
      ]),
    );

    await expect(
      cancelStaleOpportunityIntelligenceTasks('opp-1', 'fingerprint-v2', 2),
    ).resolves.toBe(0);
    expect(mocks.databaseUpdate).toHaveBeenCalledWith(
      'tasks',
      expect.objectContaining({ status: 'open', updated_at: updatedAt }),
      expect.any(Object),
    );
  });
});

describe('processRecommendationTask', () => {
  beforeEach(() => {
    mocks.collectionOptions.length = 0;
    mocks.collections.clear();
    mocks.lifecycleEvents.length = 0;
    mocks.transactionDatabases.length = 0;
    mocks.processOpportunityIntelligence.mockReset();
    mocks.processOpportunityIntelligence.mockImplementation(async () => {
      mocks.lifecycleEvents.push('planning');
      return { status: 'processed' };
    });
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          id: 'opp-1',
          organizationProfileId: 'org-1',
          postingUrl: 'https://example.com/apply',
          sourceId: 'source-1',
          status: 'recommended',
          title: 'AI Engineer',
        }),
      ]),
    );
    mocks.collections.set(
      'Task',
      collection([
        record({
          assigneeRole: 'owner',
          externalTaskId: 'review-recommendation:opp-1',
          id: 'task-1',
          kanbanColumn: 'needs_user_decision',
          opportunityId: 'opp-1',
          status: 'open',
          taskType: 'review_recommendation',
          title: 'Review recommendation',
        }),
      ]),
    );
    mocks.collections.set('Application', collection());
    mocks.collections.set('Decision', collection());
  });

  it('accepts a recommendation into an application and packet tasks', async () => {
    const result = await processRecommendationTask({
      decision: 'accept_to_apply',
      reason: 'Strong fit',
      taskId: 'task-1',
      user: { id: 'user-1' },
    });

    const opportunity = mocks.collections.get('Opportunity')?.records[0];
    const application = mocks.collections.get('Application')?.records[0];
    const tasks = mocks.collections.get('Task')?.records ?? [];

    expect(result.decision).toMatchObject({
      applicationId: application?.id,
      decision: 'accept_to_apply',
    });
    expect(mocks.collections.get('Decision')?.records[0]).toMatchObject({
      applicationId: application?.id,
      decision: 'accept_to_apply',
    });
    expect(opportunity).toMatchObject({
      humanReviewStatus: 'apply',
      status: 'apply',
    });
    expect(application).toMatchObject({
      applicationUrl: 'https://example.com/apply',
      opportunityId: 'opp-1',
      status: 'application_drafting',
    });
    expect(mocks.processOpportunityIntelligence).toHaveBeenCalledWith({
      applicationId: application?.id,
      modes: ['plan'],
      opportunityId: 'opp-1',
      user: { id: 'user-1' },
    });
    expect(mocks.requireFreshPostingPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'accept_opportunity',
        opportunity: expect.objectContaining({ id: 'opp-1' }),
        user: { id: 'user-1' },
      }),
    );
    expect(mocks.lifecycleEvents).toEqual([
      'transaction:start',
      'transaction:end',
      'planning',
    ]);
    expect(tasks.find((task) => task.id === 'task-1')).toMatchObject({
      applicationId: application?.id,
      kanbanColumn: 'accepted_apply',
      status: 'done',
    });
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          applicationId: application?.id,
          externalTaskId: `application-packet:${application?.id}`,
          taskType: 'prepare_application_packet',
        }),
        expect.objectContaining({
          applicationId: application?.id,
          externalTaskId: `application-account:${application?.id}:check`,
          taskType: 'account_setup',
        }),
      ]),
    );
  });

  it('cancels recommendation and account work when preflight closes the posting', async () => {
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValue({ affected: 1 });
    const application = record({
      accountStatus: 'unknown',
      id: 'app-closed',
      opportunityId: 'opp-1',
      status: 'application_drafting',
    });
    const secondApplication = record({
      id: 'app-closed-second',
      opportunityId: 'opp-1',
      status: 'draft',
    });
    const accountTask = record({
      applicationId: 'app-closed',
      id: 'account-task',
      opportunityId: 'opp-1',
      status: 'open',
      taskType: 'account_setup',
    });
    const secondApplicationTask = record({
      applicationId: 'app-closed-second',
      id: 'second-application-task',
      opportunityId: 'opp-1',
      status: 'open',
      taskType: 'prepare_application_packet',
    });
    mocks.collections.set(
      'Application',
      collection([application, secondApplication]),
    );
    mocks.collections.get('Task')?.records.push(accountTask);
    mocks.collections.get('Task')?.records.push(secondApplicationTask);
    mocks.requireFreshPostingPreflight.mockImplementationOnce(
      (async (gateOptions?: { onClosedAtomically?: () => Promise<void> }) => {
        await gateOptions?.onClosedAtomically?.();
        return {
          evidence: {
            checkedAt: '2026-08-28T00:00:00.000Z',
            evidenceExcerpt: 'Verified test closure.',
            finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
            provider: 'greenhouse',
            redirected: false,
            responseStatus: 404,
          },
          outcome: 'closed' as const,
          overridden: false,
          reason: 'verified_closed' as const,
        };
      }) as never,
    );

    await expect(
      processRecommendationTask({
        decision: 'accept_to_apply',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 409 });

    const tasks = mocks.collections.get('Task')?.records ?? [];
    expect(application).toMatchObject({ status: 'archived' });
    expect(secondApplication).toMatchObject({ status: 'archived' });
    expect(tasks.find((task) => task.id === 'task-1')).toMatchObject({
      kanbanColumn: 'rejected_archived',
      status: 'canceled',
    });
    expect(accountTask).toMatchObject({
      kanbanColumn: 'rejected_archived',
      status: 'canceled',
    });
    expect(secondApplicationTask).toMatchObject({
      kanbanColumn: 'rejected_archived',
      status: 'canceled',
    });
  });

  it('rolls back failed closed-posting cleanup so the next check can retry it', async () => {
    const application = record({
      id: 'app-closed-retry',
      opportunityId: 'opp-1',
      status: 'application_drafting',
    });
    const applicationTask = record({
      applicationId: 'app-closed-retry',
      id: 'app-closed-retry-task',
      opportunityId: 'opp-1',
      status: 'open',
      taskType: 'prepare_application_packet',
    });
    mocks.collections.set('Application', collection([application]));
    mocks.collections.get('Task')?.records.push(applicationTask);
    const closedResult = {
      evidence: {
        checkedAt: '2026-08-28T00:00:00.000Z',
        evidenceExcerpt: 'Verified test closure.',
        finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
        provider: 'greenhouse',
        redirected: false,
        responseStatus: 404,
      },
      outcome: 'closed' as const,
      overridden: false,
      reason: 'verified_closed' as const,
    };
    mocks.requireFreshPostingPreflight.mockImplementationOnce(
      (async (options?: { onClosedAtomically?: () => Promise<void> }) => {
        await options?.onClosedAtomically?.();
        return closedResult;
      }) as never,
    );
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValueOnce({ affected: 0 });

    await expect(
      processRecommendationTask({
        decision: 'accept_to_apply',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'recommended',
    });
    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      status: 'application_drafting',
    });
    expect(mocks.collections.get('Task')?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'task-1', status: 'open' }),
        expect.objectContaining({
          id: 'app-closed-retry-task',
          status: 'open',
        }),
      ]),
    );

    mocks.requireFreshPostingPreflight.mockImplementationOnce(
      (async (options?: { onClosedAtomically?: () => Promise<void> }) => {
        await options?.onClosedAtomically?.();
        return closedResult;
      }) as never,
    );
    mocks.databaseUpdate.mockResolvedValue({ affected: 1 });

    await expect(
      processRecommendationTask({
        decision: 'accept_to_apply',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'archived',
    });
    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      status: 'archived',
    });
    expect(mocks.collections.get('Task')?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'task-1', status: 'canceled' }),
        expect.objectContaining({
          id: 'app-closed-retry-task',
          status: 'canceled',
        }),
      ]),
    );
  });

  it('does not overwrite a closure that lands between preflight and acceptance', async () => {
    mocks.requireFreshPostingPreflight.mockImplementationOnce(async () => {
      const opportunity = mocks.collections
        .get('Opportunity')
        ?.records.find((record) => record.id === 'opp-1');
      Object.assign(opportunity ?? {}, { status: 'archived' });
      return {
        evidence: {
          checkedAt: '2026-08-28T00:00:00.000Z',
          evidenceExcerpt: 'Verified test posting.',
          finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
          provider: 'greenhouse',
          redirected: false,
          responseStatus: 200,
        },
        outcome: 'live' as const,
        overridden: false,
        reason: 'verified_live' as const,
      };
    });

    await expect(
      processRecommendationTask({
        decision: 'accept_to_apply',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'This posting is closed and has been archived. Application work cannot continue.',
      },
      status: 409,
    });

    expect(mocks.collections.get('Decision')?.records).toHaveLength(0);
    expect(mocks.collections.get('Application')?.records).toHaveLength(0);
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'archived',
    });
  });

  it('does not overwrite a concurrently changed application while accepting a recommendation', async () => {
    const application = record({
      applicationUrl: 'https://example.com/old-apply',
      id: 'app-existing',
      opportunityId: 'opp-1',
      status: 'approved',
    });
    mocks.collections.set('Application', collection([application]));
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValueOnce({ affected: 0 });

    await expect(
      processRecommendationTask({
        decision: 'accept_to_apply',
        reason: 'Strong fit',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application changed while the opportunity was accepted. Reload and review the current application.',
      },
      status: 409,
    });
    expect(application).toMatchObject({
      applicationUrl: 'https://example.com/old-apply',
      status: 'approved',
    });
    expect(application.save).not.toHaveBeenCalled();
  });

  it('blocks the review task and assigns Hermes research when Will asks for more research', async () => {
    await processRecommendationTask({
      decision: 'request_more_research',
      reason: 'Need funding and remote-policy notes',
      taskId: 'task-1',
      user: { id: 'user-1' },
    });

    const tasks = mocks.collections.get('Task')?.records ?? [];
    expect(tasks.find((task) => task.id === 'task-1')).toMatchObject({
      blockerOwnerRole: 'hermes',
      kanbanColumn: 'blocked',
      status: 'blocked',
    });
    expect(tasks).toContainEqual(
      expect.objectContaining({
        assigneeRole: 'hermes',
        kanbanColumn: 'researching',
        taskType: 'research_company',
      }),
    );
  });

  it('does not let a task-board decision contradict an existing application lifecycle', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          id: 'app-existing',
          opportunityId: 'opp-1',
          status: 'application_drafting',
        }),
      ]),
    );

    await expectHttpError(
      () =>
        processRecommendationTask({
          decision: 'reject',
          reason: 'Contradictory task-board decision',
          taskId: 'task-1',
          user: { id: 'user-1' },
        }),
      'A non-apply decision cannot replace the lifecycle of an existing application. Update the application instead.',
      409,
    );
    expect(mocks.collections.get('Decision')?.records).toHaveLength(0);
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'recommended',
    });
  });

  it('allows a blocked recommendation to be reopened and decided after research', async () => {
    await processRecommendationTask({
      decision: 'request_more_research',
      reason: 'Need funding and remote-policy notes',
      taskId: 'task-1',
      user: { id: 'user-1' },
    });

    await expectHttpError(
      () =>
        processRecommendationTask({
          decision: 'accept_to_apply',
          reason: 'Double submit before research is done',
          taskId: 'task-1',
          user: { id: 'user-1' },
        }),
      'Recommendation task is blocked pending requested work.',
    );

    const task = mocks.collections
      .get('Task')
      ?.records.find((task) => task.id === 'task-1');
    Object.assign(task ?? {}, {
      blockerOwnerRole: '',
      blockerReason: '',
      kanbanColumn: 'needs_user_decision',
      status: 'open',
    });

    await processRecommendationTask({
      decision: 'accept_to_apply',
      reason: 'Research cleared concerns',
      taskId: 'task-1',
      user: { id: 'user-1' },
    });

    expect(
      mocks.collections
        .get('Decision')
        ?.records.map((decision) => decision.decision),
    ).toEqual(['request_more_research', 'accept_to_apply']);
    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      opportunityId: 'opp-1',
      status: 'application_drafting',
    });
  });

  it('rejects duplicate processing of the same recommendation task', async () => {
    await processRecommendationTask({
      decision: 'accept_to_apply',
      reason: 'Strong fit',
      taskId: 'task-1',
      user: { id: 'user-1' },
    });

    await expectHttpError(
      () =>
        processRecommendationTask({
          decision: 'accept_to_apply',
          reason: 'Double submit',
          taskId: 'task-1',
          user: { id: 'user-1' },
        }),
      'Recommendation task has already been processed.',
    );
    expect(mocks.collections.get('Decision')?.records).toHaveLength(1);
  });

  it('rejects active review tasks after the opportunity leaves recommended status', async () => {
    const opportunity = mocks.collections.get('Opportunity')?.records[0];
    Object.assign(opportunity ?? {}, { status: 'apply' });

    await expectHttpError(
      () =>
        processRecommendationTask({
          decision: 'accept_to_apply',
          reason: 'Stale task',
          taskId: 'task-1',
          user: { id: 'user-1' },
        }),
      'Opportunity is no longer recommended for review.',
    );
    expect(mocks.collections.get('Decision')?.records).toHaveLength(0);
  });
});

describe('archiveApplicationForClosedPosting', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValue({ affected: 1 });
  });

  it('archives active local application work and cancels its actionable tasks', async () => {
    const application = record({
      id: 'app-closed',
      opportunityId: 'opp-closed',
      status: 'approved',
    });
    const packetTask = record({
      applicationId: 'app-closed',
      id: 'packet-task',
      status: 'open',
      taskType: 'prepare_application_packet',
    });
    const submitTask = record({
      applicationId: 'app-closed',
      id: 'submit-task',
      status: 'open',
      taskType: 'submit_application',
    });
    const accountTask = record({
      applicationId: 'app-closed',
      id: 'account-task',
      status: 'blocked',
      taskType: 'account_setup',
    });
    mocks.collections.set('Application', collection([application]));
    mocks.collections.set(
      'Task',
      collection([packetTask, submitTask, accountTask]),
    );

    await archiveApplicationForClosedPosting(application);

    expect(application).toMatchObject({ status: 'archived' });
    expect(packetTask).toMatchObject({
      kanbanColumn: 'rejected_archived',
      status: 'canceled',
    });
    expect(submitTask).toMatchObject({
      kanbanColumn: 'rejected_archived',
      status: 'canceled',
    });
    expect(accountTask).toMatchObject({
      kanbanColumn: 'rejected_archived',
      status: 'canceled',
    });
  });

  it('preserves submitted application history', async () => {
    const application = record({
      id: 'app-submitted',
      opportunityId: 'opp-submitted',
      status: 'submitted',
    });
    mocks.collections.set('Application', collection([application]));
    mocks.collections.set('Task', collection());

    await archiveApplicationForClosedPosting(application);

    expect(application).toMatchObject({ status: 'submitted' });
    expect(mocks.databaseUpdate).not.toHaveBeenCalled();
  });
});

describe('runWithFreshPostingPreflight', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.databaseTransaction.mockClear();
    mocks.requireFreshPostingPreflight.mockClear();
    mocks.requireFreshPostingPreflight.mockResolvedValue({
      evidence: {
        checkedAt: '2026-08-28T00:00:00.000Z',
        evidenceExcerpt: 'Verified test posting.',
        finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
        provider: 'greenhouse',
        redirected: false,
        responseStatus: 200,
      },
      outcome: 'live',
      overridden: false,
      reason: 'verified_live',
    });
  });

  it('re-reads an opportunity under the lifecycle lock before creating local work', async () => {
    const archivedOpportunity = record({
      id: 'opp-closed',
      status: 'archived',
    });
    mocks.collections.set('Opportunity', collection([archivedOpportunity]));
    const run = vi.fn(async () => 'created');

    await expect(
      runWithFreshPostingPreflight({
        action: 'create_application_draft',
        opportunity: record({ id: 'opp-closed', status: 'found' }),
        run,
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'This posting is closed and has been archived. Application work cannot continue.',
      },
      status: 409,
    });

    expect(mocks.requireFreshPostingPreflight).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('stops before local work if the lifecycle-lock session drops during preflight', async () => {
    const opportunity = record({ id: 'opp-live', status: 'found' });
    mocks.collections.set('Opportunity', collection([opportunity]));
    mocks.requireFreshPostingPreflight.mockImplementationOnce(async () => {
      mocks.lifecycleSessionIsActive = false;
      return {
        evidence: {
          checkedAt: '2026-08-28T00:00:00.000Z',
          evidenceExcerpt: 'Verified test posting.',
          finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
          provider: 'greenhouse',
          redirected: false,
          responseStatus: 200,
        },
        outcome: 'live' as const,
        overridden: false,
        reason: 'verified_live' as const,
      };
    });
    const run = vi.fn(async () => 'created');

    await expect(
      runWithFreshPostingPreflight({
        action: 'create_application_draft',
        opportunity,
        run,
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'The posting check connection was lost. Please try again before making application changes.',
      },
      status: 409,
    });

    expect(run).not.toHaveBeenCalled();
    expect(mocks.databaseTransaction).not.toHaveBeenCalled();
    expect(mocks.databaseReleaseSession).toHaveBeenCalledOnce();
  });
});

describe('recordExplicitOpportunityDecision', () => {
  beforeEach(() => {
    mocks.collectionOptions.length = 0;
    mocks.collections.clear();
    mocks.databaseQuery.mockClear();
    mocks.databaseTransaction.mockClear();
    mocks.lifecycleEvents.length = 0;
    mocks.processOpportunityIntelligence.mockReset();
    mocks.processOpportunityIntelligence.mockImplementation(async () => {
      mocks.lifecycleEvents.push('planning');
      return { status: 'processed' };
    });
    mocks.transactionDatabases.length = 0;
    mocks.collections.set(
      'Opportunity',
      collection([
        record({ id: 'opp-found', status: 'found', title: 'Found role' }),
        record({
          id: 'opp-recommended',
          status: 'recommended',
          title: 'Recommended role',
        }),
      ]),
    );
    mocks.collections.set(
      'Task',
      collection([
        record({
          id: 'task-recommended',
          opportunityId: 'opp-recommended',
          status: 'open',
          taskType: 'review_recommendation',
        }),
      ]),
    );
    mocks.collections.set('Application', collection());
    mocks.collections.set('Decision', collection());
  });

  it('records a reject decision with user attribution for an unqueued opportunity', async () => {
    const result = await recordExplicitOpportunityDecision({
      decision: 'reject',
      opportunityId: 'opp-found',
      reason: 'Requires relocation',
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({
      applicationId: '',
      opportunityId: 'opp-found',
      status: 'reject',
    });
    expect(mocks.collections.get('Decision')?.records[0]).toMatchObject({
      deciderUserId: 'user-1',
      decision: 'reject',
      newStatus: 'rejected',
      previousStatus: 'found',
      reason: 'Requires relocation',
    });
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      humanReviewStatus: 'reject',
      reviewedByUserId: 'user-1',
      status: 'rejected',
    });
    expect(mocks.databaseAcquireSession).toHaveBeenCalledOnce();
    expect(mocks.databaseSessionQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_lock(hashtext(?)) AS acquired',
      ['opportunity-lifecycle:opp-found'],
    );
    expect(mocks.databaseSessionQuery).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock(hashtext(?))',
      ['opportunity-lifecycle:opp-found'],
    );
    expect(mocks.databaseReleaseSession).toHaveBeenCalledOnce();
  });

  it('acquires the lifecycle session from the request-scoped database', async () => {
    const scopedAcquireSession = vi.fn(async () => ({
      isActive: () => true,
      query: mocks.databaseSessionQuery,
      release: mocks.databaseReleaseSession,
    }));
    const scopedTransaction = vi.fn(
      async (
        action: (transaction: {
          query: typeof mocks.databaseQuery;
          update: typeof mocks.databaseUpdate;
        }) => Promise<unknown>,
      ) =>
        await action({
          query: mocks.databaseQuery,
          update: mocks.databaseUpdate,
        }),
    );
    mocks.requestScopedDatabase.mockReturnValue({
      acquireSession: scopedAcquireSession,
      transaction: scopedTransaction,
    });

    await expect(
      recordExplicitOpportunityDecision({
        decision: 'reject',
        opportunityId: 'opp-found',
        user: { id: 'user-1' },
      }),
    ).resolves.toMatchObject({ status: 'reject' });

    expect(scopedAcquireSession).toHaveBeenCalledOnce();
    expect(scopedTransaction).toHaveBeenCalledOnce();
    expect(mocks.databaseAcquireSession).not.toHaveBeenCalled();
  });

  it('records Maybe without inventing an invalid opportunity lifecycle status', async () => {
    const result = await recordExplicitOpportunityDecision({
      decision: 'maybe',
      opportunityId: 'opp-found',
      reason: 'Need compensation details',
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({
      opportunityId: 'opp-found',
      status: 'maybe',
    });
    expect(mocks.collections.get('Decision')?.records[0]).toMatchObject({
      decision: 'defer',
      newStatus: 'found',
      previousStatus: 'found',
    });
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      humanReviewStatus: 'maybe',
      status: 'found',
    });
  });

  it('returns a committed decision when post-commit task reconciliation fails', async () => {
    const tasks = mocks.collections.get('Task');
    if (!tasks) throw new Error('Missing Task collection');
    tasks.list
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Task board unavailable'));

    const result = await recordExplicitOpportunityDecision({
      decision: 'maybe',
      opportunityId: 'opp-found',
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({ status: 'maybe' });
    expect(mocks.collections.get('Decision')?.records).toHaveLength(1);
  });

  it('reuses an application found inside the lock without a second decision or planning pass', async () => {
    const first = await recordExplicitOpportunityDecision({
      decision: 'apply',
      opportunityId: 'opp-found',
      reuseExistingApplication: true,
      user: { id: 'user-1' },
    });
    const second = await recordExplicitOpportunityDecision({
      decision: 'apply',
      opportunityId: 'opp-found',
      reuseExistingApplication: true,
      user: { id: 'user-1' },
    });

    expect(first).toMatchObject({ status: 'apply' });
    expect(second).toMatchObject({
      applicationId: first.applicationId,
      applicationReused: true,
      decision: null,
      status: 'apply',
    });
    expect(mocks.collections.get('Application')?.records).toHaveLength(1);
    expect(mocks.collections.get('Decision')?.records).toHaveLength(1);
    expect(mocks.processOpportunityIntelligence).toHaveBeenCalledOnce();
    expect(mocks.databaseAcquireSession).toHaveBeenCalledTimes(2);
  });

  it('rolls back a partial acceptance and permits a clean retry', async () => {
    const failingApplications = collection();
    failingApplications.create.mockImplementationOnce(
      async (payload: Record<string, unknown>) => {
        const created = record({
          id: 'app-failing',
          ...payload,
          save: vi.fn(async () => {
            throw new Error('Application persistence failed.');
          }),
        });
        failingApplications.records.push(created);
        return created;
      },
    );
    mocks.collections.set('Application', failingApplications);

    await expect(
      recordExplicitOpportunityDecision({
        decision: 'apply',
        opportunityId: 'opp-found',
        user: { id: 'user-1' },
      }),
    ).rejects.toThrow('Application persistence failed.');

    expect(failingApplications.records).toHaveLength(0);
    expect(mocks.collections.get('Decision')?.records).toHaveLength(0);
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'found',
    });

    const retryApplications = collection();
    mocks.collections.set('Application', retryApplications);
    await expect(
      recordExplicitOpportunityDecision({
        decision: 'apply',
        opportunityId: 'opp-found',
        user: { id: 'user-1' },
      }),
    ).resolves.toMatchObject({ status: 'apply' });

    expect(retryApplications.records).toHaveLength(1);
    expect(mocks.collections.get('Decision')?.records).toHaveLength(1);
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'apply',
    });
  });

  it('rolls back lifecycle mutations when the advisory-lock session is lost', async () => {
    const decisions = collection();
    decisions.create.mockImplementationOnce(
      async (payload: Record<string, unknown>) => {
        const created = record({
          id: 'decision-lost-session',
          ...payload,
          save: vi.fn(async () => {
            mocks.lifecycleSessionIsActive = false;
          }),
        });
        decisions.records.push(created);
        return created;
      },
    );
    mocks.collections.set('Decision', decisions);

    await expect(
      recordExplicitOpportunityDecision({
        decision: 'apply',
        opportunityId: 'opp-found',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'The posting check connection was lost. Please try again before making application changes.',
      },
      status: 409,
    });

    expect(mocks.databaseTransaction).toHaveBeenCalledOnce();
    expect(decisions.records).toHaveLength(0);
    expect(mocks.collections.get('Application')?.records).toHaveLength(0);
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'found',
    });
    expect(mocks.databaseSessionQuery).toHaveBeenCalledTimes(1);
    expect(mocks.databaseReleaseSession).toHaveBeenCalledOnce();
  });

  it('returns a committed lifecycle mutation when advisory unlock cleanup fails', async () => {
    mocks.databaseSessionQuery.mockImplementation(async (statement: string) => {
      if (statement.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: true }] };
      }
      if (statement.includes('pg_advisory_unlock')) {
        throw new Error('Pinned session disconnected during cleanup.');
      }
      return { rows: [] };
    });

    await expect(
      recordExplicitOpportunityDecision({
        decision: 'reject',
        opportunityId: 'opp-found',
        user: { id: 'user-1' },
      }),
    ).resolves.toMatchObject({ status: 'reject' });

    expect(mocks.collections.get('Decision')?.records).toHaveLength(1);
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'rejected',
    });
    expect(mocks.databaseReleaseSession).toHaveBeenCalledOnce();
  });

  it('routes Maybe through an active recommendation task and its audit record', async () => {
    const result = await recordExplicitOpportunityDecision({
      decision: 'maybe',
      opportunityId: 'opp-recommended',
      reason: 'Revisit after company research',
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({
      opportunityId: 'opp-recommended',
      status: 'maybe',
      taskId: 'task-recommended',
    });
    expect(mocks.collections.get('Decision')?.records[0]).toMatchObject({
      decision: 'defer',
      opportunityId: 'opp-recommended',
      taskId: 'task-recommended',
    });
    expect(mocks.collections.get('Opportunity')?.records[1]).toMatchObject({
      humanReviewStatus: 'maybe',
      status: 'recommended',
    });
    expect(mocks.collections.get('Task')?.records[0]).toMatchObject({
      kanbanColumn: 'follow_up',
      status: 'open',
    });
  });

  it('does not let Maybe or Reject contradict an existing application lifecycle', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          id: 'app-1',
          opportunityId: 'opp-found',
          status: 'application_drafting',
        }),
      ]),
    );

    await expectHttpError(
      () =>
        recordExplicitOpportunityDecision({
          decision: 'reject',
          opportunityId: 'opp-found',
          user: { id: 'user-1' },
        }),
      'A non-apply decision cannot replace the lifecycle of an existing application. Update the application instead.',
      409,
    );
    expect(mocks.collections.get('Decision')?.records).toHaveLength(0);
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'found',
    });
  });

  it('allows a new disposition after an existing application is terminal', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          id: 'app-1',
          opportunityId: 'opp-found',
          status: 'withdrawn',
        }),
      ]),
    );

    const result = await recordExplicitOpportunityDecision({
      decision: 'reject',
      opportunityId: 'opp-found',
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({ status: 'reject' });
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      humanReviewStatus: 'reject',
      status: 'rejected',
    });
  });
});

describe('submission validation and follow-up tasks', () => {
  it('requires method, timestamp, actor, and approval for agent submission', () => {
    const submittedAt = new Date('2026-06-04T12:00:00.000Z');
    const finalApproval = {
      finalApprovalAt: new Date('2026-06-04T10:00:00.000Z'),
      finalApprovalKind: 'final_submission',
      finalApprovedByUserId: 'user-1',
    };
    expect(
      validateSubmittedApplicationPayload({
        payload: {
          status: 'submitted',
          submittedAt: new Date(),
          submittedByRole: 'owner',
        },
        user: { id: 'user-1' },
      }),
    ).toBe('Submitted applications require a submission method.');
    expect(
      validateSubmittedApplicationPayload({
        payload: {
          status: 'submitted',
          submittedAt: new Date(),
          submittedByRole: 'agent_with_approval',
          submissionEvidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
        },
      }),
    ).toBe('Submitted applications require final application approval.');
    expect(
      validateSubmittedApplicationPayload({
        payload: {
          status: 'submitted',
          submittedAt: new Date(),
          submittedByRole: 'owner',
          submittedByUserId: 'user-1',
          submissionEvidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
        },
        user: { id: 'user-1' },
      }),
    ).toBe('Submitted applications require final application approval.');
    expect(
      validateSubmittedApplicationPayload({
        currentRecord: { approvedByUserId: 'user-1', ...finalApproval },
        payload: {
          status: 'submitted',
          submittedAt: new Date(),
          submittedByRole: 'agent_with_approval',
          submissionEvidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
        },
      }),
    ).toBeNull();
    expect(
      validateSubmittedApplicationPayload({
        currentRecord: { approvedByUserId: 'user-1', ...finalApproval },
        payload: {
          status: 'submitted',
          submittedAt: new Date(),
          submittedByRole: 'agent_with_approval',
          submissionMethod: 'company_site',
        },
      }),
    ).toBe('Submitted applications require submission evidence.');
    expect(
      validateSubmittedApplicationPayload({
        currentRecord: { approvedByUserId: 'user-1', ...finalApproval },
        payload: {
          status: 'submitted',
          submittedAt: new Date(),
          submittedByRole: 'agent_with_approval',
          submissionEvidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'fax',
        },
      }),
    ).toBe('Invalid submission method: fax.');
    expect(
      validateSubmittedApplicationPayload({
        currentRecord: {
          approvedByUserId: 'user-1',
          ...finalApproval,
          status: 'submitted',
          submittedAt,
          submittedByRole: 'agent_with_approval',
          submissionEvidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
        },
        payload: {
          status: 'submitted',
          submissionEvidenceUrl: '',
        },
      }),
    ).toBe('Submitted applications require submission evidence.');
    expect(
      validateSubmittedApplicationPayload({
        currentRecord: {
          approvedByUserId: 'user-1',
          ...finalApproval,
          status: 'submitted',
          submittedAt,
          submittedByRole: 'agent_with_approval',
          submissionEvidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
        },
        payload: {
          finalApprovalKind: '',
          status: 'submitted',
        },
      }),
    ).toBe('Submitted applications require final application approval.');
  });

  beforeEach(() => {
    mocks.collections.clear();
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValue({ affected: 1 });
    mocks.collections.set(
      'Application',
      collection([
        record({
          approvedAt: new Date('2026-06-04T10:00:00.000Z'),
          approvedByUserId: 'user-1',
          finalApprovalAt: new Date('2026-06-04T10:00:00.000Z'),
          finalApprovalKind: 'final_submission',
          finalApprovedByUserId: 'user-1',
          applicationUrl: 'https://example.com/approved-destination',
          id: 'app-1',
          opportunityId: 'opp-1',
          status: 'approved',
        }),
      ]),
    );
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-1',
          id: 'task-1',
          status: 'open',
          taskType: 'submit_application',
        }),
      ]),
    );
    mocks.collections.set('AgentRun', collection());
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opp-1', status: 'apply' })]),
    );
  });

  it('records approved agent submission, audit, and follow-up tasks', async () => {
    const result = await recordApplicationSubmission({
      approvalMaterialsCurrent: async () => true,
      applicationId: 'app-1',
      evidenceUrl: 'https://example.com/receipt',
      submissionMethod: 'company_site',
      submittedByRole: 'agent_with_approval',
      taskId: 'task-1',
      user: { id: 'user-1' },
    });

    const tasks = mocks.collections.get('Task')?.records ?? [];
    expect(result).toMatchObject({
      applicationUrl: 'https://example.com/approved-destination',
      status: 'submitted',
      submittedByRole: 'agent_with_approval',
      submissionEvidenceUrl: 'https://example.com/receipt',
      submissionMethod: 'company_site',
    });
    expect(tasks.find((task) => task.id === 'task-1')).toMatchObject({
      kanbanColumn: 'submitted',
      status: 'done',
    });
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskType: 'follow_up' }),
        expect.objectContaining({ taskType: 'check_status' }),
      ]),
    );
    expect(mocks.collections.get('AgentRun')?.records[0]).toMatchObject({
      applicationId: 'app-1',
      externalActionType: 'submit_application',
      runType: 'application_submission',
      status: 'succeeded',
    });
    expect(mocks.collections.get('Opportunity')?.records[0]).toMatchObject({
      status: 'applied',
    });
  });

  it('does not change submission state when its audit record cannot be saved', async () => {
    mocks.collections
      .get('AgentRun')
      ?.create.mockRejectedValueOnce(new Error('Audit storage unavailable.'));

    await expect(
      recordApplicationSubmission({
        approvalMaterialsCurrent: async () => true,
        applicationId: 'app-1',
        evidenceUrl: 'https://example.com/receipt',
        submissionMethod: 'company_site',
        submittedByRole: 'agent_with_approval',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toThrow('Audit storage unavailable.');

    const application = mocks.collections.get('Application')?.records[0];
    expect(application).toMatchObject({ status: 'approved' });
    expect(application?.save).not.toHaveBeenCalled();
  });

  it('does not mark a stale final approval submitted', async () => {
    mocks.databaseUpdate.mockResolvedValueOnce({ affected: 0 });

    await expect(
      recordApplicationSubmission({
        approvalMaterialsCurrent: async () => true,
        applicationId: 'app-1',
        evidenceUrl: 'https://example.com/receipt',
        submissionMethod: 'company_site',
        submittedByRole: 'agent_with_approval',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application changed after final approval; submission state was not recorded.',
      },
      status: 409,
    });

    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      status: 'approved',
    });
    expect(mocks.collections.get('Task')?.records[0]).toMatchObject({
      status: 'open',
    });
  });

  it('rejects agent submission without approval', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          id: 'app-2',
          opportunityId: 'opp-2',
          status: 'application_drafting',
        }),
      ]),
    );

    await expectHttpError(
      () =>
        recordApplicationSubmission({
          applicationId: 'app-2',
          evidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
          submittedByRole: 'agent_with_approval',
          user: { id: 'user-1' },
        }),
      'Application status cannot transition from application_drafting to submitted.',
    );
  });

  it('does not let recording an owner submission mint final approval', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          approvedAt: new Date('2026-06-04T10:00:00.000Z'),
          approvedByUserId: 'user-1',
          id: 'app-2',
          opportunityId: 'opp-2',
          status: 'approved',
        }),
      ]),
    );
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-2',
          id: 'task-2',
          status: 'open',
          taskType: 'submit_application',
        }),
      ]),
    );

    await expectHttpError(
      () =>
        recordApplicationSubmission({
          applicationId: 'app-2',
          evidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
          submittedByRole: 'owner',
          taskId: 'task-2',
          user: { id: 'user-1' },
        }),
      'Submitted applications require final application approval.',
    );

    expect(mocks.collections.get('Application')?.records[0]).not.toHaveProperty(
      'finalApprovalKind',
    );
    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      status: 'approved',
    });
  });

  it('rejects recording submission when final-approved materials are stale', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          approvedAt: new Date('2026-06-04T10:00:00.000Z'),
          approvedByUserId: 'user-1',
          finalApprovalAt: new Date('2026-06-04T10:00:00.000Z'),
          finalApprovalKind: 'final_submission',
          finalApprovedByUserId: 'user-1',
          finalApprovalMaterialsJson: '[{"materialType":"resume"}]',
          id: 'app-3',
          opportunityId: 'opp-3',
          status: 'approved',
        }),
      ]),
    );
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-3',
          id: 'task-3',
          status: 'open',
          taskType: 'submit_application',
        }),
      ]),
    );

    await expectHttpError(
      () =>
        recordApplicationSubmission({
          approvalMaterialsCurrent: async () => false,
          applicationId: 'app-3',
          evidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
          submittedByRole: 'owner',
          taskId: 'task-3',
          user: { id: 'user-1' },
        }),
      'Application materials changed or could not be verified after final approval.',
    );

    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      status: 'approved',
    });
    expect(mocks.collections.get('AgentRun')?.records[0]).toMatchObject({
      runType: 'application_submission_blocked',
      status: 'failed',
    });
  });

  it('rejects submission tasks from a different application before saving', async () => {
    mocks.collections.get('Task')?.records.push(
      record({
        applicationId: 'app-2',
        id: 'task-other',
        status: 'open',
        taskType: 'submit_application',
      }),
    );

    await expectHttpError(
      () =>
        recordApplicationSubmission({
          applicationId: 'app-1',
          evidenceUrl: 'https://example.com/receipt',
          submissionMethod: 'company_site',
          submittedByRole: 'agent_with_approval',
          taskId: 'task-other',
          user: { id: 'user-1' },
        }),
      'Submission task does not belong to this application.',
    );

    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      status: 'approved',
    });
    expect(mocks.collections.get('AgentRun')?.records).toHaveLength(0);
    expect(
      mocks.collections
        .get('Task')
        ?.records.find((task) => task.id === 'task-other'),
    ).toMatchObject({
      status: 'open',
    });
  });

  it('records blocked agent submission attempts without creating submitted follow-ups', async () => {
    const result = await recordApplicationSubmissionBlocker({
      applicationId: 'app-1',
      blockerOwnerRole: 'owner',
      blockerReason: '2FA required before submission can continue.',
      blockerType: '2fa',
      taskId: 'task-1',
      user: { id: 'user-1' },
    });

    const tasks = mocks.collections.get('Task')?.records ?? [];
    expect(result.application).toMatchObject({ status: 'awaiting_user' });
    expect(tasks.find((task) => task.id === 'task-1')).toMatchObject({
      blockerOwnerRole: 'owner',
      blockerReason: '2FA required before submission can continue.',
      kanbanColumn: 'blocked',
      status: 'blocked',
      taskType: 'submit_application',
    });
    expect(tasks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskType: 'follow_up' }),
        expect.objectContaining({ taskType: 'check_status' }),
      ]),
    );
    expect(mocks.collections.get('AgentRun')?.records[0]).toMatchObject({
      applicationId: 'app-1',
      error: '2FA required before submission can continue.',
      externalActionType: 'submit_application',
      runType: 'application_submission_blocked',
      status: 'failed',
      taskId: 'task-1',
    });
  });

  it('does not reroute a blocker when its guarded application write loses a race', async () => {
    mocks.databaseUpdate.mockResolvedValueOnce({ affected: 0 });

    await expect(
      recordApplicationSubmissionBlocker({
        applicationId: 'app-1',
        blockerReason: '2FA required before submission can continue.',
        blockerType: '2fa',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application changed before its submission blocker could be recorded. Reload and review the current application.',
      },
      status: 409,
    });

    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      status: 'approved',
    });
    expect(mocks.collections.get('Task')?.records[0]).toMatchObject({
      status: 'open',
    });
  });

  it('does not reroute an application when blocker audit storage fails', async () => {
    mocks.collections
      .get('AgentRun')
      ?.create.mockRejectedValueOnce(new Error('Audit storage unavailable.'));

    await expect(
      recordApplicationSubmissionBlocker({
        applicationId: 'app-1',
        blockerReason: '2FA required before submission can continue.',
        blockerType: '2fa',
        taskId: 'task-1',
        user: { id: 'user-1' },
      }),
    ).rejects.toThrow('Audit storage unavailable.');

    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      status: 'approved',
    });
    expect(
      mocks.collections.get('Application')?.records[0]?.save,
    ).not.toHaveBeenCalled();
    expect(mocks.collections.get('Task')?.records[0]).toMatchObject({
      status: 'open',
    });
    expect(
      mocks.collections.get('Task')?.records[0]?.save,
    ).not.toHaveBeenCalled();
  });

  it('rejects creating submission blockers before an application is approved', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          id: 'app-2',
          opportunityId: 'opp-2',
          status: 'application_drafting',
        }),
      ]),
    );

    await expectHttpError(
      () =>
        recordApplicationSubmissionBlocker({
          applicationId: 'app-2',
          blockerReason: 'Missing answer.',
          user: { id: 'user-1' },
        }),
      'Submission blocker requires an active submission task or an approved application.',
    );

    expect(mocks.collections.get('Task')?.records).toHaveLength(1);
    expect(mocks.collections.get('AgentRun')?.records).toHaveLength(0);
  });
});

describe('syncApplicationWorkflowTasks phase reconciliation', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.collections.set('Task', collection());
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opp-1', status: 'apply' })]),
    );
  });

  it('creates a submit task for applications already in submitting state', async () => {
    await expect(
      syncApplicationWorkflowTasks({
        accountStatus: 'unknown',
        id: 'app-1',
        opportunityId: 'opp-1',
        status: 'submitting',
      }),
    ).resolves.toMatchObject({ closed: 0, created: 1 });

    expect(mocks.collections.get('Task')?.records[0]).toMatchObject({
      applicationId: 'app-1',
      kanbanColumn: 'submitting',
      taskType: 'submit_application',
    });
  });

  it('closes stale submit tasks once an application is submitted without a task action', async () => {
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-1',
          id: 'task-submit',
          kanbanColumn: 'approved_to_submit',
          status: 'open',
          taskType: 'submit_application',
        }),
      ]),
    );

    await expect(
      syncApplicationWorkflowTasks({
        accountStatus: 'unknown',
        id: 'app-1',
        opportunityId: 'opp-1',
        status: 'submitted',
        submittedAt: new Date('2026-06-04T12:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ closed: 1, created: 2 });

    const tasks = mocks.collections.get('Task')?.records ?? [];
    expect(tasks.find((task) => task.id === 'task-submit')).toMatchObject({
      completedAt: expect.any(Date),
      kanbanColumn: 'submitted',
      status: 'done',
    });
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskType: 'follow_up' }),
        expect.objectContaining({ taskType: 'check_status' }),
      ]),
    );
  });

  it('preserves blocked future-stage tasks while an application is awaiting Will', async () => {
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-1',
          blockerReason: '2FA required.',
          externalTaskId: 'submit-application:app-1',
          id: 'task-submit',
          kanbanColumn: 'blocked',
          status: 'blocked',
          taskType: 'submit_application',
        }),
      ]),
    );

    await expect(
      syncApplicationWorkflowTasks({
        accountStatus: 'unknown',
        id: 'app-1',
        opportunityId: 'opp-1',
        status: 'awaiting_user',
      }),
    ).resolves.toMatchObject({ closed: 0, created: 1 });

    const tasks = mocks.collections.get('Task')?.records ?? [];
    expect(tasks.find((task) => task.id === 'task-submit')).toMatchObject({
      blockerReason: '2FA required.',
      kanbanColumn: 'blocked',
      status: 'blocked',
    });
    expect(tasks).toContainEqual(
      expect.objectContaining({
        applicationId: 'app-1',
        taskType: 'approve_application',
      }),
    );
  });
});

describe('syncSourceAccountTasks', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.collections.set('Task', collection());
  });

  it('normalizes blank account statuses and rejects unknown values before sync', () => {
    expect(normalizeAccountStatus('')).toBe('unknown');
    expect(normalizeAccountStatus('needs_2fa')).toBe('needs_2fa');
    expect(() => normalizeAccountStatus('needs_magic')).toThrow();
  });

  it('creates an owner account handoff task using the configured identity', async () => {
    const originalAppName = process.env.IOLAUS_APP_NAME;
    process.env.IOLAUS_APP_NAME = 'Career Hub';
    try {
      await expect(
        syncSourceAccountTasks({
          accountNotes: '2FA blocks crawler',
          accountStatus: 'needs_2fa',
          id: 'source-1',
          loginIdentity: 'jobs@example.com',
          name: 'Greenhouse',
          wardenReference: 'Employment Search/Greenhouse',
        }),
      ).resolves.toMatchObject({ created: 1 });
    } finally {
      if (originalAppName === undefined) delete process.env.IOLAUS_APP_NAME;
      else process.env.IOLAUS_APP_NAME = originalAppName;
    }

    expect(mocks.collections.get('Task')?.records[0]).toMatchObject({
      assigneeRole: 'owner',
      kanbanColumn: 'needs_account_credentials',
      sourceId: 'source-1',
      taskType: 'account_setup',
    });
    expect(
      String(mocks.collections.get('Task')?.records[0]?.description),
    ).toContain(
      'Do not store passwords, tokens, cookies, recovery codes, or decrypted secret values in Career Hub.',
    );
  });

  it('closes stale source account handoff tasks when the account is resolved', async () => {
    mocks.collections.set(
      'Task',
      collection([
        record({
          externalTaskId: 'source-account:source-1:needs_2fa',
          id: 'task-1',
          kanbanColumn: 'needs_account_credentials',
          sourceId: 'source-1',
          status: 'open',
          taskType: 'account_setup',
        }),
      ]),
    );

    await expect(
      syncSourceAccountTasks({
        accountStatus: 'active',
        id: 'source-1',
        name: 'Greenhouse',
      }),
    ).resolves.toMatchObject({ closed: 1, created: 0 });

    expect(mocks.collections.get('Task')?.records[0]).toMatchObject({
      completedAt: expect.any(Date),
      status: 'done',
    });
  });
});

describe('syncApplicationWorkflowTasks account reconciliation', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-1',
          externalTaskId: 'application-account:app-1:needs_login',
          id: 'task-1',
          kanbanColumn: 'needs_account_credentials',
          status: 'open',
          taskType: 'account_setup',
        }),
      ]),
    );
  });

  it('closes stale application account tasks when the account is resolved', async () => {
    await expect(
      syncApplicationWorkflowTasks({
        accountStatus: 'active',
        id: 'app-1',
        status: 'awaiting_user',
      }),
    ).resolves.toMatchObject({ created: 1 });

    const tasks = mocks.collections.get('Task')?.records ?? [];
    expect(tasks.find((task) => task.id === 'task-1')).toMatchObject({
      completedAt: expect.any(Date),
      status: 'done',
    });
    expect(tasks).toContainEqual(
      expect.objectContaining({
        applicationId: 'app-1',
        taskType: 'approve_application',
      }),
    );
  });

  it('keeps the application account check task open while account status is unknown', async () => {
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-1',
          externalTaskId: 'application-account:app-1:check',
          id: 'task-1',
          kanbanColumn: 'needs_account_credentials',
          status: 'open',
          taskType: 'account_setup',
        }),
      ]),
    );

    await expect(
      syncApplicationWorkflowTasks({
        accountStatus: 'unknown',
        id: 'app-1',
        status: 'awaiting_user',
      }),
    ).resolves.toMatchObject({ created: 1 });

    expect(
      mocks.collections
        .get('Task')
        ?.records.find((task) => task.id === 'task-1'),
    ).toMatchObject({
      status: 'open',
    });
  });

  it('closes legacy application account check tasks when the account is resolved', async () => {
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-1',
          externalTaskId: 'account-check:app-1',
          id: 'task-1',
          kanbanColumn: 'needs_account_credentials',
          status: 'open',
          taskType: 'account_setup',
        }),
      ]),
    );

    await syncApplicationWorkflowTasks({
      accountStatus: 'active',
      id: 'app-1',
      status: 'awaiting_user',
    });

    expect(
      mocks.collections
        .get('Task')
        ?.records.find((task) => task.id === 'task-1'),
    ).toMatchObject({
      completedAt: expect.any(Date),
      status: 'done',
    });
  });

  it('rejects invalid application account status without closing account tasks', async () => {
    await expectHttpError(
      () =>
        syncApplicationWorkflowTasks({
          accountStatus: 'needs_magic',
          id: 'app-1',
          status: 'awaiting_user',
        }),
      'Invalid account status.',
    );

    const task = mocks.collections.get('Task')?.records[0];
    expect(task?.completedAt).toBeUndefined();
    expect(task).toMatchObject({ status: 'open' });
  });
});

describe('routeApplicationToAnswerCollection', () => {
  it('does not create tasks when its guarded application status write loses a race', async () => {
    mocks.collections.clear();
    mocks.collections.set('Task', collection());
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValue({ affected: 0 });

    await expect(
      routeApplicationToAnswerCollection({
        application: { id: 'app-1', status: 'approved' },
        questions: [{ id: 'q1', label: 'Work authorization?' }],
      }),
    ).resolves.toEqual({ created: false });

    expect(mocks.collections.get('Task')?.records).toHaveLength(0);
  });
});

describe('recordApplicationFormAnswers', () => {
  const schemaJson = JSON.stringify({
    ats: 'greenhouse',
    boardToken: 'acme',
    fetchedAt: '2026-06-10T00:00:00.000Z',
    jobId: '123',
    questions: [
      {
        id: 'q_cover',
        label: 'Why this role?',
        required: true,
        type: 'textarea',
      },
      {
        id: 'q_start',
        label: 'Start date?',
        required: true,
        type: 'input_text',
      },
    ],
  });

  function formRequest(fields: Record<string, string>): Request {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    return new Request('http://localhost/?/provideAnswers', {
      body,
      method: 'POST',
    });
  }

  function setupApplication(
    requiredAnswersJson: string,
    overrides: Record<string, unknown> = {},
  ) {
    mocks.collections.clear();
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opp-1', status: 'apply' })]),
    );
    mocks.collections.set(
      'Application',
      collection([
        record({
          accountStatus: 'none_needed',
          id: 'app-1',
          opportunityId: 'opp-1',
          requiredAnswersJson,
          requiredQuestionsJson: schemaJson,
          status: 'awaiting_user',
          ...overrides,
        }),
      ]),
    );
    mocks.collections.set(
      'CandidateProfile',
      collection([
        record({ active: true, id: 'profile-1', profileKey: 'default' }),
      ]),
    );
    mocks.collections.set(
      'Task',
      collection([
        record({
          applicationId: 'app-1',
          externalTaskId: 'collect-application-answers:app-1',
          id: 'task-collect',
          kanbanColumn: 'inbox',
          status: 'open',
          taskType: 'collect_application_answers',
        }),
      ]),
    );
  }

  beforeEach(() => {
    mocks.databaseUpdate.mockReset();
    mocks.databaseUpdate.mockResolvedValue({ affected: 1 });
  });

  it('saves schema-known answers, ignores unknown ids, and clears blanked answers', async () => {
    setupApplication(
      JSON.stringify({ q_cover: 'Existing cover answer.', q_extra: 'Temp' }),
    );

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({
        'answer:q_cover': '', // blank on a prefilled field -> deliberate clearing
        'answer:q_start': '2026-08-01',
        'answer:q_unknown': 'ignored', // not in schema -> dropped
      }),
    );

    // q_cover is required and now cleared, so the application is incomplete.
    expect(result).toMatchObject({ complete: false, saved: 2 });
    const application = mocks.collections.get('Application')?.records[0];
    expect(JSON.parse(String(application?.requiredAnswersJson))).toEqual({
      q_extra: 'Temp',
      q_start: '2026-08-01',
    });
    expect(
      mocks.collections
        .get('Task')
        ?.records.find((task) => task.id === 'task-collect'),
    ).toMatchObject({ status: 'open' });
  });

  it('keeps the collect task open while a required answer is still missing', async () => {
    setupApplication('{}');

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({ 'answer:q_cover': 'Because it fits.' }),
    );

    expect(result).toMatchObject({ complete: false, saved: 1 });
    const application = mocks.collections.get('Application')?.records[0];
    expect(JSON.parse(String(application?.requiredAnswersJson))).toEqual({
      q_cover: 'Because it fits.',
    });
    expect(
      mocks.collections
        .get('Task')
        ?.records.find((task) => task.id === 'task-collect'),
    ).toMatchObject({ status: 'open' });
  });

  it('clears final approval when a structured ATS answer changes', async () => {
    setupApplication('{}', {
      approvedAt: new Date('2026-06-04T10:00:00.000Z'),
      approvedByUserId: 'user-1',
      finalApprovalAt: new Date('2026-06-04T10:00:00.000Z'),
      finalApprovalKind: 'final_submission',
      finalApprovedByUserId: 'user-1',
      finalApprovalMaterialsJson: '[{"materialType":"answers"}]',
      status: 'approved',
    });

    await recordApplicationFormAnswers(
      'app-1',
      formRequest({
        'answer:q_cover': 'Because it fits.',
        'answer:q_start': '2026-08-01',
      }),
    );

    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      finalApprovalAt: null,
      finalApprovalKind: '',
      finalApprovedByUserId: '',
      finalApprovalMaterialsJson: '[]',
      status: 'awaiting_user',
    });
  });

  it('does not overwrite a concurrently changed application while saving answers', async () => {
    setupApplication('{}');
    mocks.databaseUpdate.mockResolvedValueOnce({ affected: 0 });

    await expect(
      recordApplicationFormAnswers(
        'app-1',
        formRequest({ 'answer:q_cover': 'Because it fits.' }),
      ),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application changed before answers could be saved. Reload and review the current application.',
      },
      status: 409,
    });

    expect(mocks.collections.get('Application')?.records[0]).toMatchObject({
      requiredAnswersJson: '{}',
      status: 'awaiting_user',
    });
    expect(
      mocks.collections
        .get('Task')
        ?.records.find((task) => task.id === 'task-collect'),
    ).toMatchObject({ status: 'open' });
  });

  it('rejects applications with no fetched form schema', async () => {
    setupApplication('{}');
    const application = mocks.collections.get('Application')?.records[0];
    if (application) application.requiredQuestionsJson = '';

    await expectHttpError(
      () =>
        recordApplicationFormAnswers(
          'app-1',
          formRequest({ 'answer:q_cover': 'x' }),
        ),
      'This application has no fetched form questions to answer.',
    );
  });

  it('refuses to mutate answers once the application is submitted', async () => {
    setupApplication(JSON.stringify({ q_cover: 'A.' }));
    const application = mocks.collections.get('Application')?.records[0];
    if (application) application.status = 'submitted';

    let thrown: unknown;
    try {
      await recordApplicationFormAnswers(
        'app-1',
        formRequest({ 'answer:q_start': '2026-08-01' }),
      );
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toMatchObject({ status: 409 });
    expect(JSON.parse(String(application?.requiredAnswersJson))).toEqual({
      q_cover: 'A.',
    });
  });

  it('drops text submitted against a file-type question id', async () => {
    mocks.collections.clear();
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opp-1', status: 'apply' })]),
    );
    mocks.collections.set(
      'Application',
      collection([
        record({
          accountStatus: 'none_needed',
          id: 'app-1',
          opportunityId: 'opp-1',
          requiredAnswersJson: '{}',
          requiredQuestionsJson: JSON.stringify({
            ats: 'greenhouse',
            boardToken: 'acme',
            fetchedAt: '2026-06-10T00:00:00.000Z',
            jobId: '123',
            questions: [
              {
                id: 'resume',
                label: 'Resume',
                required: true,
                type: 'input_file',
              },
            ],
          }),
          status: 'awaiting_user',
        }),
      ]),
    );
    mocks.collections.set('Task', collection());

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({ 'answer:resume': 'not a file' }),
    );

    expect(result).toMatchObject({ saved: 0 });
    const application = mocks.collections.get('Application')?.records[0];
    expect(JSON.parse(String(application?.requiredAnswersJson))).toEqual({});
  });

  it('saves a reusable library copy when the reuse flag is set', async () => {
    setupApplication('{}');
    mocks.collections.set('CandidateAnswer', collection());

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({
        'answer:q_cover': 'Developer experience is my focus.',
        'reuse:q_cover': 'on',
      }),
    );

    expect(result).toMatchObject({ saved: 1, savedForReuse: 1 });
    const library = mocks.collections.get('CandidateAnswer')?.records;
    expect(library).toHaveLength(1);
    expect(library?.[0]).toMatchObject({
      active: true,
      label: 'Why this role?',
      labelKey: 'why this role%3f',
      profileKey: 'default',
      value: 'Developer experience is my focus.',
    });
  });

  it('updates the existing reusable entry instead of duplicating it', async () => {
    setupApplication(JSON.stringify({ q_cover: 'Old stored answer.' }));
    mocks.collections.set(
      'CandidateAnswer',
      collection([
        record({
          active: true,
          id: 'lib-1',
          label: 'Why this role?',
          labelKey: 'why this role',
          profileKey: 'default',
          value: 'Old reusable answer.',
        }),
      ]),
    );

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({
        'answer:q_cover': 'Refreshed answer.',
        'reuse:q_cover': 'on',
      }),
    );

    const library = mocks.collections.get('CandidateAnswer')?.records;
    expect(result.savedForReuse).toBe(1);
    expect(library).toHaveLength(1);
    expect(library?.[0]).toMatchObject({
      id: 'lib-1',
      labelKey: 'why this role%3f',
      value: 'Refreshed answer.',
    });
  });

  it('saves reuse without rewriting the application when no answer changed', async () => {
    setupApplication(JSON.stringify({ q_start: '2026-08-01' }));
    mocks.collections.set('CandidateAnswer', collection());
    const applicationBefore = {
      ...mocks.collections.get('Application')?.records[0],
    };

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({
        'answer:q_start': '2026-08-01',
        'reuse:q_start': 'on',
      }),
    );

    // The answer is unchanged, so no application-scoped write (and no approval
    // invalidation) happens — but the library copy is still recorded.
    expect(result).toMatchObject({ saved: 0, savedForReuse: 1 });
    const application = mocks.collections.get('Application')?.records[0];
    expect(application?.save).not.toHaveBeenCalled();
    expect(application).toMatchObject({
      requiredAnswersJson: applicationBefore.requiredAnswersJson,
      status: 'awaiting_user',
    });
    expect(mocks.collections.get('CandidateAnswer')?.records).toMatchObject([
      { labelKey: 'start date%3f', value: '2026-08-01' },
    ]);
  });

  it('never saves a blank or unknown answer for reuse', async () => {
    setupApplication('{}');
    mocks.collections.set('CandidateAnswer', collection());

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({
        'answer:q_cover': '',
        'reuse:q_cover': 'on',
        'reuse:q_start': 'on',
        'reuse:q_unknown': 'on',
      }),
    );

    expect(result).toMatchObject({ saved: 0, savedForReuse: 0 });
    expect(mocks.collections.get('CandidateAnswer')?.records).toHaveLength(0);
  });

  it('refuses reuse for a question the schema does not know', async () => {
    setupApplication('{}');
    mocks.collections.set('CandidateAnswer', collection());

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({ 'reuse:resume': 'on' }),
    );

    expect(result.savedForReuse).toBe(0);
    expect(mocks.collections.get('CandidateAnswer')?.records).toHaveLength(0);
  });

  it('withdraws a reusable copy when the unreuse flag is set', async () => {
    setupApplication(JSON.stringify({ q_cover: 'Stored answer.' }));
    mocks.collections.set(
      'CandidateAnswer',
      collection([
        record({
          active: true,
          id: 'lib-1',
          label: 'Why this role?',
          labelKey: 'why this role%3f',
          profileKey: 'default',
          value: 'Saved reusable answer.',
        }),
      ]),
    );

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({ 'unreuse:q_cover': 'on' }),
    );

    expect(result).toMatchObject({ revokedForReuse: 1 });
    // Soft revoke: history stays, future seeding stops.
    const library = mocks.collections.get('CandidateAnswer')?.records;
    expect(library?.[0]).toMatchObject({ id: 'lib-1', active: false });
    // No answer changed, so the application record was never written.
    const application = mocks.collections.get('Application')?.records[0];
    expect(application?.save).not.toHaveBeenCalled();
  });

  it('deactivates duplicate library rows when saving for reuse', async () => {
    setupApplication(JSON.stringify({ q_cover: 'Stored.' }));
    mocks.collections.set(
      'CandidateAnswer',
      collection([
        record({
          active: true,
          id: 'dup-1',
          label: 'Why this role?',
          labelKey: 'why this role%3f',
          profileKey: 'default',
          value: 'First duplicate.',
        }),
        record({
          active: true,
          id: 'dup-2',
          label: 'Why this role?',
          labelKey: 'why this role%3f',
          profileKey: 'default',
          value: 'Second duplicate.',
        }),
      ]),
    );

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({
        'answer:q_cover': 'Canonical answer.',
        'reuse:q_cover': 'on',
      }),
    );

    expect(result.savedForReuse).toBe(1);
    const library = mocks.collections.get('CandidateAnswer')?.records ?? [];
    expect(library.filter((row) => row.active === false).length).toBe(1);
    expect(library.filter((row) => row.active !== false).length).toBe(1);
    expect(library.find((row) => row.active !== false)).toMatchObject({
      value: 'Canonical answer.',
    });
  });

  it('keeps the reuse save when a question is ticked for both save and revoke', async () => {
    setupApplication(JSON.stringify({ q_cover: 'Stored answer.' }));
    mocks.collections.set(
      'CandidateAnswer',
      collection([
        record({
          active: true,
          id: 'lib-1',
          label: 'Why this role?',
          labelKey: 'why this role%3f',
          profileKey: 'default',
          value: 'Saved reusable answer.',
        }),
      ]),
    );

    const result = await recordApplicationFormAnswers(
      'app-1',
      formRequest({
        'answer:q_cover': 'Updated answer.',
        'reuse:q_cover': 'on',
        'unreuse:q_cover': 'on',
      }),
    );

    expect(result).toMatchObject({ savedForReuse: 1, revokedForReuse: 0 });
    expect(mocks.collections.get('CandidateAnswer')?.records[0]).toMatchObject({
      active: true,
      value: 'Updated answer.',
    });
  });
});

describe('revokeReusableAnswerByLabelKey', () => {
  it('deactivates reusable copies without touching any application, even submitted ones', async () => {
    mocks.collections.clear();
    mocks.collections.set(
      'CandidateProfile',
      collection([
        record({ active: true, id: 'profile-1', profileKey: 'default' }),
      ]),
    );
    const row = record({
      active: true,
      id: 'lib-1',
      label: 'Why this role?',
      labelKey: 'why this role',
      profileKey: 'default',
      value: 'Saved reusable answer.',
    });
    mocks.collections.set('CandidateAnswer', collection([row]));
    const submittedApplication = record({
      id: 'app-1',
      status: 'submitted',
      submittedAt: new Date('2026-08-20T00:00:00.000Z'),
    });
    mocks.collections.set('Application', collection([submittedApplication]));

    const result = await revokeReusableAnswerByLabelKey('why this role%3f');

    expect(result).toBe(1);
    expect(row.active).toBe(false);
    expect(submittedApplication.save).not.toHaveBeenCalled();
  });

  it('rejects an empty label key', async () => {
    mocks.collections.clear();
    mocks.collections.set('CandidateProfile', collection());
    await expectHttpError(
      () => revokeReusableAnswerByLabelKey('   '),
      'A reusable answer label key is required.',
    );
  });
});

describe('closeReviewTasksForArchivedOpportunities', () => {
  interface TaskRow extends Record<string, unknown> {
    description: string;
    id: string;
    kanbanColumn: string;
    opportunityId: string;
    status: string;
    taskType: string;
  }

  function taskRow(overrides: Partial<TaskRow> & { id: string }): TaskRow {
    return {
      description: 'Review this posting.',
      kanbanColumn: 'needs_user_decision',
      opportunityId: 'opportunity-1',
      status: 'open',
      taskType: 'review_recommendation',
      ...overrides,
    };
  }

  /**
   * Interprets the one batched statement against in-memory rows so the spec
   * exercises the real parameter contract — the task type, the active-status
   * set, and the opportunity-id set — rather than a canned row count.
   */
  function taskDatabase(rows: TaskRow[]) {
    return {
      query: vi.fn(async (_sql: string, ...vars: unknown[]) => {
        const [kanbanColumn, completedAt, reason, statuses, opportunityIds] =
          vars as [string, Date, string, string[], string[]];
        const matched = rows.filter(
          (row) =>
            row.taskType === 'review_recommendation' &&
            statuses.includes(row.status) &&
            opportunityIds.includes(row.opportunityId),
        );
        for (const row of matched) {
          row.completedAt = completedAt;
          row.description = `${row.description}\n\nClosed automatically: the opportunity was archived (${reason}).`;
          row.kanbanColumn = kanbanColumn;
          row.status = 'canceled';
        }
        return { rows: matched.map((row) => ({ id: row.id })) };
      }),
    };
  }

  beforeEach(() => {
    bumpTaskChangeFeed.mockClear();
    bumpTaskChangeFeed.mockResolvedValue(0);
  });

  /**
   * Issue #459. `tasks` is live-subscribed, and this closure is a raw
   * statement, so without a bump a mounted task list keeps showing review work
   * against a posting auto-archive already closed.
   */
  it('bumps the tasks change feed with the ids it actually closed', async () => {
    const rows = [
      taskRow({ id: 'task-1', opportunityId: 'archived-1' }),
      taskRow({ id: 'task-2', opportunityId: 'archived-2' }),
      taskRow({ id: 'untouched', opportunityId: 'live-1' }),
    ];
    const database = taskDatabase(rows);

    const closed = await closeReviewTasksForArchivedOpportunities({
      archiveReason: 'not_listed',
      database,
      now: new Date('2026-09-03T00:00:00.000Z'),
      opportunityIds: ['archived-1', 'archived-2'],
    });

    expect(closed).toBe(2);
    // The caller's transaction handle, not a fresh one.
    expect(bumpTaskChangeFeed).toHaveBeenCalledWith(database, [
      'task-1',
      'task-2',
    ]);
  });

  it('records nothing when no review task matched', async () => {
    const database = taskDatabase([
      taskRow({ id: 'untouched', opportunityId: 'live-1' }),
    ]);

    const closed = await closeReviewTasksForArchivedOpportunities({
      archiveReason: 'not_listed',
      database,
      now: new Date('2026-09-03T00:00:00.000Z'),
      opportunityIds: ['archived-1'],
    });

    expect(closed).toBe(0);
    expect(bumpTaskChangeFeed).toHaveBeenCalledWith(database, []);
  });

  it('closes the open review task of every auto-archived posting', async () => {
    const rows = [taskRow({ id: 'task-1' })];
    const database = taskDatabase(rows);

    const closed = await closeReviewTasksForArchivedOpportunities({
      archiveReason: 'not_listed',
      database,
      now: new Date('2026-09-03T00:00:00.000Z'),
      opportunityIds: ['opportunity-1', 'opportunity-1', '  '],
    });

    expect(closed).toBe(1);
    expect(rows[0]).toMatchObject({
      kanbanColumn: 'rejected_archived',
      status: 'canceled',
    });
    expect(rows[0].description).toContain(
      'Closed automatically: the opportunity was archived (not_listed).',
    );
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('leaves unrelated tasks untouched', async () => {
    const rows = [
      taskRow({ id: 'target', opportunityId: 'archived-1' }),
      taskRow({ id: 'other-posting', opportunityId: 'live-1' }),
      taskRow({
        id: 'other-type',
        opportunityId: 'archived-1',
        taskType: 'review_opportunity_intelligence',
      }),
      taskRow({
        id: 'already-closed',
        opportunityId: 'archived-1',
        status: 'done',
      }),
    ];

    const closed = await closeReviewTasksForArchivedOpportunities({
      archiveReason: 'source_inactive',
      database: taskDatabase(rows),
      opportunityIds: ['archived-1'],
    });

    expect(closed).toBe(1);
    expect(rows[0].status).toBe('canceled');
    expect(rows[1].status).toBe('open');
    expect(rows[2].status).toBe('open');
    expect(rows[3].status).toBe('done');
  });

  it('issues no statement when nothing was archived', async () => {
    const database = taskDatabase([]);
    const closed = await closeReviewTasksForArchivedOpportunities({
      archiveReason: 'not_listed',
      database,
      opportunityIds: ['', '   '],
    });
    expect(closed).toBe(0);
    expect(database.query).not.toHaveBeenCalled();
  });
});
