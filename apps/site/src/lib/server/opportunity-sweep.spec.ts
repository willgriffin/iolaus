import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  /**
   * The apply runs its `UPDATE` and its `AgentRun` inside one
   * `db.transaction()`, so the fake hands the callback a transaction-scoped
   * handle backed by the same `query` spy and lets a rejection propagate the
   * way a real rollback does.
   */
  const transaction = vi.fn(
    async (run: (tx: { query: typeof query }) => Promise<unknown>) =>
      await run({ query }),
  );
  return {
    bumpChangeFeed: vi.fn(async () => 0),
    closeReviewTasks: vi.fn(async () => 0),
    query,
    recordAgentAudit: vi.fn(),
    requestDatabase: vi.fn(),
    transaction,
  };
});

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({
    query: mocks.query,
    transaction: mocks.transaction,
  })),
}));

vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: mocks.requestDatabase,
}));

vi.mock('./db.js', () => ({ getDbConfig: vi.fn(() => ({})) }));

vi.mock('./change-feed.js', () => ({
  bumpOpportunityChangeFeed: mocks.bumpChangeFeed,
}));

vi.mock('./application-workflow.js', () => ({
  closeReviewTasksForArchivedOpportunities: mocks.closeReviewTasks,
  recordAgentAudit: mocks.recordAgentAudit,
}));

const NOW = new Date('2026-09-02T00:00:00.000Z');

function matchedRows(count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    id: `opportunity-${index}`,
    lastSeenAt: new Date('2026-06-01T00:00:00.000Z'),
    sourceId: `source-${index}`,
    status: index % 2 === 0 ? 'found' : 'recommended',
    title: `Role ${index}`,
  }));
}

/**
 * count → sample → (apply only) `FOR UPDATE SKIP LOCKED` → update.
 *
 * `locked` is what the lock statement returns and `updated` what the archiving
 * statement then matches, so a spec can model a row that another transaction
 * holds (locked < count) and one that gained a protecting artifact after the
 * lock (updated < locked).
 */
function respondWith(count: number, updated = count, locked = updated) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)')) return { rows: [{ count: String(count) }] };
    if (sql.includes('FOR UPDATE')) {
      return { rows: matchedRows(locked).map((row) => ({ id: row.id })) };
    }
    if (sql.trimStart().startsWith('UPDATE')) {
      return { rows: matchedRows(updated).map((row) => ({ id: row.id })) };
    }
    return { rows: matchedRows(Math.min(count, 10)) };
  });
}

async function sweep() {
  return await import('./opportunity-sweep');
}

describe('opportunity-sweep', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.transaction.mockClear();
    mocks.requestDatabase.mockReset();
    mocks.requestDatabase.mockReturnValue(undefined);
    mocks.recordAgentAudit.mockReset();
    mocks.recordAgentAudit.mockResolvedValue({ id: 'agent-run-1' });
    mocks.closeReviewTasks.mockReset();
    mocks.closeReviewTasks.mockResolvedValue(0);
    mocks.bumpChangeFeed.mockReset();
    mocks.bumpChangeFeed.mockResolvedValue(0);
    respondWith(3);
  });

  it('matches only undecided opportunities under an inactive source', async () => {
    const { sweepInactiveSourceOpportunities } = await sweep();

    await sweepInactiveSourceOpportunities({ dryRun: true, now: NOW });

    const [sql, statuses, , reviewStatuses] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain('s.is_active IS NOT TRUE');
    expect(sql).toContain('o.status = ANY($1::text[])');
    expect(sql).toContain('o.last_seen_at IS NOT NULL');
    expect(sql).toContain('o.last_seen_at < $2');
    expect(statuses).toEqual(['found', 'recommended']);
    // A decision is not always encoded in the lifecycle status: "Maybe" and an
    // admin review leave the row in found/recommended, and an accepted posting
    // keeps its Application. All three are excluded from the match.
    expect(sql).toContain(
      "COALESCE(lower(btrim(o.human_review_status)), '') <> ALL($3::text[])",
    );
    expect(sql).toContain(
      'NOT EXISTS (\n      SELECT 1 FROM applications a WHERE a.opportunity_id = o.id\n    )',
    );
    expect(sql).toContain(
      "d.opportunity_id = o.id AND d.decision_by = 'owner'",
    );
    expect(reviewStatuses).toEqual(['apply', 'maybe', 'reject']);
    for (const protectedStatus of [
      'apply',
      'applied',
      'archived',
      'interviewing',
      'rejected',
    ]) {
      expect(statuses).not.toContain(protectedStatus);
    }
  });

  it('defaults to a thirty-day boundary and honours an explicit one', async () => {
    const { DEFAULT_SWEEP_NOT_SEEN_DAYS, sweepInactiveSourceOpportunities } =
      await sweep();
    expect(DEFAULT_SWEEP_NOT_SEEN_DAYS).toBe(30);

    const preview = await sweepInactiveSourceOpportunities({
      dryRun: true,
      now: NOW,
    });
    expect(preview.filter.notSeenDays).toBe(30);
    expect(preview.filter.notSeenBefore).toBe('2026-08-03T00:00:00.000Z');
    expect(mocks.query.mock.calls[0]?.[2]).toEqual(
      new Date('2026-08-03T00:00:00.000Z'),
    );

    mocks.query.mockClear();
    const wider = await sweepInactiveSourceOpportunities({
      dryRun: true,
      notSeenDays: 60,
      now: NOW,
    });
    expect(wider.filter.notSeenBefore).toBe('2026-07-04T00:00:00.000Z');
  });

  it('refuses an out-of-range or non-integer boundary', async () => {
    const { sweepInactiveSourceOpportunities } = await sweep();

    for (const notSeenDays of [0, -1, 1.5, 10_000, 'soon']) {
      await expect(
        sweepInactiveSourceOpportunities({
          dryRun: true,
          notSeenDays,
          now: NOW,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('writes nothing and records no audit on a dry run', async () => {
    respondWith(8_760);
    const { sweepInactiveSourceOpportunities } = await sweep();

    const result = await sweepInactiveSourceOpportunities({
      dryRun: true,
      now: NOW,
    });

    expect(result).toMatchObject({
      applied: false,
      archivedCount: 0,
      auditRunId: '',
      count: 8_760,
      dryRun: true,
    });
    expect(result.sample).toHaveLength(10);
    expect(
      mocks.query.mock.calls.some((call: unknown[]) =>
        String(call[0]).trimStart().startsWith('UPDATE'),
      ),
    ).toBe(false);
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
  });

  it('is a dry run unless the caller explicitly opts out', async () => {
    const { sweepInactiveSourceOpportunities } = await sweep();

    for (const options of [{}, { now: NOW }, { dryRun: true, now: NOW }]) {
      mocks.query.mockClear();
      const result = await sweepInactiveSourceOpportunities(options);
      expect(result.dryRun).toBe(true);
      expect(
        mocks.query.mock.calls.some((call: unknown[]) =>
          String(call[0]).trimStart().startsWith('UPDATE'),
        ),
      ).toBe(false);
    }
  });

  it('bumps the change feed so a mounted list observes the apply', async () => {
    respondWith(2);
    const { sweepInactiveSourceOpportunities } = await sweep();

    await sweepInactiveSourceOpportunities({ dryRun: false, now: NOW });

    expect(mocks.bumpChangeFeed).toHaveBeenCalledTimes(1);
    const [handle, ids] = (mocks.bumpChangeFeed.mock.calls[0] ??
      []) as unknown[];
    // The bump runs on the transaction handle, inside the same unit of work as
    // the archive, so it is never observed without the rows it describes.
    expect(handle).toHaveProperty('query');
    expect(ids).toEqual(['opportunity-0', 'opportunity-1']);
  });

  it('bumps nothing on a dry run', async () => {
    respondWith(3);
    const { sweepInactiveSourceOpportunities } = await sweep();

    await sweepInactiveSourceOpportunities({ dryRun: true, now: NOW });

    expect(mocks.bumpChangeFeed).not.toHaveBeenCalled();
  });

  it('closes the open review task of every row it archives', async () => {
    respondWith(2);
    mocks.closeReviewTasks.mockResolvedValue(2);
    const { sweepInactiveSourceOpportunities } = await sweep();

    const result = await sweepInactiveSourceOpportunities({
      dryRun: false,
      now: NOW,
      user: { id: 'owner-1' },
    });

    expect(mocks.closeReviewTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveReason: 'source_inactive',
        opportunityIds: ['opportunity-0', 'opportunity-1'],
      }),
    );
    expect(result.reviewTasksClosed).toBe(2);
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ reviewTasksClosed: 2 }),
      }),
    );
  });

  it('closes no review task on a dry run', async () => {
    respondWith(3);
    const { sweepInactiveSourceOpportunities } = await sweep();

    const preview = await sweepInactiveSourceOpportunities({
      dryRun: true,
      now: NOW,
    });

    expect(mocks.closeReviewTasks).not.toHaveBeenCalled();
    expect(preview.reviewTasksClosed).toBe(0);
  });

  it('archives the matched set with a reason and exactly one audit', async () => {
    respondWith(4);
    const { sweepInactiveSourceOpportunities } = await sweep();

    const result = await sweepInactiveSourceOpportunities({
      dryRun: false,
      now: NOW,
      user: { id: 'owner-1' },
    });

    const update = mocks.query.mock.calls.find((call: unknown[]) =>
      String(call[0]).trimStart().startsWith('UPDATE'),
    );
    expect(update).toBeDefined();
    const [updateSql, statuses, cutoff, reviewStatuses, ...rest] = update ?? [];
    // The trailing parameter is the locked-id set the archive is restricted to
    // (#437); everything before it is the archived-state triple.
    const state = rest.slice(0, -1);
    expect(rest.at(-1)).toEqual([
      'opportunity-0',
      'opportunity-1',
      'opportunity-2',
      'opportunity-3',
    ]);
    expect(updateSql).toContain('UPDATE opportunities o');
    expect(updateSql).not.toContain('DELETE');
    expect(updateSql).toContain('s.is_active IS NOT TRUE');
    expect(statuses).toEqual(['found', 'recommended']);
    expect(cutoff).toEqual(new Date('2026-08-03T00:00:00.000Z'));
    expect(reviewStatuses).toEqual(['apply', 'maybe', 'reject']);
    // The archived transition reused from `posting-preflight.ts`.
    expect(state).toEqual(['archived', 'archived', 'stale', 'source_inactive']);

    expect(result).toMatchObject({
      applied: true,
      archivedCount: 4,
      auditRunId: 'agent-run-1',
      count: 4,
      dryRun: false,
    });
    expect(mocks.recordAgentAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        runType: 'opportunity_sweep_source_inactive',
        status: 'completed',
        user: { id: 'owner-1' },
        input: expect.objectContaining({
          action: 'sweep_inactive_source_opportunities',
          dryRun: false,
          notSeenDays: 30,
          sourceIsActive: false,
          statuses: ['found', 'recommended'],
        }),
        output: expect.objectContaining({
          archiveReason: 'source_inactive',
          archivedCount: 4,
          matchedCount: 4,
        }),
      }),
    );
  });

  it('never sweeps a row that carries an owner decision or an application', async () => {
    const { PROTECTED_REVIEW_STATUSES, sweepInactiveSourceOpportunities } =
      await sweep();
    // The dispositions a "Maybe" decision or an admin review records while
    // deliberately leaving the lifecycle status at found/recommended.
    expect([...PROTECTED_REVIEW_STATUSES]).toEqual([
      'apply',
      'maybe',
      'reject',
    ]);

    const preview = await sweepInactiveSourceOpportunities({
      dryRun: true,
      now: NOW,
    });

    // Every query behind the count, the sample and the update carries all
    // three guards, so a preview and its apply protect the same rows.
    expect(mocks.query.mock.calls.length).toBeGreaterThan(0);
    for (const [sql, , , reviewStatuses] of mocks.query.mock.calls) {
      expect(String(sql)).toContain('human_review_status');
      expect(String(sql)).toContain('FROM applications a');
      expect(String(sql)).toContain("d.decision_by = 'owner'");
      expect(reviewStatuses).toEqual(['apply', 'maybe', 'reject']);
    }

    // The audit filter records the guards, not just the status list.
    expect(preview.filter).toMatchObject({
      excludesApplications: true,
      excludesOwnerDecisions: true,
      excludesReviewStatuses: ['apply', 'maybe', 'reject'],
    });
  });

  it('archives and audits in one transaction so neither can land alone', async () => {
    respondWith(4);
    const { sweepInactiveSourceOpportunities } = await sweep();

    await sweepInactiveSourceOpportunities({
      dryRun: false,
      now: NOW,
      user: { id: 'owner-1' },
    });

    // One transaction, and the audit is written on the same handle as the
    // update rather than on an autocommitting connection of its own.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const [{ database }] = mocks.recordAgentAudit.mock.calls[0] ?? [{}];
    expect(database).toBeDefined();
    expect((database as { query: unknown }).query).toBe(mocks.query);

    // A failing audit aborts the whole unit of work: the rejection reaches the
    // caller through `db.transaction()`, which is what rolls the update back.
    mocks.transaction.mockClear();
    mocks.recordAgentAudit.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    await expect(
      sweepInactiveSourceOpportunities({
        dryRun: false,
        now: NOW,
        user: { id: 'owner-1' },
      }),
    ).rejects.toThrow('audit unavailable');
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses to apply on an adapter without transactions', async () => {
    mocks.requestDatabase.mockReturnValue({ query: mocks.query });
    respondWith(4);
    const { sweepInactiveSourceOpportunities } = await sweep();

    await expect(
      sweepInactiveSourceOpportunities({ dryRun: false, now: NOW }),
    ).rejects.toThrow(/Transactional archival is required/);
    expect(
      mocks.query.mock.calls.some((call: unknown[]) =>
        String(call[0]).trimStart().startsWith('UPDATE'),
      ),
    ).toBe(false);
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
  });

  it('applies the same archived state as the closed-posting transition', async () => {
    const { ARCHIVED_OPPORTUNITY_STATE, routeClosedPostingToExistingState } =
      await import('./posting-preflight');
    const { SWEEP_ARCHIVE_REASON } = await sweep();

    // The transition the sweep's batched UPDATE reproduces, asserted against
    // the function every single-row archive goes through.
    const opportunity = { id: 'opp-1', save: vi.fn(async () => {}) };
    await routeClosedPostingToExistingState(opportunity, {
      archiveReason: SWEEP_ARCHIVE_REASON,
    });
    expect(opportunity).toMatchObject({
      ...ARCHIVED_OPPORTUNITY_STATE,
      archiveReason: 'source_inactive',
    });
    expect(opportunity.save).toHaveBeenCalledTimes(1);

    respondWith(1);
    const { sweepInactiveSourceOpportunities } = await sweep();
    await sweepInactiveSourceOpportunities({
      dryRun: false,
      now: NOW,
      user: { id: 'owner-1' },
    });
    const update = mocks.query.mock.calls.find((call: unknown[]) =>
      String(call[0]).trimStart().startsWith('UPDATE'),
    );
    expect(update?.slice(4, 8)).toEqual([
      ARCHIVED_OPPORTUNITY_STATE.status,
      ARCHIVED_OPPORTUNITY_STATE.humanReviewStatus,
      ARCHIVED_OPPORTUNITY_STATE.freshness,
      SWEEP_ARCHIVE_REASON,
    ]);
  });

  it('locks the candidate set before archiving it', async () => {
    respondWith(3);
    const { sweepInactiveSourceOpportunities } = await sweep();

    await sweepInactiveSourceOpportunities({ dryRun: false, now: NOW });

    const statements = mocks.query.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    const lockIndex = statements.findIndex((sql) => sql.includes('FOR UPDATE'));
    const updateIndex = statements.findIndex((sql) =>
      sql.trimStart().startsWith('UPDATE opportunities o\n      SET'),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    // The lock is taken inside the apply transaction, before the archive.
    expect(lockIndex).toBeLessThan(updateIndex);
    expect(statements[lockIndex]).toContain('FOR UPDATE OF o SKIP LOCKED');
    // The archive is restricted to the rows the lock actually took and
    // re-evaluates the whole match predicate against a fresh snapshot.
    expect(statements[updateIndex]).toContain('o.id = ANY($8::text[])');
    expect(statements[updateIndex]).toContain(
      "d.opportunity_id = o.id AND d.decision_by = 'owner'",
    );
  });

  it('skips and reports a row that gained a protecting artifact after the preview', async () => {
    // Three rows previewed and locked; one of them picked up an owner decision
    // in the meantime, so the re-checked archive matches only two.
    respondWith(3, 2, 3);
    const { sweepInactiveSourceOpportunities } = await sweep();

    const result = await sweepInactiveSourceOpportunities({
      dryRun: false,
      now: NOW,
      user: { id: 'owner-1' },
    });

    expect(result).toMatchObject({
      archivedCount: 2,
      count: 3,
      lockedCount: 3,
      skippedCount: 1,
    });
    expect(result.message).toContain('1 were skipped');
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          archivedCount: 2,
          lockedCount: 3,
          matchedCount: 3,
          skippedCount: 1,
        }),
      }),
    );
  });

  it('reports a candidate another transaction already holds as unlocked', async () => {
    // SKIP LOCKED steps over the held row rather than waiting on it.
    respondWith(3, 2, 2);
    const { sweepInactiveSourceOpportunities } = await sweep();

    const result = await sweepInactiveSourceOpportunities({
      dryRun: false,
      now: NOW,
    });

    expect(result).toMatchObject({
      archivedCount: 2,
      count: 3,
      lockedCount: 2,
      skippedCount: 0,
    });
  });

  it('takes no lock on a dry run', async () => {
    respondWith(3);
    const { sweepInactiveSourceOpportunities } = await sweep();

    await sweepInactiveSourceOpportunities({ dryRun: true, now: NOW });

    for (const call of mocks.query.mock.calls) {
      expect(String(call[0])).not.toContain('FOR UPDATE');
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('reuses the request-scoped database when one is bound', async () => {
    const scopedQuery = vi.fn(async () => ({ rows: [{ count: '0' }] }));
    mocks.requestDatabase.mockReturnValue({ query: scopedQuery });
    const { sweepInactiveSourceOpportunities } = await sweep();

    await sweepInactiveSourceOpportunities({ dryRun: true, now: NOW });

    expect(scopedQuery).toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
