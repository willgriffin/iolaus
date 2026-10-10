import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shared: true,
  profile: vi.fn(),
  pdf: vi.fn(),
}));
vi.mock('$lib/server/app-config', () => ({
  isSharedHosted: () => mocks.shared,
}));
vi.mock('$lib/server/public-profile-service', () => ({
  getPublicProfile: mocks.profile,
  getPublicProfilePdf: mocks.pdf,
}));

import { load } from './+page.server';
import { GET } from './resume.pdf/+server';

const snapshot = { name: 'Candidate', title: 'Designer' };
beforeEach(() => {
  vi.stubEnv('IOLAUS_PUBLIC_PROFILES_ENABLED', 'true');
  mocks.shared = true;
  mocks.profile.mockReset();
  mocks.pdf.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('public profile routes', () => {
  it('marks unavailable PDF responses no-store as well', async () => {
    mocks.pdf.mockResolvedValue(null);
    const headers: Record<string, string> = {};
    await expect(
      GET({
        params: { handle: 'missing' },
        setHeaders: (values: Record<string, string>) =>
          Object.assign(headers, values),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(headers['cache-control']).toBe('no-store');
  });

  it('serves only the public projection with no-store and noindex headers', async () => {
    mocks.profile.mockResolvedValue({
      handle: 'candidate',
      snapshot,
      publishedAt: '2026-01-01T00:00:00.000Z',
      revisionId: 'revision',
    });
    const headers = new Headers();
    const result = await load({
      locals: {},
      params: { handle: 'candidate' },
      setHeaders: (next: Record<string, string>) =>
        Object.entries(next).forEach(([key, value]) => {
          headers.set(key, value);
        }),
    } as never);
    expect(result).toEqual(
      expect.objectContaining({ handle: 'candidate', snapshot }),
    );
    expect(result?.signedIn).toBe(false);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('x-robots-tag')).toContain('noindex');
  });

  it('does not resolve profiles while the feature is disabled', async () => {
    vi.stubEnv('IOLAUS_PUBLIC_PROFILES_ENABLED', 'false');
    await expect(
      load({ params: { handle: 'candidate' }, setHeaders: vi.fn() } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it('uses a safe attachment filename and no-store for the matching PDF', async () => {
    mocks.pdf.mockResolvedValue({
      body: new Uint8Array([1, 2]),
      filename: '../../candidate.pdf',
    });
    const headers: Record<string, string> = {};
    const response = await GET({
      params: { handle: 'candidate' },
      setHeaders: (values: Record<string, string>) =>
        Object.assign(headers, values),
    } as never);
    expect(headers['cache-control']).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="candidate.pdf"',
    );
  });
});
