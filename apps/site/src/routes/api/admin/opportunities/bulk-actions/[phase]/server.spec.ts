import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  createAdapter: vi.fn(),
  createStore: vi.fn(),
  isDenial: vi.fn(() => false),
  logAudit: vi.fn(),
  preview: vi.fn(),
  principalOptions: vi.fn(),
}));

class FakeSelectionError extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

vi.mock('$lib/server/data-surface-action-state-store', () => ({
  SmrtDataSurfaceActionStateStore: { create: mocks.createStore },
}));

vi.mock('$lib/server/opportunity-data-surface-actions', () => ({
  createOpportunityDataSurfaceAdapter: mocks.createAdapter,
  OpportunitySelectionError: FakeSelectionError,
}));

vi.mock('$lib/server/owner-principal', () => ({
  isOwnerAuthorityDenial: mocks.isDenial,
  logOwnerPrincipalAudit: mocks.logAudit,
  ownerPrincipalOptions: mocks.principalOptions,
}));

const locals = { user: { id: 'user-1' } } as never;

function post(body: unknown): Request {
  return new Request(
    'http://localhost/api/admin/opportunities/bulk-actions/preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
}

const validBody = {
  version: 1,
  requestId: 'req-1',
  actionId: 'review',
  phase: 'preview',
  expectedRevision: 0,
  selection: { scope: 'explicit-ids', rowIds: ['opp-1'] },
  payload: { humanReviewStatus: 'apply' },
  target: {
    candidateSkills: ['typescript'],
    filters: { status: 'found', skills: ['a'] },
    page: 2,
    reviewFilter: 'unsorted',
  },
};

async function handler() {
  const module = await import('./+server');
  return module.POST;
}

describe('opportunity bulk-actions route', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isDenial.mockReturnValue(false);
    mocks.createStore.mockResolvedValue({});
    mocks.principalOptions.mockResolvedValue({
      agentClass: 'iolaus.localhost/owner',
      auditMetadata: { actionId: 'review', requestId: 'req-1' },
      onBehalfOfUserId: 'user-1',
      principal: { runAsUserId: 'user-1', tenantId: null },
    });
    mocks.preview.mockResolvedValue({ ok: true, phase: 'preview' });
    mocks.apply.mockResolvedValue({ ok: true, phase: 'apply' });
    mocks.createAdapter.mockReturnValue({
      preview: mocks.preview,
      apply: mocks.apply,
    });
  });

  it('rejects an unauthenticated request before touching the adapter', async () => {
    const POST = await handler();

    const response = await POST({
      locals: { user: null },
      params: { phase: 'preview' },
      request: post(validBody),
    } as never);

    expect(response.status).toBe(401);
    expect(mocks.createAdapter).not.toHaveBeenCalled();
  });

  it('404s an unknown phase', async () => {
    const POST = await handler();

    const response = await POST({
      locals,
      params: { phase: 'destroy' },
      request: post(validBody),
    } as never);

    expect(response.status).toBe(404);
  });

  it('refuses a body whose phase disagrees with the url', async () => {
    const POST = await handler();

    const response = await POST({
      locals,
      params: { phase: 'preview' },
      request: post({ ...validBody, phase: 'apply' }),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('refuses an unparseable body', async () => {
    const POST = await handler();

    const response = await POST({
      locals,
      params: { phase: 'preview' },
      request: post('not json'),
    } as never);

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('reconstructs the filter target from the defaults, dropping unknown keys', async () => {
    const POST = await handler();

    await POST({
      locals,
      params: { phase: 'preview' },
      request: post({
        ...validBody,
        target: { ...validBody.target, filters: { status: 'found', evil: 1 } },
      }),
    } as never);

    const target = mocks.createAdapter.mock.calls[0][0].resolveQueryTarget();
    expect(target.filters.status).toBe('found');
    // An untrusted body must not introduce keys the fingerprint would hash.
    expect(target.filters).not.toHaveProperty('evil');
    expect(target.page).toBe(2);
    expect(target.candidateSkills).toEqual(['typescript']);
  });

  it('carries the numeric filters through to the fingerprinted target', async () => {
    const POST = await handler();

    await POST({
      locals,
      params: { phase: 'preview' },
      request: post({
        ...validBody,
        target: {
          ...validBody.target,
          filters: {
            minScore: 5,
            minRating: 7,
            salaryMin: 100000,
            salaryMax: 200000,
            hourlyMin: 50,
            hourlyMax: 150,
            postedWithinDays: 7,
          },
        },
      }),
    } as never);

    // Every one of these defaults to null. A `typeof value === typeof
    // fallback` check would compare 'number' against 'object' and silently
    // reset them, so the server would fingerprint a query the operator never
    // ran and refuse every all-matching selection as stale.
    const target = mocks.createAdapter.mock.calls[0][0].resolveQueryTarget();
    expect(target.filters).toMatchObject({
      hourlyMax: 150,
      hourlyMin: 50,
      minRating: 7,
      minScore: 5,
      postedWithinDays: 7,
      salaryMax: 200000,
      salaryMin: 100000,
    });
  });

  it('drops a numeric filter that is not a number', async () => {
    const POST = await handler();

    await POST({
      locals,
      params: { phase: 'preview' },
      request: post({
        ...validBody,
        target: {
          ...validBody.target,
          filters: { minScore: '5', salaryMin: Number.NaN },
        },
      }),
    } as never);

    const target = mocks.createAdapter.mock.calls[0][0].resolveQueryTarget();
    expect(target.filters.minScore).toBeNull();
    expect(target.filters.salaryMin).toBeNull();
  });

  it('returns a refused selection in band rather than as a transport error', async () => {
    mocks.preview.mockRejectedValue(
      new FakeSelectionError('stale_query_fingerprint'),
    );
    const POST = await handler();

    const response = await POST({
      locals,
      params: { phase: 'preview' },
      request: post(validBody),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      reason: 'stale_query_fingerprint',
    });
  });

  it('403s an authority denial', async () => {
    mocks.preview.mockRejectedValue(new Error('denied'));
    mocks.isDenial.mockReturnValue(true);
    const POST = await handler();

    const response = await POST({
      locals,
      params: { phase: 'preview' },
      request: post(validBody),
    } as never);

    expect(response.status).toBe(403);
  });

  it('audits an apply the adapter refused before entering the principal', async () => {
    // A confirmation that is expired, mismatched, or already spent is rejected
    // upstream of the principal, so nothing else would record the attempt.
    mocks.apply.mockResolvedValue({
      ok: false,
      phase: 'apply',
      reason: 'invalid_or_expired_confirmation',
    });
    const POST = await handler();

    await POST({
      locals,
      params: { phase: 'apply' },
      request: post({ ...validBody, phase: 'apply' }),
    } as never);

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        // Same label the adapter stamps on an executed apply, so one filter
        // over the audit stream returns executed and refused alike.
        action: 'data_surface.action.apply',
        actorUserId: 'user-1',
        metadata: expect.objectContaining({
          outcome: 'refused',
          reason: 'invalid_or_expired_confirmation',
        }),
      }),
    );
  });

  it('leaves an apply that reached the rows to the principal audit alone', async () => {
    // The real adapter writes the line through the principal's own audit sink
    // once it enters the principal; the route must then stay quiet.
    mocks.apply.mockImplementation(async (_request, context) => {
      context.principal.audit({
        action: 'data_surface.action.apply',
        actorUserId: 'user-1',
        onBehalfOfUserId: 'user-1',
        tenantId: null,
      });
      return { ok: true, phase: 'apply' };
    });
    const POST = await handler();

    await POST({
      locals,
      params: { phase: 'apply' },
      request: post({ ...validBody, phase: 'apply' }),
    } as never);

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.not.objectContaining({ metadata: expect.anything() }),
    );
  });

  it('audits a preview the adapter refused before entering the principal', async () => {
    mocks.preview.mockResolvedValue({
      ok: false,
      phase: 'preview',
      reason: 'confirmation_mismatch',
    });
    const POST = await handler();

    await POST({
      locals,
      params: { phase: 'preview' },
      request: post(validBody),
    } as never);

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'data_surface.action.preview',
        metadata: expect.objectContaining({
          outcome: 'refused',
          reason: 'confirmation_mismatch',
        }),
      }),
    );
  });

  it('audits a replay of a completed apply as replayed, not refused', async () => {
    // The adapter resolves a replay from the idempotency record without
    // entering the principal, so the route is what records the request.
    mocks.apply.mockResolvedValue({ ok: true, phase: 'apply' });
    const POST = await handler();

    await POST({
      locals,
      params: { phase: 'apply' },
      request: post({ ...validBody, phase: 'apply' }),
    } as never);

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'data_surface.action.apply',
        metadata: expect.objectContaining({ outcome: 'replayed' }),
      }),
    );
  });

  it('audits a malformed envelope from an authorized caller', async () => {
    const POST = await handler();

    await POST({
      locals,
      params: { phase: 'apply' },
      // Envelope disagrees with the URL phase, so the adapter never runs.
      request: post({ ...validBody, phase: 'preview' }),
    } as never);

    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          outcome: 'refused',
          reason: 'invalid_request',
        }),
      }),
    );
  });

  it.each([
    ['the state store could not be opened', () => mocks.createStore],
    ['the adapter threw before the principal', () => mocks.apply],
  ])('audits an apply that failed because %s', async (_label, target) => {
    // Neither failure has a result to report, but the attempt still happened
    // and still belongs in the trail.
    target().mockRejectedValue(new Error('connection reset'));
    const POST = await handler();

    await expect(
      POST({
        locals,
        params: { phase: 'apply' },
        request: post({ ...validBody, phase: 'apply' }),
      } as never),
    ).rejects.toThrow('connection reset');

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'data_surface.action.apply',
        metadata: expect.objectContaining({ outcome: 'failed' }),
      }),
    );
  });

  it('routes the apply phase to the adapter with an audited principal', async () => {
    const POST = await handler();

    const response = await POST({
      locals,
      params: { phase: 'apply' },
      request: post({
        ...validBody,
        phase: 'apply',
        idempotencyKey: 'key-1',
        confirmationToken: 'token-1',
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(mocks.apply).toHaveBeenCalled();
    expect(mocks.principalOptions).toHaveBeenCalledWith(
      locals,
      expect.objectContaining({
        action: 'data_surface.opportunities.apply',
        auditMetadata: expect.objectContaining({
          actionId: 'review',
          idempotencyKey: 'key-1',
          surfaceId: 'admin-opportunities',
        }),
      }),
    );
  });
});
