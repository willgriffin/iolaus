import type { PublicOpportunity } from './public-opportunity-contract.js';

export function opportunityLabel(value: string): string {
  if (!value || value === 'unknown') return '';
  const label = value.replace(/[_-]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function postedCompensation(
  value: PublicOpportunity['compensation'],
): string {
  if (!value || value.source !== 'posted' || !/^[A-Z]{3}$/.test(value.currency))
    return '';
  const valid = (amount: number | null): amount is number =>
    amount !== null && Number.isFinite(amount) && amount >= 0;
  const format = (amount: number) =>
    new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(amount);
  let range = '';
  if (valid(value.min) && valid(value.max)) {
    if (value.max < value.min) return '';
    range =
      value.min === value.max
        ? format(value.min)
        : `${format(value.min)}–${format(value.max)}`;
  } else if (valid(value.min)) range = `From ${format(value.min)}`;
  else if (valid(value.max)) range = `Up to ${format(value.max)}`;
  if (!range) return '';
  const period = ['hour', 'day', 'week', 'month', 'year'].includes(value.period)
    ? ` / ${value.period}`
    : '';
  return `${value.currency} ${range}${period}`;
}

export function postingLink(
  value: string,
): { href: string; host: string } | null {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return { href: url.href, host: url.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

export function postedDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(date);
}
