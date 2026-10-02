import { beforeEach, describe, expect, it, vi } from 'vitest';
import vanta from './fixtures/ats/vanta-developer-experience.json';
import {
  fingerprintOpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';

const getCollection = vi.hoisted(() => vi.fn());
vi.mock('./smrt.js', () => ({ getCollection }));
vi.mock('./change-feed.js', () => ({
  bumpOpportunityChangeFeed: vi.fn(async () => {}),
}));

function primaryPage() {
  return new Response(
    `<script>window.__appData = ${JSON.stringify({ organization: vanta.organization, posting: vanta.posting })}</script><script type="application/ld+json">${JSON.stringify(vanta.jobPosting)}</script>`,
  );
}

describe('native ATS import source identity', () => {
  beforeEach(() => getCollection.mockReset());

  it('persists employer, every Canada location and valid compensation using the import database', async () => {
    const opportunity = {
      id: 'opportunity',
      postingUrl: vanta.sourceUrl,
      title: vanta.posting.title,
      sourceContentFingerprint: '',
      sourceContentVersion: 0,
      companyId: '',
      save: vi.fn(),
    };
    const opportunities = { get: vi.fn(async () => opportunity) };
    const companies = {
      list: vi.fn(async () => [{ id: 'vanta-company' }]),
      create: vi.fn(),
    };
    getCollection.mockImplementation(async (type) =>
      type === 'Company' ? companies : opportunities,
    );
    const database = { update: vi.fn(async () => ({ affected: 1 })) };
    const { loadOpportunityDetails } = await import('./opportunity-details.js');
    await loadOpportunityDetails(
      'opportunity',
      vi.fn(async () => primaryPage()),
      { db: database as never },
    );
    const [table, fence, updates] = database.update.mock
      .calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(table).toBe('opportunities');
    expect(fence).toEqual([
      [{ id: 'opportunity' }, { source_content_fingerprint: null }],
      [{ id: 'opportunity' }, { source_content_fingerprint: '' }],
    ]);
    expect(updates).toMatchObject({
      company_id: 'vanta-company',
      salary_min: 224000,
      salary_max: 263000,
      currency: 'USD',
      source_content_version: 1,
      locations: 'Remote U.S.\nRemote - Canada\nCanada\nUSA',
    });
    const content = parseOpportunitySourceContent(updates.source_content_json)!;
    expect(updates.source_content_fingerprint).toBe(
      fingerprintOpportunitySourceContent(content),
    );
    expect(content.locationNotes).toContain('Canada');
    expect(getCollection).toHaveBeenCalledWith('Company', { db: database });
    expect(companies.create).not.toHaveBeenCalled();
    expect(opportunity.save).not.toHaveBeenCalled();
  });

  it('preserves versions on identical refresh and increments only actual source changes', async () => {
    const opportunity: Record<string, unknown> = {
      id: 'opportunity',
      postingUrl: vanta.sourceUrl,
      title: vanta.posting.title,
      companyId: 'known-company',
      save: vi.fn(async () => {}),
    };
    getCollection.mockResolvedValue({ get: vi.fn(async () => opportunity) });
    const { loadOpportunityDetails } = await import('./opportunity-details.js');
    await loadOpportunityDetails('opportunity', async () => primaryPage());
    const initialFingerprint = opportunity.sourceContentFingerprint;
    await loadOpportunityDetails('opportunity', async () => primaryPage());
    expect(opportunity.sourceContentFingerprint).toBe(initialFingerprint);
    expect(opportunity.sourceContentVersion).toBe(1);
    await loadOpportunityDetails(
      'opportunity',
      async () =>
        new Response(
          `<script>window.__appData = ${JSON.stringify({ organization: vanta.organization, posting: { ...vanta.posting, secondaryLocationNames: ['Remote - Canada', 'Remote - UK'] } })}</script>`,
        ),
    );
    expect(opportunity.sourceContentFingerprint).not.toBe(initialFingerprint);
    expect(opportunity.sourceContentVersion).toBe(2);
    expect(opportunity.locations).toContain('Remote - UK');
  });

  it('re-resolves after a lost source CAS instead of overwriting a newer version', async () => {
    const opportunity = {
      id: 'opportunity',
      postingUrl: vanta.sourceUrl,
      title: vanta.posting.title,
      companyId: 'known-company',
      sourceContentFingerprint: 'newer-source',
      sourceContentVersion: 4,
      save: vi.fn(),
    };
    getCollection.mockResolvedValue({ get: vi.fn(async () => opportunity) });
    const database = {
      update: vi
        .fn()
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 1 }),
    };
    const fetch = vi.fn(async () => primaryPage());
    const { loadOpportunityDetails } = await import('./opportunity-details.js');
    await loadOpportunityDetails('opportunity', fetch, {
      db: database as never,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(database.update.mock.calls[1][1]).toMatchObject({
      id: 'opportunity',
      source_content_fingerprint: 'newer-source',
      source_content_version: 4,
    });
    expect(database.update.mock.calls[1][2]).toMatchObject({
      source_content_version: 5,
    });
    expect(opportunity.save).not.toHaveBeenCalled();
  });
});
