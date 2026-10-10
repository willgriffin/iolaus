import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const mocks = vi.hoisted(() => ({
  manager: vi.fn(),
  prepare: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
}));
vi.mock('$lib/server/public-profile-service', () => ({
  getPublicProfileManager: mocks.manager,
  preparePublicProfile: mocks.prepare,
  publishPublicProfile: mocks.publish,
  unpublishPublicProfile: mocks.unpublish,
}));
vi.mock('$lib/server/owner-principal', () => ({
  isOwnerAuthorityDenial: () => false,
}));
vi.mock('$lib/server/public-profile-store', () => ({
  PublicProfileStoreError: class PublicProfileStoreError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { PublicProfileStoreError } from '$lib/server/public-profile-store';
import { actions } from './+page.server';

const locals = {} as App.Locals;
function request(body: string, origin = 'https://iolaus.test') {
  return new Request(
    'https://iolaus.test/admin/career/public-profile?/prepare',
    {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
}
beforeEach(() => vi.clearAllMocks());

describe('public profile owner actions', () => {
  it('rejects a forged origin before reading or preparing', async () => {
    const result = await actions.prepare({
      locals,
      request: request(
        'handle=candidate&profileId=profile',
        'https://foreign.test',
      ),
      url: new URL('https://iolaus.test/admin/career/public-profile'),
    } as never);
    expect(result).toMatchObject({ status: 403, data: { ok: false } });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('passes individual contact consent and redirects to the exact preview', async () => {
    mocks.prepare.mockResolvedValue({ id: 'prepared-id' });
    await expect(
      actions.prepare({
        locals,
        request: request(
          'handle=candidate&profileId=profile&email=on&links=on&experience=on&education=on&skills=on&other=on',
        ),
        url: new URL('https://iolaus.test/admin/career/public-profile'),
      } as never),
    ).rejects.toMatchObject({ status: 303 });
    expect(mocks.prepare).toHaveBeenCalledWith(
      locals,
      expect.objectContaining({
        visibility: {
          contacts: { email: true, phone: false, location: false, links: true },
          sections: {
            experience: true,
            education: true,
            skills: true,
            other: true,
          },
        },
      }),
    );
  });
  it('maps malformed input, stale previews, and generation outages to safe feedback', async () => {
    mocks.prepare.mockRejectedValueOnce(new ZodError([]));
    const invalid = await actions.prepare({
      locals,
      request: request('handle=bad&profileId=profile'),
      url: new URL('https://iolaus.test/admin/career/public-profile'),
    } as never);
    expect(invalid).toMatchObject({ status: 400, data: { ok: false } });
    mocks.publish.mockRejectedValueOnce(
      new PublicProfileStoreError('conflict', 'Public profile changed.'),
    );
    const stale = await actions.publish({
      locals,
      request: request(
        'revisionId=00000000-0000-4000-8000-000000000000&expectedRevision=1',
      ),
      url: new URL('https://iolaus.test/admin/career/public-profile'),
    } as never);
    expect(stale).toMatchObject({
      status: 409,
      data: { ok: false, error: 'Public profile changed.' },
    });
    mocks.prepare.mockRejectedValueOnce(new Error('renderer unavailable'));
    const unavailable = await actions.prepare({
      locals,
      request: request('handle=candidate&profileId=profile'),
      url: new URL('https://iolaus.test/admin/career/public-profile'),
    } as never);
    expect(unavailable).toMatchObject({ status: 503, data: { ok: false } });
  });
  it('redirects after a successful publish instead of treating raw service output as UI state', async () => {
    mocks.publish.mockResolvedValue({ id: 'identity' });
    await expect(
      actions.publish({
        locals,
        request: request(
          'revisionId=00000000-0000-4000-8000-000000000000&expectedRevision=1',
        ),
        url: new URL('https://iolaus.test/admin/career/public-profile'),
      } as never),
    ).rejects.toMatchObject({ status: 303 });
  });
});
