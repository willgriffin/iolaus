import {
  type CountryReference,
  normalizeCountryReference,
  normalizeCountryReferences,
} from './country-reference.js';
import type {
  CandidateWorkAuthorization,
  CandidateWorkEligibility,
} from './opportunity-assessment.js';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Accept only an explicit ISO alpha-2 code paired with a human label. */
function country(value: unknown): CountryReference | undefined {
  return normalizeCountryReference(value);
}

function countries(value: unknown): CountryReference[] {
  return normalizeCountryReferences(value);
}

function authorizations(value: unknown): CandidateWorkAuthorization[] {
  const unique = new Map<string, CandidateWorkAuthorization>();
  for (const entry of Array.isArray(value) ? value : []) {
    const source = record(entry);
    const nextCountry = country(source?.country);
    const scope = text(source?.scope);
    if (
      !nextCountry ||
      !['country', 'employer_limited', 'conditional'].includes(scope)
    )
      continue;
    const condition = text(source?.condition).slice(0, 500);
    const next: CandidateWorkAuthorization = {
      ...(condition ? { condition } : {}),
      country: nextCountry,
      scope: scope as CandidateWorkAuthorization['scope'],
    };
    const key = `${next.country.code}:${next.scope}:${next.condition ?? ''}`;
    if (!unique.has(key)) unique.set(key, next);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.country.code.localeCompare(right.country.code) ||
      left.scope.localeCompare(right.scope) ||
      (left.condition ?? '').localeCompare(right.condition ?? ''),
  );
}

/**
 * Converts only the typed, private profile fields. Legacy free text remains
 * intentionally unused: it cannot safely establish residence, citizenship, or
 * an authorization scope.
 */
export function candidateWorkEligibilityFromProfile(
  profile: UnknownRecord,
): CandidateWorkEligibility {
  const sponsorship = profile.sponsorshipRequired;
  return {
    authorizedWorkCountries: authorizations(
      parse(profile.authorizedWorkCountriesJson),
    ),
    citizenships: countries(parse(profile.citizenshipsJson)),
    ...(country(parse(profile.residenceCountryJson))
      ? { residenceCountry: country(parse(profile.residenceCountryJson)) }
      : {}),
    sponsorshipRequired:
      sponsorship === true || sponsorship === false ? sponsorship : 'unknown',
    ...(country(parse(profile.targetWorkCountryJson))
      ? { targetWorkCountry: country(parse(profile.targetWorkCountryJson)) }
      : {}),
  };
}
