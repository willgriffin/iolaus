// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
const page = vi.hoisted(() => ({
  url: new URL(
    'http://localhost/admin/opportunities?review=unsorted&sort=newest&skill=Rust',
  ),
}));
vi.mock('$app/navigation', () => navigation);
vi.mock('$app/state', () => ({
  page,
}));
vi.mock('../admin/admin-resource-hydration', () => ({
  ADMIN_RESOURCE_REFRESH_EVENT: 'iolaus:admin-resource-refresh',
}));
// Modal decisions/data loading have separate workflow coverage. Here observe the real row-to-modal boundary without a network request.
vi.mock('../admin/OpportunityTriageModal.svelte', async () => ({
  default: (await import('./OpportunityViewsModalFixture.svelte')).default,
}));

import Harness from './OpportunityViewsHarness.svelte';

let cleanup: (() => void) | undefined;
let originalStorage: PropertyDescriptor | undefined;
let storage: Storage;
function testStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(String(key)) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(String(key));
    },
    setItem(key: string, value: string) {
      values.set(String(key), String(value));
    },
  };
}
beforeEach(() => {
  // Node's optional global localStorage is absent in this runner. Supply the
  // complete browser Storage boundary, retaining it across component remounts.
  originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
  storage = testStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  navigation.goto.mockClear();
  page.url = new URL(
    'http://localhost/admin/opportunities?review=unsorted&sort=newest&skill=Rust',
  );
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  if (originalStorage)
    Object.defineProperty(window, 'localStorage', originalStorage);
  else Reflect.deleteProperty(window, 'localStorage');
  document.body.replaceChildren();
});
function setup() {
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(Harness, { target });
  cleanup = () => unmount(component);
  flushSync();
  function button(label: string) {
    const found = [
      ...target.querySelectorAll<HTMLButtonElement>('button'),
    ].find((item) => item.textContent?.trim() === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  }
  return {
    target,
    component,
    button,
    switchTo(label: string) {
      button(label).click();
      flushSync();
    },
    selected() {
      return target.querySelector('output')?.textContent;
    },
    check(label: string) {
      const found = target.querySelector<HTMLInputElement>(
        `input[aria-label="${label}"]`,
      );
      if (!found) throw new Error(`Missing checkbox ${label}`);
      found.click();
      flushSync();
    },
  };
}
describe('Opportunity card list interaction', () => {
  it('uses one card collection and preserves off-page IDs during select-all', () => {
    const view = setup();
    expect(view.target.querySelector('table')).toBeNull();
    expect(view.target.querySelector('.collection--list')).not.toBeNull();
    view.check('Select Staff engineer');
    expect(view.selected()).toBe('opp-1');
    expect(view.target.querySelector('[role=dialog]')).toBeNull();
    view.check('Select all rows on this page');
    expect(view.selected()).toBe('opp-1,opp-2');
    view.component.replacePage([
      { id: 'opp-3', title: 'New filtered role' },
      { id: 'opp-4', title: 'Another role' },
    ]);
    flushSync();
    expect(view.target.textContent).not.toContain('Staff engineer');
    view.check('Select all rows on this page');
    expect(view.selected()).toBe('opp-1,opp-2,opp-3,opp-4');
    view.check('Select all rows on this page');
    expect(view.selected()).toBe('opp-1,opp-2');
    expect(view.target.textContent).toContain('New filtered role');
  });
  it('keeps checkbox separate from review and preserves page navigation', () => {
    const view = setup();
    view.check('Select Staff engineer');
    expect(view.target.querySelector('[role=dialog]')).toBeNull();
    view.target
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Review Staff engineer"]',
      )
      ?.click();
    flushSync();
    expect(view.target.querySelector('[role=dialog]')?.textContent).toContain(
      'Staff engineer',
    );
    view.target
      .querySelector<HTMLButtonElement>('button[aria-label="Next page"]')
      ?.click();
    flushSync();
    expect(navigation.goto).toHaveBeenCalledWith(
      '/admin/opportunities?review=unsorted&sort=newest&skill=Rust&page=2',
      { keepFocus: true, noScroll: true },
    );
  });
  it('keeps loaded cards selectable when a refresh error arrives', () => {
    const view = setup();
    view.component.showRefreshError();
    flushSync();

    expect(view.target.textContent).toContain(
      'Unable to refresh opportunities.',
    );
    expect(view.target.textContent).toContain('Staff engineer');
    view.check('Select Staff engineer');
    expect(view.selected()).toBe('opp-1');
  });
  it.each([
    ['score', 'asc'],
    ['salary', 'asc'],
  ])('writes %s ascending sort from the filter dialog', (sort, direction) => {
    page.url = new URL(
      'http://localhost/admin/opportunities?review=unsorted&sort=newest&skill=Rust&facets',
    );
    const view = setup();
    const sortSelect = view.target.querySelector<HTMLSelectElement>(
      'select[aria-label="Sort opportunities"]',
    );
    const directionSelect = view.target.querySelector<HTMLSelectElement>(
      'select[aria-label="Sort direction"]',
    );
    if (!sortSelect || !directionSelect)
      throw new Error('Missing sort controls');
    directionSelect.value = direction;
    directionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    sortSelect.value = sort;
    sortSelect.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(navigation.goto).toHaveBeenLastCalledWith(
      `/admin/opportunities?review=unsorted&facets=&skill=Rust&sort=${sort}&sortDirection=asc`,
      { keepFocus: true, noScroll: true },
    );
  });
});
