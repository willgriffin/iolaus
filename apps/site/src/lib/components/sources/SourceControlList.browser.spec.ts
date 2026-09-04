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
  it('posts a bounded, retry-stable canonical crawl request', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('source-health')) return response({ items: [] });
      if (url === '/api/job-search/crawl-source') {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ crawlId: 'crawl-1', status: 'queued' });
      }
      if (url.includes('source-crawl-status')) {
        return response({
          items: [
            {
              counts: {},
              errors: [],
              id: 'crawl-1',
              sourceId: SOURCE_ID,
              status: 'running',
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
