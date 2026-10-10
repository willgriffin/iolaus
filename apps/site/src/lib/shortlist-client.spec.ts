import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicOpportunity } from './public-opportunity-contract.js';
import { createShortlistClient } from './shortlist-client.js';
import { SHORTLIST_STORAGE_KEY } from './shortlist-contract.js';

function opportunity(id = 'job-1'): PublicOpportunity {
  return {
    id,
    title: 'Platform engineer',
    normalized_title: 'platform engineer',
    company: { id: 'company-1', name: 'Example', slug: 'example' },
    location: {
      text: 'Remote',
      countries: ['CA'],
      remote: true,
      timezones: [],
    },
    seniority: 'senior',
    function: 'engineering',
    employment_type: 'full_time',
    work_mode: 'remote',
    skills: { required: [], preferred: [] },
    compensation: null,
    posted_at: null,
    updated_at: '2026-10-08T00:00:00.000Z',
    expires_at: null,
    analysis_version: 'v1',
    source_content_version: 1,
    posting_url: `https://example.test/jobs/${id}`,
    url: `/opportunities/${id}`,
  };
}
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}
function windowWith(storage: ReturnType<typeof memoryStorage>) {
  return {
    localStorage: storage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window;
}
afterEach(() => vi.unstubAllGlobals());

describe('shortlist client', () => {
  it('persists guest mutations as bounded, versioned public snapshots', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', windowWith(storage));
    const client = createShortlistClient({ signedIn: false });
    const entry = await client.mutate(opportunity(), {
      decision: 'saved',
      opened: true,
    });
    expect(entry.decision).toBe('saved');
    expect(entry.openedAt).not.toBeNull();
    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toMatchObject({
      version: 1,
      entries: [{ opportunity: { id: 'job-1' }, decision: 'saved' }],
    });
    await client.mutate(opportunity(), { opened: false, applied: true });
    expect(client.getEntries()[0]).toMatchObject({
      openedAt: null,
      appliedAt: expect.any(String),
      revision: 2,
    });
  });

  it('keeps an in-memory guest shortlist and warns if browser storage is blocked', async () => {
    const warning = vi.fn();
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('blocked');
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const client = createShortlistClient({
      signedIn: false,
      onWarning: warning,
    });
    await client.mutate(opportunity(), { decision: 'later' });
    expect(client.getEntries()).toHaveLength(1);
    expect(warning).toHaveBeenCalled();
  });

  it('rejects corrupt guest snapshots without trusting their contents', async () => {
    const storage = memoryStorage();
    storage.setItem(SHORTLIST_STORAGE_KEY, '{not json');
    const warning = vi.fn();
    vi.stubGlobal('window', windowWith(storage));
    const client = createShortlistClient({
      signedIn: false,
      onWarning: warning,
    });
    await expect(client.load()).resolves.toEqual([]);
    expect(warning).toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledWith(SHORTLIST_STORAGE_KEY);
  });

  it('does not optimistically change account state and reloads after a conflict', async () => {
    const serverEntry = {
      opportunity: opportunity(),
      decision: 'later',
      firstSeenAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
      openedAt: null,
      appliedAt: null,
      revision: 4,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: [serverEntry] })),
      )
      .mockResolvedValueOnce(new Response('', { status: 409 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: [serverEntry] })),
      );
    const warning = vi.fn();
    const client = createShortlistClient({
      signedIn: true,
      fetch: fetch as typeof globalThis.fetch,
      onWarning: warning,
    });
    await client.load();
    await expect(
      client.mutate(opportunity(), { decision: 'saved' }),
    ).rejects.toThrow('conflict');
    expect(client.getEntries()).toEqual([serverEntry]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('changed elsewhere'),
    );
  });

  it('imports acknowledged guest entries once and retains them after a failed import', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', windowWith(storage));
    const guest = createShortlistClient({ signedIn: false });
    await guest.mutate(opportunity(), { decision: 'saved' });
    const snapshot = JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!);
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          entries: snapshot.entries,
          acknowledgedIds: ['job-1'],
        }),
      ),
    );
    const account = createShortlistClient({
      signedIn: true,
      fetch: fetch as typeof globalThis.fetch,
    });
    await account.mergeGuest();
    expect(storage.getItem(SHORTLIST_STORAGE_KEY)).toContain('entries');
    expect(JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!).entries).toEqual(
      [],
    );

    await guest.mutate(opportunity('job-2'), { decision: 'later' });
    const unavailable = createShortlistClient({
      signedIn: true,
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response('', { status: 503 }),
        ) as typeof globalThis.fetch,
    });
    await expect(unavailable.mergeGuest()).rejects.toThrow('failed');
    expect(
      JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!).entries,
    ).toHaveLength(1);
  });

  it('does not resurrect an imported entry in a stale guest tab, while retaining a newer edit', async () => {
    const storage = memoryStorage();
    const window = windowWith(storage);
    vi.stubGlobal('window', window);
    const staleGuest = createShortlistClient({ signedIn: false });
    await staleGuest.mutate(opportunity(), { decision: 'saved' });
    const importer = createShortlistClient({
      signedIn: true,
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ entries: [], acknowledgedIds: ['job-1'] }),
          ),
        ) as typeof fetch,
    });
    await importer.mergeGuest();
    const listener = (
      window.addEventListener as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][1] as (event: StorageEvent) => void;
    listener({
      key: SHORTLIST_STORAGE_KEY,
      storageArea: storage,
    } as unknown as StorageEvent);
    expect(staleGuest.getEntries()).toEqual([]);
    expect(JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!).entries).toEqual(
      [],
    );

    const newer = {
      ...staleGuest.getEntries()[0],
      opportunity: opportunity(),
      decision: 'later' as const,
      firstSeenAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2099-10-09T00:00:00.000Z',
      openedAt: null,
      appliedAt: null,
      revision: 2,
    };
    storage.setItem(
      SHORTLIST_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [newer] }),
    );
    listener({
      key: SHORTLIST_STORAGE_KEY,
      storageArea: storage,
    } as unknown as StorageEvent);
    expect(staleGuest.getEntries()).toMatchObject([
      { decision: 'later', revision: 2 },
    ]);
    expect(
      JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!).entries,
    ).toMatchObject([{ decision: 'later', revision: 2 }]);
  });

  it('does not clear a guest removal marker during a signed-in mutation', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', windowWith(storage));
    const guest = createShortlistClient({ signedIn: false });
    await guest.mutate(opportunity(), { decision: 'saved' });
    const accountEntry = {
      opportunity: opportunity(),
      decision: 'later' as const,
      firstSeenAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
      openedAt: null,
      appliedAt: null,
      revision: 2,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ entries: [], acknowledgedIds: ['job-1'] }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entry: accountEntry })),
      );
    const account = createShortlistClient({
      signedIn: true,
      fetch: fetch as typeof fetch,
    });
    await account.mergeGuest();
    await account.mutate(opportunity(), { decision: 'later' });
    expect(storage.getItem(`${SHORTLIST_STORAGE_KEY}:tombstones`)).toContain(
      'job-1',
    );
  });

  it('uses a tombstone generation change to discard an old tab memory after compaction', async () => {
    const storage = memoryStorage();
    const window = windowWith(storage);
    vi.stubGlobal('window', window);
    const oldTab = createShortlistClient({ signedIn: false });
    await oldTab.mutate(opportunity('old-job'), { decision: 'saved' });
    storage.setItem(
      SHORTLIST_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: [] }),
    );
    storage.setItem(
      `${SHORTLIST_STORAGE_KEY}:tombstones`,
      JSON.stringify({
        generation: 1,
        tombstones: Array.from({ length: 500 }, (_, index) => ({
          id: `newer-${index}`,
          updatedAt: '2099-01-01T00:00:00.000Z',
          revision: 1,
        })),
      }),
    );
    const listener = (
      window.addEventListener as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][1] as (event: StorageEvent) => void;
    listener({
      key: SHORTLIST_STORAGE_KEY,
      storageArea: storage,
    } as unknown as StorageEvent);
    expect(oldTab.getEntries()).toEqual([]);
    expect(JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!).entries).toEqual(
      [],
    );
  });

  it('keeps unacknowledged browser choices and explains a partial import', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', windowWith(storage));
    const guest = createShortlistClient({ signedIn: false });
    await guest.mutate(opportunity('unavailable-job'), { decision: 'saved' });
    const warning = vi.fn();
    const account = createShortlistClient({
      signedIn: true,
      onWarning: warning,
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ entries: [], acknowledgedIds: [] })),
        ) as typeof fetch,
    });
    await account.mergeGuest();
    expect(
      JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!).entries,
    ).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('could not be imported'),
    );
  });

  it('imports guest snapshots in bounded batches and preserves the remainder after a later failure', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', windowWith(storage));
    const guestEntries = Array.from({ length: 51 }, (_, index) => ({
      opportunity: opportunity(`job-${index}`),
      decision: 'saved' as const,
      firstSeenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updatedAt: '2026-10-08T00:00:00.000Z',
      openedAt: null,
      appliedAt: null,
      revision: 1,
    }));
    storage.setItem(
      SHORTLIST_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: guestEntries }),
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entries: [],
            acknowledgedIds: guestEntries
              .slice(0, 50)
              .map((entry) => entry.opportunity.id),
          }),
        ),
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const client = createShortlistClient({
      signedIn: true,
      fetch: fetch as typeof fetch,
    });
    await expect(client.mergeGuest()).rejects.toThrow('failed');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1].body).entries).toHaveLength(50);
    expect(JSON.parse(fetch.mock.calls[1][1].body).entries).toHaveLength(1);
    expect(
      JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!).entries.map(
        (entry: { opportunity: { id: string } }) => entry.opportunity.id,
      ),
    ).toEqual(['job-50']);
  });

  it('continues to later batches when an earlier batch is unavailable', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', windowWith(storage));
    const guestEntries = Array.from({ length: 51 }, (_, index) => ({
      opportunity: opportunity(`job-${index}`),
      decision: 'saved' as const,
      firstSeenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updatedAt: '2026-10-08T00:00:00.000Z',
      openedAt: null,
      appliedAt: null,
      revision: 1,
    }));
    storage.setItem(
      SHORTLIST_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: guestEntries }),
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: [], acknowledgedIds: [] })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ entries: [], acknowledgedIds: ['job-50'] }),
        ),
      );
    const client = createShortlistClient({
      signedIn: true,
      fetch: fetch as typeof fetch,
    });
    await client.mergeGuest();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1].body).entries).toHaveLength(50);
    expect(JSON.parse(fetch.mock.calls[1][1].body).entries).toHaveLength(1);
    expect(
      JSON.parse(storage.getItem(SHORTLIST_STORAGE_KEY)!).entries,
    ).toHaveLength(50);
  });

  it('marks only confirmed missing visible entries unavailable during refresh', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', windowWith(storage));
    const warning = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(new Response('', { status: 503 })),
    );
    const guest = createShortlistClient({
      signedIn: false,
      onWarning: warning,
    });
    await guest.mutate(opportunity(), { decision: 'saved' });
    await guest.mutate(opportunity('job-2'), { decision: 'later' });
    await guest.refreshAvailable(['job-1', 'job-2']);
    expect(
      guest.getEntries().find((entry) => entry.opportunity.id === 'job-1')
        ?.available,
    ).toBe(false);
    expect(
      guest.getEntries().find((entry) => entry.opportunity.id === 'job-2')
        ?.available,
    ).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('refresh'));
  });

  it('does not let a late refresh overwrite a newer guest decision', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', windowWith(storage));
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const client = createShortlistClient({ signedIn: false });
    await client.mutate(opportunity(), { decision: 'later' });
    const refresh = client.refreshAvailable(['job-1']);
    await client.mutate(opportunity(), { decision: 'saved' });
    resolve(new Response(JSON.stringify(opportunity())));
    await refresh;
    expect(client.getEntries()[0]).toMatchObject({
      decision: 'saved',
      revision: 2,
      available: true,
    });
  });

  it('does not publish a response that resolves after destroy', async () => {
    let resolve!: (response: Response) => void;
    const changed = vi.fn();
    const client = createShortlistClient({
      signedIn: true,
      onChange: changed,
      fetch: vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ) as typeof fetch,
    });
    const loading = client.load();
    client.destroy();
    resolve(new Response(JSON.stringify({ entries: [] })));
    await expect(loading).rejects.toThrow('destroyed');
    expect(changed).not.toHaveBeenCalled();
  });

  it('surfaces malformed account JSON without replacing the current shortlist', async () => {
    const warning = vi.fn();
    const client = createShortlistClient({
      signedIn: true,
      onWarning: warning,
      fetch: vi
        .fn()
        .mockResolvedValue(new Response('{bad json')) as typeof fetch,
    });
    await expect(client.load()).rejects.toThrow('invalid');
    expect(client.getEntries()).toEqual([]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('invalid'));
  });

  it('reloads account state after an ambiguous mutation transport failure', async () => {
    const serverEntry = {
      opportunity: opportunity(),
      decision: 'saved',
      firstSeenAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
      openedAt: null,
      appliedAt: null,
      revision: 1,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: [serverEntry] })),
      )
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: [serverEntry] })),
      );
    const client = createShortlistClient({
      signedIn: true,
      fetch: fetch as typeof globalThis.fetch,
    });
    await client.load();
    await expect(
      client.mutate(opportunity(), { decision: 'later' }),
    ).rejects.toThrow('request failed');
    expect(client.getEntries()).toEqual([serverEntry]);
  });
});
