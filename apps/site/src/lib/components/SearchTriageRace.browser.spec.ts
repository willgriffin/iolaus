// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicOpportunity } from '$lib/public-opportunity-contract.js';

const client = vi.hoisted(() => ({
  mutate: vi.fn(),
  load: vi.fn(),
  mergeGuest: vi.fn(),
  destroy: vi.fn(),
  refreshAvailable: vi.fn(),
  getEntries: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ replaceState: vi.fn() }));
vi.mock('$app/state', () => ({
  page: {
    url: new URL('http://localhost/opportunities?search=test'),
    state: {},
  },
}));
vi.mock('$lib/shortlist-client.js', () => ({
  createShortlistClient: () => client,
}));

import Harness from './SearchTriageRaceHarness.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
};
function opportunity(id: string): PublicOpportunity {
  return {
    id,
    title: `Role ${id}`,
    normalized_title: `Role ${id}`,
    company: null,
    location: { text: '', countries: [], remote: null, timezones: [] },
    seniority: 'unknown',
    function: '',
    employment_type: '',
    work_mode: '',
    skills: { required: [], preferred: [] },
    compensation: null,
    posted_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    analysis_version: 'test',
    source_content_version: 1,
    posting_url: `https://jobs.test/${id}`,
    url: `/opportunities/${id}`,
  };
}
function button(name: string) {
  const found = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) =>
      item.getAttribute('aria-label') === name ||
      item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
beforeEach(() =>
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))),
);
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SearchTriage delayed mutations', () => {
  it('does not show a rejected old decision on a replacement deck', async () => {
    const saveA = deferred();
    client.load.mockResolvedValue([]);
    client.mergeGuest.mockResolvedValue(undefined);
    client.mutate.mockImplementation(
      (_opportunity: PublicOpportunity, change: { decision?: string }) =>
        change.decision === 'saved'
          ? saveA.promise
          : Promise.resolve(undefined),
    );
    target = document.createElement('div');
    document.body.append(target);
    component = mount(Harness, { target });
    component.replaceDeck([opportunity('A'), opportunity('B')]);
    await new Promise((resolve) => setTimeout(resolve));
    await tick();
    flushSync();
    client.mutate.mockClear();
    button('Save').click();
    await tick();
    flushSync();
    expect(client.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'A' }),
      { decision: 'saved' },
    );
    button('List view').click();
    await tick();
    flushSync();
    button('Review Role B').click();
    component.replaceDeck([opportunity('C')]);
    await tick();
    flushSync();
    saveA.reject(new Error('Save A failed'));
    await new Promise((resolve) => setTimeout(resolve));
    await tick();
    flushSync();
    expect(target.textContent).toContain('Role C');
    expect(
      target.querySelector('.triage-content > .error[role=alert]'),
    ).toBeNull();
  });

  it('does not let a delayed decision or undo rewrite a newer deck, card, or list origin', async () => {
    const saveA = deferred(),
      undoC = deferred();
    let saved = 0;
    client.load.mockResolvedValue([]);
    client.mergeGuest.mockResolvedValue(undefined);
    client.mutate.mockImplementation(
      (_opportunity: PublicOpportunity, change: { decision?: string }) => {
        if (change.decision === 'saved' && saved++ === 0) return saveA.promise;
        if (change.decision === 'seen') return Promise.resolve(undefined);
        if (change.decision === 'saved' && saved === 2)
          return Promise.resolve(undefined);
        if (change.decision === 'seen') return Promise.resolve(undefined);
        return undoC.promise;
      },
    );
    target = document.createElement('div');
    document.body.append(target);
    component = mount(Harness, { target });
    component.replaceDeck([opportunity('A'), opportunity('B')]);
    await new Promise((resolve) => setTimeout(resolve));
    await tick();
    flushSync();
    client.mutate.mockClear();
    button('Save').click();
    await tick();
    flushSync();
    button('List view').click();
    await tick();
    flushSync();
    button('Review Role B').click();
    component.replaceDeck([opportunity('C'), opportunity('D')]);
    await tick();
    flushSync();
    saveA.resolve();
    await tick();
    flushSync();
    expect(target.textContent).toContain('Role C');
    expect(button('Undo last choice').disabled).toBe(true);

    button('Save').click();
    await tick();
    flushSync();
    button('Undo last choice').click();
    await tick();
    flushSync();
    button('List view').click();
    await tick();
    flushSync();
    button('Review Role D').click();
    component.replaceDeck([opportunity('E')]);
    await tick();
    flushSync();
    undoC.resolve();
    await tick();
    flushSync();
    expect(target.textContent).toContain('Role E');
    expect(button('Undo last choice').disabled).toBe(true);
  });
});
