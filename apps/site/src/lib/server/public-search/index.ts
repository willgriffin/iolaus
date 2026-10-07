import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  type PublicFacets,
  type PublicOpportunityDetail,
  type PublicSearchInput,
  type PublicSearchPage,
  publicOpportunityDetailSchema,
  publicOpportunitySchema,
  publicSearchInputSchema,
  publicSearchPageSchema,
} from '$lib/public-opportunity-contract.js';
import {
  applicationRuntime,
  hostedDatabasePoolMax,
} from '../application-runtime.js';
import { getDbConfig } from '../db.js';

export { matchPublicSkills } from './match.js';

type Row = Record<string, unknown>;
type Database = {
  query(
    statement: string,
    ...values: unknown[]
  ): Promise<{ rows?: Row[] } | Row[]>;
};
const EMPTY_FACETS: PublicFacets = {
  skills: [],
  seniority: [],
  function: [],
  workMode: [],
  employmentType: [],
  country: [],
};

function rows(value: { rows?: Row[] } | Row[]): Row[] {
  return Array.isArray(value) ? value : (value.rows ?? []);
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function jsonArray(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 30)
      : [];
  } catch {
    return [];
  }
}
function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function safeUrl(value: unknown): string | null {
  try {
    const url = new URL(string(value));
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function date(value: unknown): string | null {
  const parsed = new Date(string(value));
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}
function opportunity(row: Row, detail = false) {
  const compensation = jsonObject(row.compensation_json);
  const source = string(compensation.source);
  const originalUrl =
    safeUrl(row.posting_url) ??
    safeUrl(row.canonical_url) ??
    safeUrl(row.apply_url);
  const value = {
    id: string(row.id),
    title: string(row.normalized_title) || string(row.title),
    company: string(row.company_name) || 'Unknown company',
    locations: jsonArray(row.locations_json).length
      ? jsonArray(row.locations_json)
      : string(row.locations)
          .split(/[\n,]/u)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 10),
    workMode: string(row.work_mode) || 'unknown',
    employmentType: string(row.employment_type) || 'unknown',
    seniority: string(row.seniority) || 'unknown',
    function: string(row.function) || 'unknown',
    skills: jsonArray(row.skill_slugs_json),
    summary: jsonArray(jsonObject(row.summary_json).bullets),
    compensation:
      source === 'posted'
        ? {
            currency: string(compensation.currency) || undefined,
            min:
              typeof compensation.min === 'number'
                ? compensation.min
                : undefined,
            max:
              typeof compensation.max === 'number'
                ? compensation.max
                : undefined,
            period: string(compensation.period) || undefined,
          }
        : undefined,
    postedAt: date(row.posted_at),
    originalUrl: originalUrl ?? 'https://invalid.example/',
  };
  if (!originalUrl) return null;
  return detail
    ? (publicOpportunityDetailSchema.safeParse({
        ...value,
        countries: jsonArray(row.countries_json),
      }).data ?? null)
    : (publicOpportunitySchema.safeParse(value).data ?? null);
}
function secret(): string {
  return (
    process.env.IOLAUS_PUBLIC_CURSOR_SECRET ||
    'local-public-search-cursor-secret'
  );
}
function encodeCursor(value: Row): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', secret())
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}
function decodeCursor(cursor: string | undefined): Row | null {
  if (!cursor) return null;
  const [body, signature] = cursor.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', secret())
    .update(body)
    .digest('base64url');
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Row;
  } catch {
    return null;
  }
}
/** Anonymous traffic is deliberately isolated from the catalog writer role. */
async function db(): Promise<Database> {
  if (applicationRuntime.profile === 'local')
    return (await resolveDatabase(getDbConfig())) as unknown as Database;
  const url = process.env.IOLAUS_PUBLIC_READ_DATABASE_URL;
  const configuredMax = Number(
    process.env.IOLAUS_PUBLIC_READ_MAX_CONNECTIONS ?? 5,
  );
  if (
    process.env.IOLAUS_PUBLIC_SEARCH_ENABLED !== 'true' ||
    !url ||
    !Number.isInteger(configuredMax) ||
    configuredMax < 1
  )
    throw new Error(
      'Public search is unavailable until its isolated read connection is configured.',
    );
  return (await resolveDatabase({
    type: 'postgres',
    url,
    max: Math.min(hostedDatabasePoolMax(), configuredMax, 5),
  })) as unknown as Database;
}
function where(input: PublicSearchInput, values: unknown[]): string {
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const predicates = ['1 = 1'];
  if (input.q) {
    const term = `%${input.q.replace(/[\\%_]/gu, '\\$&')}%`;
    predicates.push(
      `(lower(coalesce(normalized_title, title)) LIKE lower(${add(term)}) OR lower(coalesce(company_name, '')) LIKE lower(${add(term)}) OR lower(coalesce(skill_slugs_json, '')) LIKE lower(${add(term)}))`,
    );
  }
  if (input.company)
    predicates.push(
      `lower(coalesce(company_name, '')) LIKE lower(${add(`%${input.company.replace(/[\\%_]/gu, '\\$&')}%`)})`,
    );
  for (const [column, valuesFor] of [
    ['seniority', input.seniority],
    ['function', input.function],
    ['work_mode', input.workMode],
    ['employment_type', input.employmentType],
  ] as const)
    if (valuesFor.length)
      predicates.push(`${column} IN (${valuesFor.map(add).join(', ')})`);
  if (input.skills.length)
    predicates.push(
      `(${input.skills.map((skill) => `skill_slugs_json LIKE ${add(`%"${skill}"%`)}`).join(' OR ')})`,
    );
  if (input.country.length)
    predicates.push(
      `(${input.country.map((country) => `countries_json LIKE ${add(`%"${country}"%`)}`).join(' OR ')})`,
    );
  if (input.postedSince)
    predicates.push(`posted_at >= ${add(input.postedSince.toISOString())}`);
  if (input.salaryMin !== undefined)
    predicates.push(
      `coalesce(compensation_max, compensation_min, 0) >= ${add(input.salaryMin)}`,
    );
  return predicates.join(' AND ');
}
/** Security-barrier view is the only production anonymous database grant. */
const SELECT = `SELECT id, title, locations, posting_url, canonical_url, apply_url, posted_at, company_name, normalized_title, seniority, function, work_mode, employment_type, skill_slugs_json, summary_json, compensation_json, countries_json, compensation_min, compensation_max FROM public.jobgeni_public_catalog_v1`;

export async function searchPublicOpportunities(
  raw: PublicSearchInput,
): Promise<PublicSearchPage> {
  const input = publicSearchInputSchema.parse(raw);
  const values: unknown[] = [];
  const predicate = where(input, values);
  const cursor = decodeCursor(input.cursor);
  if (cursor?.postedAt) {
    values.push(cursor.postedAt, cursor.id);
  }
  const cursorClause = cursor?.postedAt
    ? ` AND (coalesce(posted_at, '1970-01-01') < $${values.length - 1} OR (coalesce(posted_at, '1970-01-01') = $${values.length - 1} AND id < $${values.length}))`
    : '';
  values.push(input.limit + 1);
  const result = rows(
    await (await db()).query(
      `${SELECT} WHERE ${predicate}${cursorClause} ORDER BY coalesce(posted_at, '1970-01-01') DESC, id DESC LIMIT $${values.length}`,
      ...values,
    ),
  )
    .map((row) => opportunity(row))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const hasNext = result.length > input.limit;
  const items = result.slice(0, input.limit);
  const tail = items.at(-1);
  return publicSearchPageSchema.parse({
    items,
    nextCursor:
      hasNext && tail
        ? encodeCursor({ id: tail.id, postedAt: tail.postedAt ?? '1970-01-01' })
        : null,
    facets: EMPTY_FACETS,
  });
}
export async function getPublicOpportunity(
  id: string,
): Promise<PublicOpportunityDetail | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) return null;
  const result = rows(
    await (await db()).query(`${SELECT} WHERE id = $1 LIMIT 1`, id),
  )[0];
  return result
    ? (opportunity(result, true) as PublicOpportunityDetail | null)
    : null;
}
export async function listPublicFacets(
  raw: PublicSearchInput,
): Promise<PublicFacets> {
  publicSearchInputSchema.parse(raw);
  return EMPTY_FACETS;
}
