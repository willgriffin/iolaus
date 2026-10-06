import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HostedLanding from '$lib/components/HostedLanding.svelte';
import LegalLinks from '$lib/components/LegalLinks.svelte';
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

describe('shared hosted root', () => {
  const sharedEnv = () => {
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'cloud');
    vi.stubEnv('SMRT_APP_ID', 'hosted-app');
    vi.stubEnv('IOLAUS_WORKSPACE_MODE', 'shared');
    vi.stubEnv('IOLAUS_APP_NAME', 'Hosted Product');
  };
  const run = (locals: Record<string, unknown> = {}) => {
    const setHeaders = vi.fn();
    mocks.getCachedPublishedResume.mockClear();
    return {
      result: load({ locals, setHeaders } as unknown as Parameters<
        typeof load
      >[0]),
      setHeaders,
    };
  };

  afterEach(() => vi.unstubAllEnvs());

  it('does not read or return the owner resume; returns a landing entry', async () => {
    sharedEnv();
    vi.stubEnv('IOLAUS_TERMS_URL', 'https://example.invalid/terms');
    const { result, setHeaders } = run();
    const data = (await result) as Record<string, unknown>;

    expect(mocks.getCachedPublishedResume).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      appName: 'Hosted Product',
      mode: 'landing',
      signedIn: false,
    });
    expect(setHeaders).toHaveBeenCalledWith({
      'cache-control': 'private, no-store',
    });
  });

  it('302s to the configured marketing URL', async () => {
    sharedEnv();
    vi.stubEnv('IOLAUS_PUBLIC_LANDING_URL', 'https://example.invalid/');
    const { result } = run();

    await expect(result).rejects.toMatchObject({
      location: 'https://example.invalid/',
      status: 302,
    });
    expect(mocks.getCachedPublishedResume).not.toHaveBeenCalled();
  });

  it('ignores an unsafe landing URL and shows the landing entry', async () => {
    sharedEnv();
    vi.stubEnv('IOLAUS_PUBLIC_LANDING_URL', 'javascript:alert(1)');
    const data = (await run().result) as Record<string, unknown>;
    expect(data.mode).toBe('landing');
  });

  it('keeps private mode rendering the published resume', async () => {
    vi.stubEnv('IOLAUS_PUBLIC_LANDING_URL', 'https://example.invalid/');
    const { headers, value } = await headersFor({ contentHash: 'hash-a' });
    expect(value).toBe(RESUME);
    expect(headers['cache-control']).toContain('s-maxage=60');
  });

  it('renders the landing with sign-in and configured links only', () => {
    const links = {
      landing: null,
      privacy: { href: 'https://example.invalid/privacy', label: 'Privacy' },
      support: null,
      terms: { href: 'https://example.invalid/terms', label: 'Terms' },
    };
    const { body } = render(HostedLanding, {
      props: { appName: 'Hosted Product', links, signedIn: false },
    });
    expect(body).toContain('Hosted Product');
    expect(body).toContain('href="/login"');
    expect(body).toContain('href="https://example.invalid/terms"');
    expect(body).toContain('href="https://example.invalid/privacy"');
    expect(body).not.toContain('Support');
    expect(body).not.toMatch(/jobgeni/i);

    const signedIn = render(HostedLanding, {
      props: { appName: 'Hosted Product', links, signedIn: true },
    });
    expect(signedIn.body).toContain('href="/admin/"');
  });

  it('renders no legal navigation when nothing is configured', () => {
    const none = { privacy: null, support: null, terms: null };
    expect(render(LegalLinks, { props: { links: none } }).body).not.toContain(
      '<nav',
    );
    expect(
      render(LegalLinks, { props: { links: undefined } }).body,
    ).not.toContain('<nav');
    const { body } = render(LegalLinks, {
      props: {
        links: {
          ...none,
          support: { href: 'mailto:help@example.invalid', label: 'Support' },
        },
      },
    });
    expect(body).toContain('aria-label="Legal and support"');
    expect(body).toContain('href="mailto:help@example.invalid"');
    expect(body).not.toContain('target=');
  });
});
