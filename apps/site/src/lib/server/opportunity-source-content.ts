import { createHash } from 'node:crypto';

export const OPPORTUNITY_SOURCE_CONTENT_FINGERPRINT_VERSION =
  'opportunity-source-content:v1';

export interface OpportunitySourceContent {
  canonicalUrl?: unknown;
  compNotes?: unknown;
  currency?: unknown;
  descriptionRaw?: unknown;
  employmentType?: unknown;
  equityMaxPercent?: unknown;
  equityMinPercent?: unknown;
  externalId?: unknown;
  hourlyMax?: unknown;
  hourlyMin?: unknown;
  locationNotes?: unknown;
  postedAt?: unknown;
  preferredSkills?: unknown;
  qualifications?: unknown;
  requiredSkills?: unknown;
  responsibilities?: unknown;
  salaryMax?: unknown;
  salaryMin?: unknown;
  title?: unknown;
  workMode?: unknown;
}

const opportunitySourceContentFields = [
  'canonicalUrl',
  'compNotes',
  'currency',
  'descriptionRaw',
  'employmentType',
  'equityMaxPercent',
  'equityMinPercent',
  'externalId',
  'hourlyMax',
  'hourlyMin',
  'locationNotes',
  'postedAt',
  'preferredSkills',
  'qualifications',
  'requiredSkills',
  'responsibilities',
  'salaryMax',
  'salaryMin',
  'title',
  'workMode',
] as const satisfies ReadonlyArray<keyof OpportunitySourceContent>;

export function parseOpportunitySourceContent(
  value: unknown,
): OpportunitySourceContent | null {
  let parsed = value;
  if (typeof value === 'string') {
    if (!value.trim() || value.trim() === '{}') return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return Object.fromEntries(
    opportunitySourceContentFields
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => [field, record[field]]),
  ) as OpportunitySourceContent;
}

export function opportunityWithSourceContent<T extends Record<string, unknown>>(
  opportunity: T,
): T & OpportunitySourceContent {
  const sourceContent = parseOpportunitySourceContent(
    opportunity.sourceContentJson,
  );
  return sourceContent
    ? { ...opportunity, id: opportunity.id, ...sourceContent }
    : opportunity;
}

function normalizedText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
      ? String(value)
      : '';
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizedDate(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export function fingerprintOpportunitySourceContent(
  content: OpportunitySourceContent,
): string {
  const payload = JSON.stringify({
    compNotes: normalizedText(content.compNotes),
    currency: normalizedText(content.currency),
    descriptionRaw: normalizedText(content.descriptionRaw),
    employmentType: normalizedText(content.employmentType),
    equityMaxPercent: normalizedText(content.equityMaxPercent),
    equityMinPercent: normalizedText(content.equityMinPercent),
    hourlyMax: normalizedText(content.hourlyMax),
    hourlyMin: normalizedText(content.hourlyMin),
    locationNotes: normalizedText(content.locationNotes),
    postedAt: normalizedDate(content.postedAt),
    preferredSkills: normalizedText(content.preferredSkills),
    qualifications: normalizedText(content.qualifications),
    requiredSkills: normalizedText(content.requiredSkills),
    responsibilities: normalizedText(content.responsibilities),
    salaryMax: normalizedText(content.salaryMax),
    salaryMin: normalizedText(content.salaryMin),
    schema: OPPORTUNITY_SOURCE_CONTENT_FINGERPRINT_VERSION,
    title: normalizedText(content.title),
    workMode: normalizedText(content.workMode),
  });
  return createHash('sha256').update(payload).digest('hex');
}
