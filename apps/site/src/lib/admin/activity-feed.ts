import type {
  ShellActivity,
  ShellState,
} from '@happyvertical/smrt-svelte/workspace';

export type AdminActivityFeedState = {
  status: 'loading' | 'ready' | 'unavailable';
  observedAt: string | null;
  truncated: boolean;
};
type ActivityResponse = {
  items: Array<{
    id: string;
    title: string;
    status: ShellActivity['status'];
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    progress: number | null;
  }>;
  observedAt: string;
  truncated: boolean;
};
function parseResponse(value: unknown): ActivityResponse {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid activity feed');
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.items) ||
    body.items.length > 20 ||
    typeof body.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(body.observedAt)) ||
    typeof body.truncated !== 'boolean'
  )
    throw new Error('Invalid activity feed');
  const ids = new Set<string>();
  for (const row of body.items) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.title !== 'string' ||
      !row.title.trim() ||
      !['queued', 'running', 'completed', 'failed', 'canceled'].includes(
        row.status,
      ) ||
      typeof row.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      !(
        row.startedAt === null ||
        (typeof row.startedAt === 'string' &&
          Number.isFinite(Date.parse(row.startedAt)))
      ) ||
      !(
        row.completedAt === null ||
        (typeof row.completedAt === 'string' &&
          Number.isFinite(Date.parse(row.completedAt)))
      ) ||
      (row.status === 'running' && row.startedAt === null) ||
      ((row.status === 'queued' || row.status === 'running') &&
        row.completedAt !== null) ||
      (['completed', 'failed', 'canceled'].includes(row.status) &&
        row.completedAt === null) ||
      (row.status !== 'running' && row.progress !== null) ||
      !(
        row.progress === null ||
        (typeof row.progress === 'number' &&
          Number.isFinite(row.progress) &&
          row.progress >= 0 &&
          row.progress <= 100)
      )
    )
      throw new Error('Invalid activity feed');
    ids.add(row.id);
  }
  return body as unknown as ActivityResponse;
}

/** One authenticated, abortable reader per layout; the server owns process authority. */
export function startAdminActivityFeed({
  shell,
  onState,
  fetcher = fetch,
  visibility = document,
  events = window,
}: {
  shell: Pick<ShellState, 'upsertActivity' | 'removeActivity'>;
  onState: (state: AdminActivityFeedState) => void;
  fetcher?: typeof fetch;
  visibility?: Pick<
    Document,
    'visibilityState' | 'addEventListener' | 'removeEventListener'
  >;
  events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}): { refresh: () => Promise<void>; stop: () => void } {
  const owned = new Set<string>();
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let delay = 10_000;
  const clear = () => {
    for (const id of owned) shell.removeActivity(id);
    owned.clear();
  };
  const refresh = (): Promise<void> => {
    if (disposed || visibility.visibilityState === 'hidden')
      return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(timer);
    controller = new AbortController();
    inFlight = (async () => {
      try {
        const response = await fetcher('/api/admin/activity', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller?.signal,
        });
        if (!response.ok) throw new Error('Activity unavailable');
        const body = parseResponse(await response.json());
        if (disposed) return;
        const next = new Set(
          body.items.map((item) => `admin-activity:${item.id}`),
        );
        for (const id of owned) if (!next.has(id)) shell.removeActivity(id);
        owned.clear();
        for (const item of body.items) {
          const activity: ShellActivity = {
            id: `admin-activity:${item.id}`,
            label: item.title,
            kind: 'job',
            scope: 'system',
            status: item.status,
            createdAt: item.createdAt,
            updatedAt: item.completedAt ?? item.startedAt ?? item.createdAt,
            ...(item.progress !== null ? { progress: item.progress } : {}),
          };
          shell.upsertActivity(activity);
          owned.add(activity.id);
        }
        delay = body.items.some(
          (item) => item.status === 'queued' || item.status === 'running',
        )
          ? 5_000
          : 10_000;
        onState({
          status: 'ready',
          observedAt: body.observedAt,
          truncated: body.truncated,
        });
      } catch {
        if (!disposed) {
          clear();
          onState({
            status: 'unavailable',
            observedAt: null,
            truncated: false,
          });
        }
      } finally {
        inFlight = null;
        if (!disposed)
          timer = setTimeout(() => {
            void refresh();
          }, delay);
      }
    })();
    return inFlight;
  };
  const changed = () => {
    clearTimeout(timer);
    if (visibility.visibilityState !== 'hidden') void refresh();
  };
  const requested = () => {
    void refresh();
  };
  onState({ status: 'loading', observedAt: null, truncated: false });
  visibility.addEventListener('visibilitychange', changed);
  events.addEventListener('iolaus:admin-resource-refresh', requested);
  void refresh();
  return {
    refresh,
    stop() {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      visibility.removeEventListener('visibilitychange', changed);
      events.removeEventListener('iolaus:admin-resource-refresh', requested);
      clear();
    },
  };
}
