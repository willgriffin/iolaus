import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAdminActivityFeed } from './activity-feed';

const observedAt = '2026-10-02T20:00:00.000Z';
const row = {
  id: 'one',
  title: 'Opportunity assessment',
  status: 'running',
  createdAt: observedAt,
  completedAt: null,
  startedAt: observedAt,
  progress: 40,
};
function fixture(fetcher: typeof fetch) {
  const visibility = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const events = new EventTarget();
  const shell = { upsertActivity: vi.fn(), removeActivity: vi.fn() };
  const onState = vi.fn();
  const feed = startAdminActivityFeed({
    shell,
    onState,
    fetcher,
    visibility,
    events,
  });
  return { feed, shell, onState, visibility, events };
}
function response(items: unknown[] = [row], extras = {}) {
  return new Response(
    JSON.stringify({ items, observedAt, truncated: false, ...extras }),
  );
}
afterEach(() => vi.useRealTimers());
describe('admin activity feed', () => {
  it('uses same-origin no-cache reads and maps only the safe running DTO to the native registry', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const { feed, shell, onState } = fixture(fetcher);
    await feed.refresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/admin/activity',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(shell.upsertActivity).toHaveBeenCalledWith({
      id: 'admin-activity:one',
      label: row.title,
      kind: 'job',
      scope: 'system',
      status: 'running',
      createdAt: observedAt,
      updatedAt: observedAt,
      progress: 40,
    });
    expect(onState).toHaveBeenLastCalledWith({
      status: 'ready',
      observedAt,
      truncated: false,
    });
    feed.stop();
  });
  it('never overlaps reads and waits for completion before polling', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const { feed, events } = fixture(fetcher);
    events.dispatchEvent(new Event('iolaus:admin-resource-refresh'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(response());
    await feed.refresh();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    feed.stop();
    resolve(response());
  });
  it('removes finished owned rows and represents successful empty separately from unavailable', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(new Response('', { status: 403 }));
    const { feed, shell, onState } = fixture(fetcher);
    await feed.refresh();
    await feed.refresh();
    expect(shell.removeActivity).toHaveBeenCalledWith('admin-activity:one');
    expect(onState).toHaveBeenLastCalledWith({
      status: 'ready',
      observedAt,
      truncated: false,
    });
    await feed.refresh();
    expect(onState).toHaveBeenLastCalledWith({
      status: 'unavailable',
      observedAt: null,
      truncated: false,
    });
    feed.stop();
  });
  it.each([
    { ...row, status: 'unknown' },
    { ...row, progress: 101 },
    { ...row, startedAt: 'invalid' },
  ])('rejects malformed or nonrunning data instead of making an active process claim', async (item) => {
    const { feed, shell, onState } = fixture(
      vi.fn().mockResolvedValue(response([item])),
    );
    await feed.refresh();
    expect(shell.upsertActivity).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({
      status: 'unavailable',
      observedAt: null,
      truncated: false,
    });
    feed.stop();
  });
  it('preserves queued→running→completed without promoting waiting or finished work', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          { ...row, status: 'queued', startedAt: null, progress: null },
        ]),
      )
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(
        response([
          {
            ...row,
            status: 'completed',
            completedAt: observedAt,
            progress: null,
          },
        ]),
      );
    const { feed, shell } = fixture(fetcher);
    await feed.refresh();
    expect(shell.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'queued', createdAt: observedAt }),
    );
    await feed.refresh();
    expect(shell.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'running', progress: 40 }),
    );
    await feed.refresh();
    expect(shell.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
    expect(shell.upsertActivity.mock.calls[2]![0].progress).toBeUndefined();
    feed.stop();
  });
  it('polls queued work promptly and recent-only/empty feeds without overlapping', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          { ...row, status: 'queued', startedAt: null, progress: null },
        ]),
      )
      .mockResolvedValue(response([]));
    const { feed } = fixture(fetcher);
    await feed.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    feed.stop();
  });

  it('clears the previously running process on a failed fresh read', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const { feed, shell, onState } = fixture(fetcher);
    await feed.refresh();
    await feed.refresh();
    expect(shell.removeActivity).toHaveBeenCalledWith('admin-activity:one');
    expect(onState).toHaveBeenLastCalledWith({
      status: 'unavailable',
      observedAt: null,
      truncated: false,
    });
    feed.stop();
  });
  it('rejects duplicate or oversized lists and retains truncation only for a valid bounded read', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([row, row]))
      .mockResolvedValueOnce(
        response(
          Array.from({ length: 21 }, (_, index) => ({
            ...row,
            id: String(index),
          })),
        ),
      )
      .mockResolvedValueOnce(response([row], { truncated: true }));
    const { feed, shell, onState } = fixture(fetcher);
    await feed.refresh();
    await feed.refresh();
    expect(shell.upsertActivity).not.toHaveBeenCalled();
    await feed.refresh();
    expect(shell.upsertActivity).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith({
      status: 'ready',
      observedAt,
      truncated: true,
    });
    feed.stop();
  });
  it('pauses background polling and refreshes once on visibility return', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () => response());
    const { feed, visibility } = fixture(fetcher);
    await feed.refresh();
    visibility.visibilityState = 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await feed.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    feed.stop();
  });
  it('profile-switch disposal clears old items and its late response cannot replace the new profile feed', async () => {
    let resolveOld!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolveOld = done;
          }),
      )
      .mockResolvedValueOnce(
        response([{ ...row, id: 'new-profile', title: 'Source preparation' }]),
      );
    const old = fixture(fetcher);
    await old.feed.refresh();
    const pending = old.feed.refresh();
    old.feed.stop();
    expect(old.shell.removeActivity).toHaveBeenCalledWith('admin-activity:one');
    const currentState = vi.fn();
    const current = startAdminActivityFeed({
      shell: old.shell,
      onState: currentState,
      fetcher,
      visibility: old.visibility,
      events: old.events,
    });
    await current.refresh();
    resolveOld(response());
    await pending;
    expect(old.shell.upsertActivity).toHaveBeenCalledTimes(2);
    expect(old.shell.upsertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'admin-activity:new-profile',
        label: 'Source preparation',
      }),
    );
    expect(currentState).toHaveBeenLastCalledWith({
      status: 'ready',
      observedAt,
      truncated: false,
    });
    current.stop();
  });
  it('aborts old ownership context and ignores its late response while preserving other registry entries', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const { feed, shell, onState, events } = fixture(fetcher);
    const settled = feed.refresh();
    const signal = fetcher.mock.calls[0][1].signal;
    feed.stop();
    expect(signal.aborted).toBe(true);
    resolve(response());
    await settled;
    events.dispatchEvent(new Event('iolaus:admin-resource-refresh'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(shell.upsertActivity).not.toHaveBeenCalled();
    expect(shell.removeActivity).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(1);
  });
});
