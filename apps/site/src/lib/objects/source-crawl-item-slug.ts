import { randomUUID } from 'node:crypto';

function slugifyPart(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compactParts(values: unknown[]): string[] {
  return values.map(slugifyPart).filter(Boolean);
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stableSuffix(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function trimSlug(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value;

  const suffix = stableSuffix(value);
  const prefixLength = Math.max(1, maxLength - suffix.length - 1);
  const prefix = value.slice(0, prefixLength).replace(/-+$/g, '');
  return `${prefix}-${suffix}`;
}

function rawJsonIdentity(value: unknown): string {
  const rawJson = nonEmptyString(value);
  if (!rawJson || rawJson === '{}' || rawJson === '[]' || rawJson === 'null')
    return '';
  return `raw-${stableSuffix(rawJson)}`;
}

export function normalizeSourceCrawlItemOptions<
  T extends Record<string, unknown>,
>(input: T): T & { slug?: string } {
  if (typeof input.slug === 'string' && input.slug.trim()) return input;

  const identityParts = compactParts([
    input.externalId,
    input.reconciliationKey,
    input.opportunityId,
    input.id,
    input.canonicalUrl,
    input.postingUrl,
    rawJsonIdentity(input.rawJson),
  ]);
  const parts = compactParts([
    input.title,
    input.companyName,
    input.sourceCrawlId,
    ...identityParts,
  ]);

  if (!parts.length) return input;

  return {
    ...input,
    slug: trimSlug(
      [...parts, identityParts.length ? '' : randomUUID()]
        .filter(Boolean)
        .join('-'),
    ),
  };
}
