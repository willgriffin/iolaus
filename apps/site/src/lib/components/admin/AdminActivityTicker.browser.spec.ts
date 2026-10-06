// @vitest-environment happy-dom
import type { ShellActivity } from '@happyvertical/smrt-svelte/workspace';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { expect, it } from 'vitest';
import AdminActivityTicker from './AdminActivityTicker.svelte';

it('mounts native status chips from active feed rows and updates to the honest empty state', async () => {
  const feed = new SvelteMap<string, ShellActivity[]>([
    [
      'items',
      [
        {
          id: 'running',
          kind: 'job',
          scope: 'system',
          status: 'running',
          label: 'Review captured material',
          progress: 42,
          detailHref: '/admin/agent-runs/running',
        },
        {
          id: 'queued',
          kind: 'job',
          scope: 'system',
          status: 'queued',
          label: 'Waiting for worker',
        },
        {
          id: 'finished',
          kind: 'job',
          scope: 'system',
          status: 'completed',
          label: 'Finished historical process',
        },
      ],
    ],
  ]);
  const target = document.createElement('div');
  document.body.append(target);
  const component = flushSync(() =>
    mount(AdminActivityTicker, {
      target,
      props: {
        get activities() {
          return feed.get('items') ?? [];
        },
      },
    }),
  );
  try {
    expect(target.textContent).toContain('Review captured material');
    expect(target.textContent).toContain('running · 42%');
    expect(target.textContent).toContain('Waiting for worker');
    expect(target.textContent).not.toContain('Finished historical process');
    expect(target.querySelector('a')?.getAttribute('href')).toBe(
      '/admin/agent-runs/running',
    );
    expect(
      target.querySelector('[aria-label="Active processes"]'),
    ).not.toBeNull();
    flushSync(() => feed.set('items', []));
    expect(target.textContent).toContain('No active processes');
    expect(target.textContent).not.toContain('Review captured material');
  } finally {
    await unmount(component);
    target.remove();
  }
});
