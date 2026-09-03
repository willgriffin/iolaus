import { describe, expect, it, vi } from 'vitest';
import {
  extractCompanyApplyUrl,
  isIndeedUrl,
  resolveIndeedApplyUrl,
} from './indeed.js';

function htmlResponse(body: string, ok = true): Response {
  return {
    ok,
    text: async () => body,
  } as unknown as Response;
}

describe('isIndeedUrl', () => {
  it('matches indeed hosts including country and www subdomains', () => {
    expect(isIndeedUrl('https://www.indeed.com/viewjob?jk=abc')).toBe(true);
    expect(isIndeedUrl('https://ca.indeed.com/viewjob?jk=abc')).toBe(true);
    expect(isIndeedUrl('https://indeed.com/viewjob?jk=abc')).toBe(true);
  });

  it('rejects non-indeed and malformed urls', () => {
    expect(isIndeedUrl('https://boards.greenhouse.io/acme/jobs/42')).toBe(
      false,
    );
    expect(isIndeedUrl('https://notindeed.com/viewjob')).toBe(false);
    expect(isIndeedUrl('https://indeed.com.evil.com/x')).toBe(false);
    expect(isIndeedUrl('ftp://indeed.com/x')).toBe(false);
    expect(isIndeedUrl('not a url')).toBe(false);
    expect(isIndeedUrl('')).toBe(false);
  });
});

describe('extractCompanyApplyUrl', () => {
  it('decodes a JSON-escaped third-party apply url', () => {
    const html = `<script>window._initialData={"applyButtonContainerModel":{"thirdPartyApplyUrl":"https:\\/\\/boards.greenhouse.io\\/acme\\/jobs\\/42?gh_src=abc&amp;t=1"}}</script>`;
    expect(extractCompanyApplyUrl(html)).toBe(
      'https://boards.greenhouse.io/acme/jobs/42?gh_src=abc&t=1',
    );
  });

  it('falls back to an external apply anchor', () => {
    const html = `<a class="jobsearch-IndeedApplyButton" href="https://jobs.ashbyhq.com/acme/1234" data-tn="applyOnCompanySite">Apply on company site</a>`;
    expect(extractCompanyApplyUrl(html)).toBe(
      'https://jobs.ashbyhq.com/acme/1234',
    );
  });

  it('returns empty for an Indeed-hosted apply (no external destination)', () => {
    const html = `<script>window._initialData={"indeedApplyable":true,"applyUrl":"https:\\/\\/www.indeed.com\\/applystart?jk=abc"}</script><a href="https://www.indeed.com/apply" class="indeed-apply">Apply now</a>`;
    expect(extractCompanyApplyUrl(html)).toBe('');
  });

  it('returns empty for non-string or empty input', () => {
    expect(extractCompanyApplyUrl(undefined)).toBe('');
    expect(extractCompanyApplyUrl('')).toBe('');
    expect(extractCompanyApplyUrl('<html>no apply data</html>')).toBe('');
  });
});

describe('resolveIndeedApplyUrl', () => {
  const greenhouseHtml = `<script>window._initialData={"thirdPartyApplyUrl":"https:\\/\\/boards.greenhouse.io\\/acme\\/jobs\\/42"}</script>`;

  it('returns null without fetching for a non-Indeed url', async () => {
    const fetchImpl = vi.fn();
    const result = await resolveIndeedApplyUrl({
      url: 'https://boards.greenhouse.io/acme/jobs/42',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves to the company apply url when it is a supported ATS', async () => {
    const result = await resolveIndeedApplyUrl({
      url: 'https://www.indeed.com/viewjob?jk=abc',
      fetchImpl: (async () => htmlResponse(greenhouseHtml)) as typeof fetch,
      isSupportedAts: async () => true,
    });
    expect(result).toBe('https://boards.greenhouse.io/acme/jobs/42');
  });

  it('returns null when the resolved url is not a supported ATS', async () => {
    const result = await resolveIndeedApplyUrl({
      url: 'https://www.indeed.com/viewjob?jk=abc',
      fetchImpl: (async () =>
        htmlResponse(
          `<script>window._initialData={"thirdPartyApplyUrl":"https:\\/\\/careers.example.com\\/apply\\/9"}</script>`,
        )) as typeof fetch,
      isSupportedAts: async () => false,
    });
    expect(result).toBeNull();
  });

  it('returns null when no external apply url is present', async () => {
    const result = await resolveIndeedApplyUrl({
      url: 'https://www.indeed.com/viewjob?jk=abc',
      fetchImpl: (async () =>
        htmlResponse('<html>indeed apply only</html>')) as typeof fetch,
      isSupportedAts: async () => true,
    });
    expect(result).toBeNull();
  });

  it('returns null when the fetch is blocked (non-ok)', async () => {
    const result = await resolveIndeedApplyUrl({
      url: 'https://www.indeed.com/viewjob?jk=abc',
      fetchImpl: (async () => htmlResponse('forbidden', false)) as typeof fetch,
      isSupportedAts: async () => true,
    });
    expect(result).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    const result = await resolveIndeedApplyUrl({
      url: 'https://www.indeed.com/viewjob?jk=abc',
      fetchImpl: (async () => {
        throw new Error('network blocked');
      }) as typeof fetch,
      isSupportedAts: async () => true,
    });
    expect(result).toBeNull();
  });
});
