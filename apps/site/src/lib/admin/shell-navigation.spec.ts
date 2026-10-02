import { describe, expect, it } from 'vitest';
import {
  navigationStateForViewport,
  readStoredNavigationState,
} from './shell-navigation';

describe('admin navigation responsive defaults', () => {
  it('starts collapsed below xl', () => {
    expect(navigationStateForViewport(false)).toBe('collapsed');
  });

  it('starts collapsed at xl', () => {
    expect(navigationStateForViewport(true)).toBe('collapsed');
  });

  it('starts collapsed above xl', () => {
    expect(navigationStateForViewport(true)).toBe('collapsed');
  });

  it('recognizes a persisted explicit panel choice', () => {
    expect(
      readStoredNavigationState(
        JSON.stringify({ panels: { left: 'expanded' } }),
      ),
    ).toBe('expanded');
    expect(
      readStoredNavigationState(
        JSON.stringify({ panels: { left: 'collapsed' } }),
      ),
    ).toBe('collapsed');
  });

  it('ignores invalid or unrelated persisted values', () => {
    expect(readStoredNavigationState(null)).toBeNull();
    expect(readStoredNavigationState('{not-json')).toBeNull();
    expect(
      readStoredNavigationState(
        JSON.stringify({ panels: { right: 'expanded' } }),
      ),
    ).toBeNull();
    expect(
      readStoredNavigationState(JSON.stringify({ panels: { left: 'hidden' } })),
    ).toBeNull();
  });
});
