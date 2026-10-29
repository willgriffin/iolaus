/**
 * Date display for the public résumé.  Snapshot dates are short strings the
 * owner typed (`YYYY-MM`, `YYYY`, or words such as "Present"); both renderers
 * show them the same way so the page and the PDF read alike.
 */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `2024-12` → `Dec 2024`; `2008` → `2008`; anything else is returned as typed. */
export function formatPublicProfileDate(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  const match = /^(\d{4})(?:-(\d{2}))?(?:-\d{2})?$/u.exec(trimmed);
  if (!match) return trimmed;
  const month = match[2] ? Number(match[2]) : 0;
  const name = month >= 1 && month <= 12 ? MONTHS[month - 1] : undefined;
  return name ? `${name} ${match[1]}` : match[1];
}

/** `Dec 2024 – Present`, or a single date when only one side is present. */
export function formatPublicProfileDateRange(
  start: string | undefined,
  end: string | undefined,
): string {
  return [formatPublicProfileDate(start), formatPublicProfileDate(end)]
    .filter(Boolean)
    .join(' – ');
}
