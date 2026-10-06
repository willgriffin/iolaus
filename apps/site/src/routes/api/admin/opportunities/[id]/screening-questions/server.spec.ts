import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('$lib/server/screening-question-assessment-service', () => ({
  runScreeningQuestionAssessment: mocks.run,
}));
vi.mock('$lib/server/screening-question-store', () => ({
  ScreeningQuestionStoreError: class extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('$lib/server/owner-principal', () => ({
  isOwnerAuthorityDenial: (cause: unknown) =>
    !!cause &&
    typeof cause === 'object' &&
    'status' in cause &&
    cause.status === 403,
}));
vi.mock('$lib/server/smrt.js', () => ({
  getCollection: vi.fn(),
  getRequestScopedSmrtOptions: vi.fn(),
}));
vi.mock('$lib/server/db.js', () => ({ getSmrtOptions: vi.fn() }));

import { POST } from './+server';

const subject = { tenantId: 'tenant', userId: 'owner', profileId: 'profile' };
const locals = {
  workspaceSubject: subject,
  tenantId: 'tenant',
  user: { id: 'owner' },
  membership: {
    userId: 'owner',
    tenantId: 'tenant',
    roleId: 'role',
    status: 'active',
  },
} as App.Locals;
function event(body = '{}', extraHeaders: Record<string, string> = {}) {
  return {
    locals,
    params: { id: 'opportunity' },
    url: new URL(
      'http://localhost/api/admin/opportunities/opportunity/screening-questions',
    ),
    request: new Request(
      'http://localhost/api/admin/opportunities/opportunity/screening-questions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
          ...extraHeaders,
        },
        body,
      },
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SMRT_APP_ID', 'screening-origin-test');
  vi.stubEnv('SMRT_RUNTIME_PROFILE', 'local');
  vi.stubEnv('IOLAUS_PUBLIC_URL', '');
  mocks.run.mockResolvedValue({
    result: { requestId: 'actual-private-receipt', answers: ['private'] },
    reused: false,
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('explicit same-origin native screening adapter', () => {
  it('passes only the verified selected subject and opportunity to the native execution fence', async () => {
    const response = await POST(event() as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, reused: false });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(subject, {
      opportunityId: 'opportunity',
    });
  });
  it('accepts the configured public proxy origin while the internal request URL is loopback', async () => {
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'self-hosted');
    vi.stubEnv('IOLAUS_PUBLIC_URL', 'https://career.example.invalid:8443');
    const response = await POST(
      event('{}', { Origin: 'https://career.example.invalid:8443' }) as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(subject, {
      opportunityId: 'opportunity',
    });
  });
  it('rejects foreign origins even when forwarded headers claim the configured proxy host', async () => {
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'self-hosted');
    vi.stubEnv('IOLAUS_PUBLIC_URL', 'https://career.example.invalid:8443');
    const response = await POST(
      event('{}', {
        Origin: 'https://foreign.invalid',
        'X-Forwarded-Host': 'career.example.invalid:8443',
        'X-Forwarded-Proto': 'https',
      }) as never,
    );
    expect(response.status).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each([
    '{"profileId":"foreign"}',
    '[1]',
    '{"fullReview":"yes"}',
    'malformed',
  ])('rejects unknown or malformed overrides before execution (%s)', async (body) => {
    expect((await POST(event(body) as never)).status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('denies foreign origins and inactive workspace sessions before execution', async () => {
    expect(
      (await POST(event('{}', { Origin: 'http://foreign' }) as never)).status,
    ).toBe(403);
    const input = event();
    expect(
      (
        await POST({
          ...input,
          locals: {
            ...locals,
            membership: { ...locals.membership, status: 'inactive' },
          },
        } as never)
      ).status,
    ).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('surfaces native failure as a terminal error without claiming completion', async () => {
    mocks.run.mockRejectedValueOnce(new Error('Private transport details.'));
    const response = await POST(event() as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        'Screening could not complete. Check the active questions and captured source, then retry.',
    });
  });
});

it('accepts only a boolean full-review routing override', async () => {
  expect((await POST(event('{"fullReview":true}') as never)).status).toBe(200);
  expect(mocks.run).toHaveBeenCalledWith(subject, {
    opportunityId: 'opportunity',
    fullReview: true,
  });
});
