// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { getAdminResource } from '$lib/admin/resources';
import AdminRecordViewPageHeaderHarness from './AdminRecordViewPageHeaderHarness.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

describe('AdminRecordViewPage registered header', () => {
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
});
