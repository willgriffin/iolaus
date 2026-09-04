// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SourceCrawlProgress from './SourceCrawlProgress.svelte';

const CRAWL_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SourceCrawlProgress', () => {
  it('starts its canonical status poll after mounting', async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        ({
          json: async () => ({
            items: [
              {
                counts: { candidates: 1, created: 1 },
                errors: [],
                finishedAt: '2026-09-04T05:00:01.000Z',
                id: CRAWL_ID,
                sourceId: SOURCE_ID,
                startedAt: '2026-09-04T05:00:00.000Z',
                status: 'completed',
              },
            ],
          }),
          ok: true,
        }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(SourceCrawlProgress, {
      props: { crawlId: CRAWL_ID, sourceId: SOURCE_ID },
      target,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `crawlId=${CRAWL_ID}`,
    );
    expect(target.textContent).toContain('Pull complete.');
    unmount(component);
  });

  it('retries only the same crawl status after a transient status failure', async () => {
    const onPullAgain = vi.fn();
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => ({ ok: false }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(SourceCrawlProgress, {
      props: { crawlId: CRAWL_ID, onPullAgain, sourceId: SOURCE_ID },
      target,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const retry = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry status',
    );
    expect(retry).toBeTruthy();
    retry?.click();
    flushSync();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(onPullAgain).not.toHaveBeenCalled();
    unmount(component);
  });
});
