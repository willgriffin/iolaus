// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => navigation);
vi.mock('$app/state', () => ({
  page: {
    url: new URL(
      'http://localhost/admin/opportunities?review=unsorted&sort=newest&skill=Rust',
    ),
  },
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
const KEY = 'iolaus.admin.opportunities.view.v1';
describe('Opportunity list view interaction', () => {
  it('defaults to Table and switches the same page through List, Columns, Table without a query', () => {
    const view = setup();
    expect(view.button('Table').getAttribute('aria-pressed')).toBe('true');
    for (const label of ['List', 'Columns', 'Table']) {
      view.switchTo(label);
      expect(view.target.textContent).toContain('Staff engineer');
      expect(view.target.textContent).toContain('Platform lead');
      expect(view.target.querySelectorAll('[aria-pressed=true]')).toHaveLength(
        1,
      );
      expect(view.button(label).getAttribute('aria-pressed')).toBe('true');
      if (label === 'Table')
        expect(view.target.querySelector('table')).not.toBeNull();
      else
        expect(
          view.target.querySelector(
            label === 'Columns' ? '.collection--grid' : '.collection--list',
          ),
        ).not.toBeNull();
      view.switchTo(label);
      expect(view.button(label).getAttribute('aria-pressed')).toBe('true');
    }
    expect(navigation.goto).not.toHaveBeenCalled();
  });
  it('restores a persisted view and rejects an invalid preference', () => {
    window.localStorage.setItem(KEY, 'columns');
    let view = setup();
    expect(view.button('Columns').getAttribute('aria-pressed')).toBe('true');
    view.switchTo('List');
    expect(window.localStorage.getItem(KEY)).toBe('list');
    cleanup?.();
    document.body.replaceChildren();
    view = setup();
    expect(view.button('List').getAttribute('aria-pressed')).toBe('true');
    cleanup?.();
    document.body.replaceChildren();
    window.localStorage.setItem(KEY, 'kanban');
    view = setup();
    expect(view.button('Table').getAttribute('aria-pressed')).toBe('true');
  });
  it('switches when browser storage is unavailable', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const view = setup();
    view.switchTo('Columns');
    expect(view.button('Columns').getAttribute('aria-pressed')).toBe('true');
  });
  it('shares native row selection across modes and preserves off-page IDs during select-all', () => {
    const view = setup();
    view.switchTo('List');
    view.check('Select Staff engineer');
    expect(view.selected()).toBe('opp-1');
    expect(view.target.querySelector('[role=dialog]')).toBeNull();
    view.switchTo('Table');
    expect(
      view.target.querySelector<HTMLInputElement>(
        'input[aria-label="Deselect Staff engineer"]',
      )?.checked,
    ).toBe(true);
    view.switchTo('Columns');
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
    view.switchTo('List');
    expect(view.target.textContent).toContain('New filtered role');
    view.switchTo('Table');
    expect(view.target.textContent).toContain('New filtered role');
  });
  it.each([
    'List',
    'Columns',
  ])('%s keeps checkbox separate from the existing review modal and preserves page/filter navigation', (label) => {
    const view = setup();
    view.switchTo(label);
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
});
