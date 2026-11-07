const DAY_MS = 86_400_000;
const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Use the latest possible start and earliest possible end for partial dates. */
function dateBound(raw: string, latest: boolean): number | undefined {
  const value = raw.trim();
  const named = /^([a-z]+)\.?\s+(\d{4})$/iu.exec(value);
  const monthNumber = named?.[1]
    ? months.findIndex(
        (month) =>
          month === named[1]?.toLowerCase() ||
          month.slice(0, 3) === named[1]?.toLowerCase(),
      ) + 1
    : 0;
  const iso = monthNumber
    ? `${named?.[2]}-${String(monthNumber).padStart(2, '0')}`
    : value;
  const parts = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(iso);
  if (!parts) return undefined;
  const year = Number(parts[1]);
  const month = Number(parts[2] ?? (latest ? 12 : 1));
  const day = Number(
    parts[3] ?? (latest ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 1),
  );
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1)
    return undefined;
  const time = Date.UTC(year, month - 1, day);
  if (new Date(time).getUTCMonth() !== month - 1) return undefined;
  // A date records the day, not its time of day. Round the start up.
  return latest ? time + DAY_MS : time;
}

export type ExperiencePeriod = readonly [start: number, end: number];

export function conservativeExperiencePeriod(
  from: string,
  until: string,
  asOf: number,
): ExperiencePeriod | undefined {
  const start = dateBound(from, true);
  const end = /^(?:present|current|ongoing)$/iu.test(until.trim())
    ? asOf
    : dateBound(until, false);
  if (start === undefined || end === undefined || start >= Math.min(end, asOf))
    return undefined;
  return [start, Math.min(end, asOf)];
}

/** Count overlapping jobs once. 366 days per year is a conservative lower bound. */
export function minimumExperienceYears(periods: readonly ExperiencePeriod[]) {
  const sorted = [...periods].sort(([startA], [startB]) => startA - startB);
  let through = 0;
  let days = 0;
  for (const [start, end] of sorted) {
    days += Math.max(0, end - Math.max(start, through)) / DAY_MS;
    through = Math.max(through, end);
  }
  return Math.floor(days / 366);
}
