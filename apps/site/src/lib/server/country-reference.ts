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
