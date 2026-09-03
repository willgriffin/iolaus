import { describe, expect, it, vi } from 'vitest';
import { load } from './+page.server';

const mocks = vi.hoisted(() => ({
  getCachedPublishedResume: vi.fn(),
}));

vi.mock('$lib/server/resume-data', () => ({
  getCachedPublishedResume: mocks.getCachedPublishedResume,
}));

vi.mock('$app/environment', () => ({
  version: 'test-build',
}));

const RESUME = { experience: {}, profile: {}, skills: {} };

async function headersFor(result: {
  contentHash: string | null;
  stamp?: string | null;
  value?: unknown;
}) {
  const setHeaders = vi.fn();
  mocks.getCachedPublishedResume.mockResolvedValueOnce({
    stamp: 'stamp-1',
    value: RESUME,
    ...result,
  });
  const value = await load({ setHeaders } as unknown as Parameters<
    typeof load
  >[0]);
  return {
    headers: (setHeaders.mock.calls[0] as [Record<string, string>])[0],
    value,
  };
}

describe('public homepage load', () => {
  it('sets a short shared-cache policy and returns the cached resume', async () => {
    const { headers, value } = await headersFor({ contentHash: 'hash-a' });

    expect(value).toBe(RESUME);
    expect(headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=60, must-revalidate',
    );
    expect(headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('reuses one etag for unchanged content and changes it when content changes', async () => {
    const first = (await headersFor({ contentHash: 'hash-a' })).headers.etag;
    const repeat = (await headersFor({ contentHash: 'hash-a' })).headers.etag;
    const changed = (await headersFor({ contentHash: 'hash-b' })).headers.etag;

    expect(repeat).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('validates on content rather than the cache stamp', async () => {
    // The stamp is read before the payload load, so a write landing between the
    // two files fresh content under the old stamp. A stamp-keyed validator would
    // hand two clients the same etag for different bytes.
    const sameStampNewContent = await headersFor({
      contentHash: 'hash-b',
      stamp: 'stamp-1',
    });
    const sameStampOldContent = await headersFor({
      contentHash: 'hash-a',
      stamp: 'stamp-1',
    });

    expect(sameStampNewContent.headers.etag).not.toBe(
      sameStampOldContent.headers.etag,
    );
  });

  it('omits the etag when no content hash is available', async () => {
    const { headers } = await headersFor({ contentHash: null });

    expect(headers.etag).toBeUndefined();
    expect(headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=60, must-revalidate',
    );
  });
});
