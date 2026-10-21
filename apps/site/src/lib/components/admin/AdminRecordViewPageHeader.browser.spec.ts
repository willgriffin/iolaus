// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdminResource } from '$lib/admin/resources';
import AdminRecordViewPageHeaderHarness from './AdminRecordViewPageHeaderHarness.svelte';

// Action responses are supplied as plain props; HTTP form enhancement is covered by E2E.
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => {} }) }));
const actionNotifications = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('$lib/admin/opportunity-list-refresh', () => ({
  notifyOpportunityListChanged: actionNotifications.notify,
}));

afterEach(() => {
  document.body.replaceChildren();
  actionNotifications.notify.mockClear();
});

describe('AdminRecordViewPage registered header', () => {
  it('releases the outgoing header when the next route has application-shaped data', async () => {
    const opportunities = getAdminResource('opportunities');
    if (!opportunities) throw new Error('Expected opportunities resource');
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(AdminRecordViewPageHeaderHarness, {
      context: new Map(),
      target,
      props: {
        data: {
          referenceOptions: {},
          record: { id: 'outgoing-opportunity', title: 'Fictional role' },
          resource: opportunities,
        },
      },
    });
    flushSync();
    expect(
      target.querySelector('[data-testid="registered-header"]')?.textContent,
    ).toContain('Edit');
    component.leaveRecordRoute();
    expect(() => flushSync()).not.toThrow();
    expect(
      target.querySelector('[data-testid="registered-header"]')?.textContent,
    ).toBe('');
    expect(
      target.querySelector('nav[aria-label="Application materials"]'),
    ).not.toBeNull();
    await unmount(component);
  });
  it('does not retain record actions when an outgoing detail route loses its record data', () => {
    const skills = getAdminResource('skills');
    if (!skills) throw new Error('Expected skills resource');

    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(AdminRecordViewPageHeaderHarness, {
      context: new Map(),
      props: {
        data: {
          referenceOptions: {},
          record: { id: 'skill-1', name: 'TypeScript' },
          resource: skills,
        },
      },
      target,
    });
    flushSync();
    expect(
      target.querySelector('[data-testid="registered-header"]')?.textContent,
    ).toContain('Edit');

    component.removeRecord();
    flushSync();

    const header = target.querySelector('[data-testid="registered-header"]');
    expect(header?.textContent).toContain('Back to Skills');
    expect(header?.textContent).not.toContain('Edit');
    unmount(component);
  });
  it('settles each plain action result once and can unmount before client navigation', async () => {
    const opportunities = getAdminResource('opportunities');
    if (!opportunities) throw new Error('Expected opportunities resource');
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(AdminRecordViewPageHeaderHarness, {
      context: new Map(),
      target,
      props: {
        data: {
          referenceOptions: {},
          record: {
            id: 'opportunity-action',
            title: 'Fictional role',
            status: 'found',
          },
          resource: opportunities,
        },
      },
    });
    flushSync();
    const result = { status: 'draft_created', message: 'Draft ready' };
    component.applyActionResult(result);
    expect(() => flushSync()).not.toThrow();
    expect(actionNotifications.notify).toHaveBeenCalledExactlyOnceWith(
      'opportunity-action',
    );
    component.applyActionResult(result);
    flushSync();
    expect(actionNotifications.notify).toHaveBeenCalledTimes(1);
    component.applyActionResult({ status: 'draft_updated' });
    expect(() => flushSync()).not.toThrow();
    expect(actionNotifications.notify).toHaveBeenCalledTimes(2);
    await expect(unmount(component)).resolves.toBeUndefined();
  });
});
