import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SEARCH_DISCOVERY_PREFERENCES,
  loadSearchDiscoveryPreferences,
  SEARCH_DISCOVERY_PREFERENCES_KEY,
  saveSearchDiscoveryPreferences,
  searchDiscoveryBrowserStorage,
} from './search-discovery-preferences.js';

describe('search discovery preferences', () => {
  it('round-trips versioned category, manual skills, exclusions, and location choice', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(
      saveSearchDiscoveryPreferences(storage, {
        category: 'technology',
        skills: ['typescript'],
        excludedDerivedSkills: ['python'],
        location: 'Edmonton, AB',
        locationChosen: true,
      }),
    ).toBe(true);
    expect(loadSearchDiscoveryPreferences(storage)).toEqual({
      category: 'technology',
      skills: ['typescript'],
      excludedDerivedSkills: ['python'],
      location: 'Edmonton, AB',
      locationChosen: true,
    });
  });

  it('treats a legacy nonempty location as chosen but allows an empty location to auto-detect', () => {
    const stored = (value: unknown) => ({
      getItem: () => JSON.stringify(value),
    });
    expect(
      loadSearchDiscoveryPreferences(
        stored({ version: 1, location: 'Calgary, AB' }),
      ).locationChosen,
    ).toBe(true);
    expect(
      loadSearchDiscoveryPreferences(stored({ version: 1, location: '' }))
        .locationChosen,
    ).toBe(false);
  });

  it.each([
    null,
    '{',
    JSON.stringify({ version: 2, category: 'technology' }),
    JSON.stringify({ version: 1, skills: 'typescript' }),
  ])('falls back safely for unavailable or malformed stored data', (raw) => {
    const storage = { getItem: vi.fn(() => raw) };
    expect(loadSearchDiscoveryPreferences(storage)).toEqual(
      DEFAULT_SEARCH_DISCOVERY_PREFERENCES,
    );
  });

  it('does not throw when storage reads or writes are blocked', () => {
    expect(
      loadSearchDiscoveryPreferences({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toEqual(DEFAULT_SEARCH_DISCOVERY_PREFERENCES);
    expect(
      saveSearchDiscoveryPreferences(
        {
          setItem: () => {
            throw new Error('blocked');
          },
        },
        DEFAULT_SEARCH_DISCOVERY_PREFERENCES,
      ),
    ).toBe(false);
    expect(SEARCH_DISCOVERY_PREFERENCES_KEY).toContain('.v1');
  });

  it('guards a browser storage property getter that is denied', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get localStorage(): never {
          throw new Error('denied');
        },
      },
    });
    expect(searchDiscoveryBrowserStorage()).toBeNull();
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
});
