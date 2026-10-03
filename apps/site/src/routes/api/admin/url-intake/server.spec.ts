import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock('$lib/server/url-intake', () => ({ ingestPublicUrl: mocks.ingest }));
vi.mock('$lib/server/owner-principal', () => ({
  OwnerPrincipalError: class extends Error {},
  isOwnerAuthorityDenial: (value: unknown) =>
    value instanceof Error && value.message === 'authority denied',
}));

import { POST } from './+server';

const locals = {
  user: { id: 'user-1' },
  workspaceSubject: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    profileId: 'profile-1',
  },
};
function call(
  body: unknown = { url: 'https://jobs.ashbyhq.com/acme' },
  options: {
    headers?: Record<string, string>;
    signedIn?: boolean;
    raw?: boolean;
  } = {},
) {
  return POST({
    locals: options.signedIn === false ? {} : locals,
    url: new URL('https://app.example.com/api/admin/url-intake'),
    request: new Request('https://app.example.com/api/admin/url-intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.raw ? String(body) : JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0]);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ingest.mockResolvedValue({
    status: 'queued',
    kind: 'source',
    message: 'Initial pull queued',
  });
});
describe('URL intake API boundary', () => {
  it('passes only the explicit URL choice and server locals into the native workflow', async () => {
    const response = await call({
      url: 'https://careers.example.com',
      kind: 'source',
    });
    expect(response.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(
      { url: 'https://careers.example.com', kind: 'source' },
      locals,
    );
  });
  it('rejects unauthenticated callers, non-JSON forms, and cross-origin requests before intake', async () => {
    expect((await call(undefined, { signedIn: false })).status).toBe(401);
    expect(
      (await call(undefined, { headers: { 'content-type': 'text/plain' } }))
        .status,
    ).toBe(415);
    expect(
      (
        await call(undefined, {
          headers: { origin: 'https://foreign.example.com' },
        })
      ).status,
    ).toBe(403);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it.each([
    { url: 'https://careers.example.com', tenantId: 'foreign' },
    { url: 'https://careers.example.com', profileId: 'foreign' },
    { url: 'https://careers.example.com', sourceId: 'foreign' },
    [],
    null,
  ])('rejects browser-owned authority or malformed payload %j', async (body) => {
    expect((await call(body)).status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it('rejects malformed and oversized payloads', async () => {
    expect((await call('{', { raw: true })).status).toBe(400);
    await expect(call('x'.repeat(4097), { raw: true })).rejects.toMatchObject({
      status: 413,
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it('returns actionable validation/native denial errors without a success claim', async () => {
    mocks.ingest.mockRejectedValueOnce(new Error('authority denied'));
    expect((await call()).status).toBe(403);
    mocks.ingest.mockRejectedValueOnce(
      new Error('outside the public internet'),
    );
    const response = await call();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'outside the public internet',
    });
  });
});
