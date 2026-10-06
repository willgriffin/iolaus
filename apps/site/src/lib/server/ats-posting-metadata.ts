/** Primary ATS facts only: never infer an employer or eligible country from prose. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function uniqueAtsLocations(values: unknown[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))];
}

function addressLocation(value: unknown): string {
  const address = record(value);
  const postal = record(address.postalAddress ?? address);
  return uniqueAtsLocations([
    postal.addressLocality,
    postal.addressRegion,
    postal.addressCountry,
  ]).join(', ');
}

export function atsPostingLocations(value: unknown): string[] {
  const posting = record(value);
  const categories = record(posting.categories);
  return uniqueAtsLocations([
    posting.locationName,
    typeof posting.location === 'string'
      ? posting.location
      : record(posting.location).name,
    categories.location,
    ...array(categories.allLocations),
    ...array(posting.secondaryLocationNames),
    addressLocation(posting.locationAddress ?? posting.address),
    ...array(posting.secondaryLocations).flatMap((location) => {
      const item = record(location);
      return [item.location ?? item.name, addressLocation(item.address)];
    }),
    ...array(posting.offices).flatMap((office) => {
      const item = record(office);
      return [
        item.name,
        typeof item.location === 'string'
          ? item.location
          : addressLocation(item.location),
      ];
    }),
  ]);
}

export interface AtsCompensation {
  compNotes?: string;
  currency?: string;
  hourlyMax?: number | null;
  hourlyMin?: number | null;
  salaryMax?: number | null;
  salaryMin?: number | null;
}

export function ashbyApiCompensation(value: unknown): AtsCompensation {
  const compensation = record(value);
  const summary = text(
    compensation.scrapeableCompensationSalarySummary ??
      compensation.compensationTierSummary,
  );
  const components = array(compensation.summaryComponents).filter(
    (entry) => text(record(entry).compensationType) === 'Salary',
  );
  if (components.length === 1)
    return {
      ...atsStructuredCompensation(components[0]),
      compNotes: summary || atsStructuredCompensation(components[0]).compNotes,
    };
  if (components.length > 1)
    return {
      compNotes: summary,
      currency: '',
      salaryMin: null,
      salaryMax: null,
      hourlyMin: null,
      hourlyMax: null,
    };
  return atsTextCompensation(summary);
}

function positiveAmount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Unknown units do not become annual salaries; invalid/zero bounds stay null. */
export function atsStructuredCompensation(value: unknown): AtsCompensation {
  const source = record(value);
  const amount = record(source.value ?? source.Value ?? source);
  let min = positiveAmount(amount.minValue ?? amount.min ?? amount.value);
  let max = positiveAmount(amount.maxValue ?? amount.max ?? amount.value);
  if (min !== null && max !== null && min > max) min = max = null;
  const currency = text(source.currency ?? source.currencyCode).toUpperCase();
  const unit = text(amount.unitText ?? source.interval).toUpperCase();
  const compNotes = [
    min !== null || max !== null
      ? `Compensation: ${[min, max].filter((entry) => entry !== null).join(' - ')}`
      : '',
    currency,
    unit ? `/ ${unit}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const result: AtsCompensation = {
    compNotes,
    currency,
    salaryMin: null,
    salaryMax: null,
    hourlyMin: null,
    hourlyMax: null,
  };
  if (/^(?:HOUR|HOURLY|1 HOUR|PER-HOUR|PER-HOUR-WAGE)$/.test(unit)) {
    return { ...result, hourlyMin: min, hourlyMax: max };
  }
  if (
    /^(?:YEAR|ANNUAL|ANNUALLY|YEARLY|1 YEAR|PER-YEAR|PER-YEAR-SALARY)$/.test(
      unit,
    )
  ) {
    return { ...result, salaryMin: min, salaryMax: max };
  }
  return result;
}

/** Use only an explicit monetary range, never numbers from benefit prose. */
export function atsTextCompensation(summary: unknown): AtsCompensation {
  const compNotes = text(summary);
  if (!compNotes) return {};
  const result: AtsCompensation = { compNotes };
  const currencySymbols: Record<string, string> = {
    CA$: 'CAD',
    US$: 'USD',
    '£': 'GBP',
    '€': 'EUR',
  };
  const currencies = uniqueAtsLocations(
    [...compNotes.matchAll(/\b(?:USD|CAD|GBP|EUR)\b|CA\$|US\$|£|€/gi)].map(
      ([match]) => currencySymbols[match.toUpperCase()] ?? match.toUpperCase(),
    ),
  );
  if (currencies.length > 1) return result;
  result.currency = currencies[0] ?? '';
  // '$' alone does not establish USD. The range may be known while currency is not.
  const match = compNotes.match(
    /(?:\b(?:USD|CAD|GBP|EUR)\s*|(?:CA|US)?[$£€]\s*)(\d[\d,]*(?:\.\d+)?)(k)?\s*[-–—]\s*(?:(?:\b(?:USD|CAD|GBP|EUR)\s*)|(?:(?:CA|US)?[$£€]\s*))?(\d[\d,]*(?:\.\d+)?)(k)?\b/i,
  );
  if (!match) return result;
  const min = Number(match[1].replaceAll(',', '')) * (match[2] ? 1000 : 1);
  const max = Number(match[3].replaceAll(',', '')) * (match[4] ? 1000 : 1);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || min > max)
    return result;
  if (/\b(?:hour|hourly)\b|\/\s*(?:hr|hour)\b/i.test(compNotes)) {
    return { ...result, hourlyMin: min, hourlyMax: max };
  }
  if (/\b(?:month|monthly|week|weekly|day|daily)\b/i.test(compNotes))
    return result;
  // Ashby's dedicated salary summaries express annual salary unless another interval is stated.
  return { ...result, salaryMin: min, salaryMax: max };
}
