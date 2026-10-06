import {
  type CountryReference,
  countryReferenceFromCode,
  normalizeCountryReference,
  normalizeCountryReferences,
  onboardingCountryCodes,
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

export type WorkRightAnswer = 'yes' | 'no' | 'unknown';
export type BasicWorkMode = 'remote' | 'hybrid' | 'onsite' | 'any' | 'unknown';
export interface BasicWorkEligibilityAnswers {
  citizenshipCountryCodes: string[];
  citizenshipWorkAuthorization: WorkRightAnswer;
  canWorkElsewhere: WorkRightAnswer;
  otherAuthorizedCountryCodes: string[];
  workModeChoice: BasicWorkMode;
}

function preferences(profile: UnknownRecord): UnknownRecord {
  return record(parse(profile.preferencesJson)) ?? {};
}

function answer(value: unknown): WorkRightAnswer | undefined {
  return value === 'yes' || value === 'no' || value === 'unknown'
    ? value
    : undefined;
}

/** Prefill only from saved confirmations or explicit unrestricted typed rights. */
export function projectBasicWorkEligibility(profile: UnknownRecord) {
  const eligibility = candidateWorkEligibilityFromProfile(profile);
  const saved = preferences(profile);
  const citizenshipCountryCodes = eligibility.citizenships.map(
    ({ code }) => code,
  );
  const unrestricted = eligibility.authorizedWorkCountries.filter(
    (entry) => entry.scope === 'country' && !entry.condition,
  );
  const otherCodes = unrestricted
    .filter((entry) => !citizenshipCountryCodes.includes(entry.country.code))
    .map((entry) => entry.country.code);
  const citizenshipWorkAuthorization =
    answer(saved.citizenshipWorkAuthorization) ??
    (citizenshipCountryCodes.length &&
    citizenshipCountryCodes.every((code) =>
      unrestricted.some((entry) => entry.country.code === code),
    )
      ? 'yes'
      : 'unknown');
  const canWorkElsewhere =
    answer(saved.canWorkElsewhere) ?? (otherCodes.length ? 'yes' : 'unknown');
  const savedMode = saved.workModeChoice;
  const modes = Array.isArray(saved.workModes) ? saved.workModes : [];
  const workModeChoice: BasicWorkMode = [
    'remote',
    'hybrid',
    'onsite',
    'any',
    'unknown',
  ].includes(String(savedMode))
    ? (savedMode as BasicWorkMode)
    : modes.length === 1 &&
        ['remote', 'hybrid', 'onsite'].includes(String(modes[0]))
      ? (modes[0] as BasicWorkMode)
      : 'unknown';
  const savedOthers = Array.isArray(saved.otherAuthorizedCountryCodes)
    ? saved.otherAuthorizedCountryCodes.filter(
        (value): value is string => typeof value === 'string',
      )
    : otherCodes;
  return {
    citizenshipCountryCodes,
    citizenshipWorkAuthorization,
    canWorkElsewhere,
    otherAuthorizedCountryCodes: savedOthers,
    workModeChoice,
    conflicts: [
      ...(citizenshipWorkAuthorization === 'yes' &&
      eligibility.authorizedWorkCountries.some(
        (entry) =>
          citizenshipCountryCodes.includes(entry.country.code) &&
          (entry.scope !== 'country' || Boolean(entry.condition)),
      )
        ? [
            'Existing conditional or employer-limited rights remain scoped. Review their details before relying on unrestricted work authorization.',
          ]
        : []),
      ...(citizenshipWorkAuthorization === 'no' &&
      unrestricted.some((entry) =>
        citizenshipCountryCodes.includes(entry.country.code),
      )
        ? [
            'Existing unrestricted work rights conflict with No for citizenship countries. Clarify them in advanced details.',
          ]
        : []),
      ...(canWorkElsewhere === 'no' && otherCodes.length
        ? [
            'Existing unrestricted work rights outside citizenship countries conflict with No. Clarify them in advanced details.',
          ]
        : []),
    ],
  };
}

function selectedCountries(values: string[], existingCodes: string[]) {
  if (values.length > 249) throw new Error('Select at most 249 countries.');
  return normalizeCountryReferences(
    values.map((value) => {
      const code = value.trim().toUpperCase();
      if (!onboardingCountryCodes.has(code) && !existingCodes.includes(code))
        throw new Error('Select a valid country from the country list.');
      return countryReferenceFromCode(code);
    }),
  );
}

/** Basic confirmations add explicit rights; citizenship alone grants nothing. */
export function applyBasicWorkEligibility(
  profile: UnknownRecord,
  input: BasicWorkEligibilityAnswers,
  advanced: { authorizedWorkCountries?: string[] } = {},
) {
  if (
    !answer(input.citizenshipWorkAuthorization) ||
    !answer(input.canWorkElsewhere) ||
    !['remote', 'hybrid', 'onsite', 'any', 'unknown'].includes(
      input.workModeChoice,
    )
  )
    throw new Error('Choose a supported work-right answer.');
  const existing = candidateWorkEligibilityFromProfile(profile);
  const existingCodes = [
    ...existing.citizenships.map(({ code }) => code),
    ...existing.authorizedWorkCountries.map((entry) => entry.country.code),
  ];
  const citizenships = selectedCountries(
    input.citizenshipCountryCodes,
    existingCodes,
  );
  const others = selectedCountries(
    input.otherAuthorizedCountryCodes,
    existingCodes,
  );
  if (input.citizenshipWorkAuthorization === 'yes' && !citizenships.length)
    throw new Error(
      'Select your citizenship countries before confirming work rights.',
    );
  if (input.canWorkElsewhere === 'yes' && !others.length)
    throw new Error('Select the other countries where you have work rights.');
  if (
    others.some(({ code }) =>
      citizenships.some((country) => country.code === code),
    )
  )
    throw new Error(
      'Other work-right countries must be outside your citizenship countries.',
    );
  let rows = existing.authorizedWorkCountries;
  if (advanced.authorizedWorkCountries !== undefined) {
    const advancedCountries = selectedCountries(
      advanced.authorizedWorkCountries,
      existingCodes,
    );
    rows = [
      ...rows.filter(
        (entry) => entry.scope !== 'country' || Boolean(entry.condition),
      ),
      ...advancedCountries
        .filter(
          (country) =>
            !rows.some(
              (entry) =>
                entry.country.code === country.code &&
                (entry.scope !== 'country' || Boolean(entry.condition)),
            ),
        )
        .map(
          (country): CandidateWorkAuthorization => ({
            country,
            scope: 'country',
          }),
        ),
    ];
  }
  const unrestricted = rows.filter(
    (entry) => entry.scope === 'country' && !entry.condition,
  );
  if (
    input.citizenshipWorkAuthorization === 'no' &&
    unrestricted.some((entry) =>
      citizenships.some(({ code }) => code === entry.country.code),
    )
  )
    throw new Error(
      'No conflicts with saved unrestricted work rights in your citizenship countries. Update those rights in advanced details or change your answer.',
    );
  if (
    input.canWorkElsewhere === 'no' &&
    unrestricted.some(
      (entry) => !citizenships.some(({ code }) => code === entry.country.code),
    )
  )
    throw new Error(
      'No conflicts with saved unrestricted work rights outside your citizenship countries. Update those rights in advanced details or change your answer.',
    );
  const added = [
    ...(input.citizenshipWorkAuthorization === 'yes' ? citizenships : []),
    ...(input.canWorkElsewhere === 'yes' ? others : []),
  ].filter(
    (country) => !rows.some((entry) => entry.country.code === country.code),
  );
  const nextPreferences: UnknownRecord = {
    ...preferences(profile),
    citizenshipWorkAuthorization: input.citizenshipWorkAuthorization,
    canWorkElsewhere: input.canWorkElsewhere,
    otherAuthorizedCountryCodes:
      input.canWorkElsewhere !== 'yes' &&
      !others.length &&
      Array.isArray(preferences(profile).otherAuthorizedCountryCodes)
        ? preferences(profile).otherAuthorizedCountryCodes
        : others.map(({ code }) => code),
    workModeChoice: input.workModeChoice,
  };
  if (input.workModeChoice === 'any') delete nextPreferences.workModes;
  else if (input.workModeChoice !== 'unknown')
    nextPreferences.workModes = [input.workModeChoice];
  const changedRights =
    advanced.authorizedWorkCountries !== undefined || added.length > 0;
  return {
    authorizedWorkCountriesJson: changedRights
      ? JSON.stringify([
          ...rows,
          ...added.map((country) => ({ country, scope: 'country' })),
        ])
      : String(profile.authorizedWorkCountriesJson ?? '[]'),
    citizenshipsJson: JSON.stringify(citizenships),
    preferences: nextPreferences,
    workAuthorization:
      input.citizenshipWorkAuthorization === 'unknown' &&
      input.canWorkElsewhere === 'unknown'
        ? undefined
        : [
            `Work rights in citizenship countries (${citizenships.map(({ code }) => code).join(', ') || 'not specified'}): ${input.citizenshipWorkAuthorization}.`,
            `Work rights in other countries${input.canWorkElsewhere === 'yes' ? ` (${others.map(({ code }) => code).join(', ')})` : ''}: ${input.canWorkElsewhere}.`,
          ].join(' '),
  };
}
