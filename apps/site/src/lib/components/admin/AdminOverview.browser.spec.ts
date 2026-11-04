import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminOverview as Overview } from '$lib/admin/overview';
import AdminOverview from './AdminOverview.svelte';

let target: HTMLElement;
let component: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
});

it('keeps workspace links available while overview data streams', async () => {
  const { promise, resolve } = Promise.withResolvers<Overview>();
  component = mount(AdminOverview, { target, props: { overview: promise } });
  flushSync();

  await vi.waitFor(() => {
    expect(target.textContent).toContain('Loading priority tasks');
    expect(target.textContent).toContain('Loading opportunities');
  });
  expect(target.querySelector('a[href="/admin/tasks"]')).not.toBeNull();
  expect(target.querySelector('a[href="/admin/career"]')).not.toBeNull();
  expect(target.textContent).not.toContain('No active tasks');

  resolve({ tasks: [], opportunities: [], pendingOpportunities: [] });
  await vi.waitFor(() => {
    expect(target.textContent).toContain('No active tasks');
    expect(target.textContent).toContain('No new matches');
    expect(target.textContent).not.toContain('Loading opportunities');
  });
});

it('keeps navigation available when overview data fails', async () => {
  const { promise, reject } = Promise.withResolvers<Overview>();
  component = mount(AdminOverview, { target, props: { overview: promise } });
  flushSync();

  reject(new Error('private database details'));
  await vi.waitFor(() => {
    expect(target.textContent).toContain('Could not load priority tasks');
    expect(target.textContent).toContain('Could not load recommendations');
  });
  expect(target.querySelector('a[href="/admin/tasks"]')).not.toBeNull();
  expect(target.textContent).not.toContain('private database details');
});
