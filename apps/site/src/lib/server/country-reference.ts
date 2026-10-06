/**
 * An explicit ISO alpha-2 code plus a display label.  This is deliberately a
 * data shape, not a geocoder: city, province and free-form location strings
 * cannot be converted into a country assertion.
 */
export interface CountryReference {
  code: string;
  label: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Uses the same platform country display data as onboarding.  Callers must
 * supply an ISO alpha-2 code; this function never guesses a country from a
 * city, province, or free-form address.
 */
export function countryReferenceFromCode(
  value: unknown,
): CountryReference | undefined {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  const label = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
  return label ? { code, label } : undefined;
}

/** Accept only an explicit code/label pair already stored as typed data. */
export function normalizeCountryReference(
  value: unknown,
): CountryReference | undefined {
  const source = record(value);
  const code = text(source?.code).toUpperCase();
  const label = text(source?.label);
  if (!/^[A-Z]{2}$/.test(code) || !label || label.length > 120)
    return undefined;
  return { code, label };
}

export function normalizeCountryReferences(value: unknown): CountryReference[] {
  const unique = new Map<string, CountryReference>();
  for (const entry of Array.isArray(value) ? value : []) {
    const next = normalizeCountryReference(entry);
    if (next && !unique.has(next.code)) unique.set(next.code, next);
  }
  return [...unique.values()].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
}

/** ISO 3166-1 catalog from the public-domain IANA iso3166.tab (2025-07-01). */
export const onboardingCountryCodes = new Set(
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  ),
);

/** Deterministic country choices; saved explicit codes remain visible. */
export function onboardingCountryOptions(savedCodes: string[] = []) {
  const codes = new Set([...onboardingCountryCodes, ...savedCodes]);
  return [...codes]
    .map((code) => countryReferenceFromCode(code))
    .filter((country): country is CountryReference => Boolean(country))
    .map(({ code, label }) => ({ value: code, label }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.value.localeCompare(right.value),
    );
}
