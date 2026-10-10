export const SEARCH_DISCOVERY_PREFERENCES_KEY =
  'iolaus.search-discovery-preferences.v1';

const VERSION = 1;
const MAX_SKILLS = 50;
const MAX_LOCATION_LENGTH = 120;
const MAX_CATEGORY_LENGTH = 80;

export type SearchDiscoveryPreferences = {
  category: string;
  skills: string[];
  excludedDerivedSkills: string[];
  location: string;
  locationChosen: boolean;
};

type StoredPreferences = SearchDiscoveryPreferences & { version: number };

export const DEFAULT_SEARCH_DISCOVERY_PREFERENCES: SearchDiscoveryPreferences =
  {
    category: '',
    skills: [],
    excludedDerivedSkills: [],
    location: '',
    locationChosen: false,
  };

/** Access browser storage only after guarding privacy-mode property getters. */
export function searchDiscoveryBrowserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function cleanSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((skill) => cleanText(skill, MAX_CATEGORY_LENGTH))
        .filter(Boolean),
    ),
  ].slice(0, MAX_SKILLS);
}

function normalize(value: unknown): SearchDiscoveryPreferences {
  if (!value || typeof value !== 'object')
    return { ...DEFAULT_SEARCH_DISCOVERY_PREFERENCES };
  const stored = value as Partial<StoredPreferences>;
  if (stored.version !== VERSION)
    return { ...DEFAULT_SEARCH_DISCOVERY_PREFERENCES };
  return {
    category: cleanText(stored.category, MAX_CATEGORY_LENGTH),
    skills: cleanSkills(stored.skills),
    excludedDerivedSkills: cleanSkills(stored.excludedDerivedSkills),
    location: cleanText(stored.location, MAX_LOCATION_LENGTH),
    // Existing v1 payloads with a saved place predate the explicit Anywhere
    // choice, so treat that place as intentionally chosen on migration.
    locationChosen:
      stored.locationChosen === true ||
      (stored.locationChosen === undefined &&
        Boolean(cleanText(stored.location, MAX_LOCATION_LENGTH))),
  };
}

/** Read browser-only search preferences without making storage availability a UI dependency. */
export function loadSearchDiscoveryPreferences(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): SearchDiscoveryPreferences {
  try {
    const raw = storage?.getItem(SEARCH_DISCOVERY_PREFERENCES_KEY);
    return raw
      ? normalize(JSON.parse(raw))
      : { ...DEFAULT_SEARCH_DISCOVERY_PREFERENCES };
  } catch {
    return { ...DEFAULT_SEARCH_DISCOVERY_PREFERENCES };
  }
}

/** Returns false when private-mode or quota-restricted storage cannot be written. */
export function saveSearchDiscoveryPreferences(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  preferences: SearchDiscoveryPreferences,
): boolean {
  try {
    const value: StoredPreferences = {
      version: VERSION,
      ...normalize({ version: VERSION, ...preferences }),
    };
    storage?.setItem(SEARCH_DISCOVERY_PREFERENCES_KEY, JSON.stringify(value));
    return Boolean(storage);
  } catch {
    return false;
  }
}
