// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SourceControlList from './SourceControlList.svelte';

const SOURCE_ID = '22222222-2222-4222-8222-222222222222';

function source(active: boolean) {
  return {
    id: SOURCE_ID,
    isActive: active,
    name: 'OpenAI careers',
    provider: 'greenhouse',
    sourceRole: 'root',
    type: 'job_board',
    url: 'https://job-boards.greenhouse.io/openai',
  };
}

function response(payload: unknown) {
  return { json: async () => payload, ok: true };
}

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SourceControlList', () => {
  it('projects persisted root sources from source health when generic hydration is empty', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('source-health')) {
        return response({
          items: [
            {
              active: true,
              health: {
                created: 3,
                errors: 0,
                failedRuns: 0,
                runs: 1,
              },
              id: SOURCE_ID,
              lastCheckedAt: '2026-09-04T12:00:00.000Z',
              name: 'OpenAI careers',
              provider: 'ashby',
              type: 'company_careers',
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(SourceControlList, {
      props: { records: [] },
      target,
    });

    await vi.waitFor(() => {
      expect(target.textContent).toContain('OpenAI careers');
      expect(target.textContent).toContain('Healthy');
      expect(target.textContent).toContain('3 new listings from 1 pull.');
    });
    expect(
      target.querySelector(`[data-source-id="${SOURCE_ID}"]`),
    ).not.toBeNull();
    expect(target.textContent).not.toContain('Start with a job source');
    unmount(component);
  });

  it('keeps one new idempotency key after repeated terminal pull-again clicks', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('source-health')) return response({ items: [] });
      if (url === '/api/job-search/crawl-source') {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const crawlId = bodies.length === 1 ? 'crawl-1' : 'crawl-2';
        return response({
          crawlId,
          reused: bodies.length > 2,
          status: 'queued',
        });
      }
      if (url.includes('source-crawl-status')) {
        const crawlId = new URL(url, 'http://localhost').searchParams.get(
          'crawlId',
        );
        return response({
          items: [
            {
              counts: {},
              errors: [],
              id: crawlId,
              sourceId: SOURCE_ID,
              status: crawlId === 'crawl-1' ? 'failed' : 'running',
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(SourceControlList, {
      props: { records: [source(true)] },
      target,
    });

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('source-health'),
        expect.anything(),
      ),
    );
    const pull = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Pull now'),
    );
    pull?.click();
    flushSync();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));

    expect(bodies[0]).toMatchObject({
      limit: 25,
      reason: 'Requested from the Sources page.',
      sourceId: SOURCE_ID,
    });
    expect(bodies[0].idempotencyKey).toMatch(
      new RegExp(`^source-ui:${SOURCE_ID}:`),
    );

    const pullAgain = await vi.waitFor(() => {
      const button = Array.from(target.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.includes('Pull again'),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      return button as HTMLButtonElement;
    });
    pullAgain.click();
    pullAgain.click();
    flushSync();
    await vi.waitFor(() => expect(bodies).toHaveLength(2));

    const retryKey = bodies[1].idempotencyKey;
    const pullNow = await vi.waitFor(() => {
      const button = Array.from(target.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.includes('Pull now'),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button as HTMLButtonElement;
    });
    pullNow.click();
    flushSync();
    await vi.waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2].idempotencyKey).toBe(retryKey);
    unmount(component);
  });

  it('uses the canonical activation endpoint for a paused source', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('source-health')) return response({ items: [] });
      if (url === '/api/job-search/set-source-active') {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ active: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(SourceControlList, {
      props: { records: [source(false)] },
      target,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const activate = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Activate'),
    );
    activate?.click();
    flushSync();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));

    expect(bodies[0]).toEqual({
      active: true,
      reason: 'Updated from the Sources page.',
      sourceId: SOURCE_ID,
    });
    unmount(component);
  });
});
