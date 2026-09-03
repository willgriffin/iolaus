import { describe, expect, it } from 'vitest';
import { normalizeSourceCrawlItemOptions } from './source-crawl-item-slug';

describe('normalizeSourceCrawlItemOptions', () => {
  it('keeps caller-provided slugs', () => {
    expect(
      normalizeSourceCrawlItemOptions({
        externalId: 'job-1',
        slug: 'custom-slug',
        title: 'AI Engineer',
      }),
    ).toMatchObject({ slug: 'custom-slug' });
  });

  it('adds stable identity to title-derived crawl item slugs', () => {
    expect(
      normalizeSourceCrawlItemOptions({
        externalId: 'yc-picnichealth-buCbgTZ',
        opportunityId: 'opportunity-1',
        title: 'AI Engineer',
      }),
    ).toMatchObject({
      slug: 'ai-engineer-yc-picnichealth-bucbgtz-opportunity-1',
    });
  });

  it('uses crawl and posting identity when external ids are missing', () => {
    expect(
      normalizeSourceCrawlItemOptions({
        postingUrl: 'https://example.com/jobs/platform-engineer',
        sourceCrawlId: 'crawl-2026-05-26',
        title: 'Platform Engineer',
      }),
    ).toMatchObject({
      slug: 'platform-engineer-crawl-2026-05-26-https-example-com-jobs-platform-engineer',
    });
  });

  it('uses raw crawl item content as a stable fallback identity', () => {
    expect(
      normalizeSourceCrawlItemOptions({
        rawJson: '{"title":"Platform Engineer","location":"Remote"}',
        sourceCrawlId: 'crawl-2026-05-26',
        title: 'Platform Engineer',
      }),
    ).toMatchObject({
      slug: 'platform-engineer-crawl-2026-05-26-raw-3hhaoo',
    });
  });

  it('adds a generated fallback identity when no per-item identity exists', () => {
    const first = normalizeSourceCrawlItemOptions({
      sourceCrawlId: 'crawl-1',
      title: 'Software Engineer',
    });
    const second = normalizeSourceCrawlItemOptions({
      sourceCrawlId: 'crawl-1',
      title: 'Software Engineer',
    });

    expect(first.slug).not.toBe(second.slug);
    expect(first.slug).toMatch(/^software-engineer-crawl-1-/);
    expect(second.slug).toMatch(/^software-engineer-crawl-1-/);
  });

  it('preserves uniqueness when long readable slugs are trimmed', () => {
    const first = normalizeSourceCrawlItemOptions({
      postingUrl: `https://example.com/jobs/${'same-prefix-'.repeat(20)}first`,
      sourceCrawlId: 'crawl-1',
      title: 'AI Platform Engineer',
    });
    const second = normalizeSourceCrawlItemOptions({
      postingUrl: `https://example.com/jobs/${'same-prefix-'.repeat(20)}second`,
      sourceCrawlId: 'crawl-1',
      title: 'AI Platform Engineer',
    });

    expect(first.slug).not.toBe(second.slug);
    expect(String(first.slug).length).toBeLessThanOrEqual(160);
    expect(String(second.slug).length).toBeLessThanOrEqual(160);
  });
});
