import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  type PublicFacets,
  type PublicOpportunity,
  type PublicOpportunityDetail,
  type PublicSearchInput,
  type PublicSearchPage,
  publicMatchInputSchema,
  publicMatchResultSchema,
  publicOpportunityDetailSchema,
  publicOpportunitySchema,
  publicSearchInputSchema,
  publicSearchPageSchema,
} from '$lib/public-opportunity-contract.js';
import {
  canonicalSkillSlug,
  SKILL_CANONICAL_ALIASES,
} from '../../skill-canonical.js';
import {
  applicationRuntime,
  hostedDatabasePoolMax,
} from '../application-runtime.js';
import { getDbConfig } from '../db.js';
import { sanitizePublicOpportunityText } from './content.js';
import { matchPublicSkills as matchSkills } from './match.js';
export type Row = Record<string, unknown>;
export type PublicDatabase = {
  query(
    statement: string,
    ...values: unknown[]
  ): Promise<{ rows?: Row[] } | Row[]>;
};
const listColumns = [
  'id',
  'company_id',
  'company_name',
  'posting_url',
  'canonical_url',
  'apply_url',
  'title',
  'normalized_title',
  'locations',
  'posted_at',
  'expires_at',
  'updated_at',
  'analysis_version',
  'source_content_version',
  'seniority',
  'function',
  'employment_type',
  'work_mode',
  'skills_json',
  'eligibility_json',
  'compensation_json',
  'countries_json',
].join(',');
export class PublicSearchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const rows = (r: { rows?: Row[] } | Row[]) =>
  Array.isArray(r) ? r : (r.rows ?? []);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
function object(v: unknown): Row {
  try {
    const p = typeof v === 'string' ? JSON.parse(v) : v;
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}
function array(v: unknown): unknown[] {
  try {
    const p = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
const strings = (v: unknown) =>
  array(v).filter((x): x is string => typeof x === 'string');
function date(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v instanceof Date ? v : text(v));
  return Number.isNaN(+d) ? null : d.toISOString();
}
export function projectPublicOpportunity(
  row: Row,
  detail: true,
): PublicOpportunityDetail | null;
export function projectPublicOpportunity(
  row: Row,
  detail?: false,
): PublicOpportunity | null;
export function projectPublicOpportunity(row: Row, detail = false) {
  const eligibility = object(row.eligibility_json);
  const salary = object(row.compensation_json);
  const summary = strings(row.summary_json);
  const skills = array(row.skills_json).map(object);
  const skill = (s: Row) => ({
    slug: text(s.slug),
    label: text(s.label) || text(s.slug),
  });
  let url: URL;
  try {
    url = new URL(
      text(row.posting_url) || text(row.canonical_url) || text(row.apply_url),
    );
    if (!['https:', 'http:'].includes(url.protocol)) return null;
  } catch {
    return null;
  }
  const companyName = text(row.company_name);
  const value = {
    id: text(row.id),
    title: text(row.title) || text(row.normalized_title),
    normalized_title: text(row.normalized_title),
    company: companyName
      ? {
          id: text(row.company_id),
          name: companyName,
          slug: text(row.company_id),
        }
      : null,
    location: {
      text: text(row.locations),
      countries: strings(row.countries_json),
      remote:
        typeof eligibility.remote === 'boolean' ? eligibility.remote : null,
      timezones: strings(eligibility.timezones),
    },
    seniority: text(row.seniority) || 'unknown',
    function: text(row.function),
    employment_type: text(row.employment_type),
    work_mode: text(row.work_mode),
    skills: {
      required: skills.filter((s) => s.kind === 'required').map(skill),
      preferred: skills.filter((s) => s.kind === 'preferred').map(skill),
      mentioned: skills.filter((s) => s.kind === 'mentioned').map(skill),
    },
    compensation:
      salary.source === 'posted'
        ? {
            currency: text(salary.currency),
            min: typeof salary.min === 'number' ? salary.min : null,
            max: typeof salary.max === 'number' ? salary.max : null,
            period: text(salary.period),
            equity: typeof salary.equity === 'boolean' ? salary.equity : null,
            source: 'posted',
          }
        : null,
    posted_at: date(row.posted_at),
    updated_at: date(row.updated_at) || '',
    expires_at: date(row.expires_at),
    analysis_version: text(row.analysis_version),
    source_content_version: Number(row.source_content_version) || 0,
    posting_url: url.href,
    url: `/opportunities/${encodeURIComponent(text(row.id))}`,
  };
  if (!detail) return publicOpportunitySchema.safeParse(value).data ?? null;
  const auth = object(eligibility.workAuthorization);
  return (
    publicOpportunityDetailSchema.safeParse({
      ...value,
      description_text: sanitizePublicOpportunityText(
        row.description_text,
        30_000,
      ),
      qualifications_text: sanitizePublicOpportunityText(
        row.qualifications_text,
        12_000,
      ),
      summary_bullets: summary.slice(0, 5),
      requirements: array(row.requirements_json).map((r) => {
        const s = object(r);
        return {
          hash: text(s.hash),
          text: text(s.text),
          kind: s.kind,
          category: text(s.category),
          years: typeof s.years === 'number' ? s.years : undefined,
          skills: strings(s.skills),
        };
      }),
      eligibility: {
        remote: value.location.remote,
        countries: strings(eligibility.countries),
        regions: strings(eligibility.regions),
        timezones: strings(eligibility.timezones),
        flags: Number(eligibility.flags) || 0,
        workAuthorization: {
          required: strings(auth.required),
          sponsorship: ['yes', 'no'].includes(text(auth.sponsorship))
            ? auth.sponsorship
            : 'unknown',
        },
      },
    }).data ?? null
  );
}
const EMPTY: PublicFacets = {
  skills: [],
  seniority: [],
  function: [],
  work_mode: [],
  employment_type: [],
  country: [],
};
function expandedSkill(value: string): string[] {
  const canonical = canonicalSkillSlug(value);
  return [
    ...new Set([
      value.toLowerCase(),
      canonical,
      ...Object.entries(SKILL_CANONICAL_ALIASES)
        .filter(([, slug]) => slug === canonical)
        .map(([alias]) => alias),
    ]),
  ];
}
function canonicalSkills(values: readonly string[]): string[] {
  return [...new Set(values.map(canonicalSkillSlug).filter(Boolean))];
}

function terms(q: string) {
  return q
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .map((t) =>
      expandedSkill(t)
        .map((v) => `"${v.replaceAll('"', '""')}"`)
        .join(' OR '),
    )
    .map((t) => `(${t})`)
    .join(' AND ');
}
/** Escape a literal LIKE substring so public location input cannot widen it. */
function literalLikeSubstring(value: string) {
  return `%${value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')}%`;
}
function cursorSecret() {
  const s = process.env.IOLAUS_PUBLIC_CURSOR_SECRET;
  if (!s || s.length < 32)
    throw new PublicSearchError(
      503,
      'Public search requires a stable cursor secret of at least 32 characters.',
    );
  return s;
}
function sign(v: Row, secret: string) {
  const b = Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b}.${createHmac('sha256', secret).update(b).digest('base64url')}`;
}
function cursor(raw: string | undefined, secret: string): Row | null {
  if (!raw) return null;
  const [b, s, ...extra] = raw.split('.');
  const h = createHmac('sha256', secret)
    .update(b || '')
    .digest('base64url');
  if (
    extra.length ||
    !s ||
    s.length !== h.length ||
    !timingSafeEqual(Buffer.from(s), Buffer.from(h))
  )
    throw new PublicSearchError(400, 'Invalid cursor');
  try {
    return JSON.parse(Buffer.from(b, 'base64url').toString());
  } catch {
    throw new PublicSearchError(400, 'Invalid cursor');
  }
}
function key(input: PublicSearchInput) {
  const { cursor: _, ...rest } = input;
  rest.q = terms(rest.q);
  rest.skills = canonicalSkills(rest.skills);
  for (const k of [
    'skills',
    'seniority',
    'function',
    'work_mode',
    'employment_type',
    'country',
  ] as const)
    rest[k] = [...rest[k]].sort();
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}
const searchCaches = new WeakMap<
  PublicDatabase,
  Map<string, { at: number; value: PublicSearchPage }>
>();
const facetCaches = new WeakMap<
  PublicDatabase,
  Map<string, { at: number; value: PublicFacets }>
>();
export function createPublicSearchReader(
  db: PublicDatabase,
  dialect: 'sqlite' | 'postgres',
  secret: string,
) {
  const query = async (sql: string, values: unknown[] = []) =>
    rows(await db.query(sql, ...values));
  function predicate(input: PublicSearchInput, includeSkillRank = true) {
    const values: unknown[] = [];
    const add = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };
    const parts = ['1=1'];
    let rank = '0.0';
    if (input.q) {
      const term = terms(input.q);
      if (dialect === 'sqlite') {
        const p = add(term);
        parts.push(
          `c.id IN (SELECT id FROM jobgeni_public_catalog_fts WHERE jobgeni_public_catalog_fts MATCH ${p})`,
        );
        rank = 'fts.fts_rank';
      } else {
        const tsquery = input.q
          .split(/\s+/u)
          .filter(Boolean)
          .map(
            (word) =>
              `(${expandedSkill(word)
                .map((alias) => `plainto_tsquery('english',${add(alias)})`)
                .join(' || ')})`,
          )
          .join(' && ');

        // Keep a hashed membership subplan: cross-table version predicates can
        // underestimate the barrier view and otherwise choose a quadratic semi-join.
        parts.push(
          `(CAST(c.id AS TEXT) IN (SELECT id FROM public.search_public_catalog((${tsquery})))) IS TRUE`,
        );
        rank = `ts_rank_cd(c.search_vector,(${tsquery}))`;
      }
    }
    for (const col of [
      'seniority',
      'function',
      'work_mode',
      'employment_type',
    ] as const)
      if (input[col].length)
        parts.push(`c.${col} IN (${input[col].map(add).join(',')})`);
    const jsonHas = (col: string, items: string[]) => {
      if (!items.length) return;
      parts.push(
        dialect === 'sqlite'
          ? `EXISTS(SELECT 1 FROM json_each(c.${col}) j WHERE j.value IN (${items.map(add).join(',')}))`
          : `EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.${col}::jsonb) j(value) WHERE j.value IN (${items.map(add).join(',')}))`,
      );
    };
    const selectedSkills = canonicalSkills(input.skills);
    jsonHas('skill_slugs_json', [
      ...new Set(selectedSkills.flatMap(expandedSkill)),
    ]);
    const skillRank =
      input.sort === 'relevance' && includeSkillRank
        ? selectedSkills
            .map((skill) => {
              const aliases = expandedSkill(skill);
              const values = aliases.map(add).join(',');
              const source =
                dialect === 'sqlite'
                  ? `json_each(c.skill_slugs_json) j`
                  : `jsonb_array_elements_text(c.skill_slugs_json::jsonb) j(value)`;
              return `CASE WHEN EXISTS(SELECT 1 FROM ${source} WHERE j.value IN (${values})) THEN 1 ELSE 0 END`;
            })
            .join(' + ') || '0'
        : '0';
    jsonHas('countries_json', input.country);
    if (input.location) {
      const location = add(literalLikeSubstring(input.location));
      parts.push(`lower(c.locations) LIKE lower(${location}) ESCAPE '\\'`);
    }
    if (input.company) parts.push(`c.company_id=${add(input.company)}`);
    if (input.source) parts.push(`c.source_id=${add(input.source)}`);
    if (input.posted_since)
      parts.push(`c.posted_at>=${add(input.posted_since)}`);
    const json = (field: string) =>
      dialect === 'sqlite'
        ? `json_extract(c.compensation_json,'$.${field}')`
        : `(c.compensation_json::jsonb->>'${field}')`;
    if (input.salary_min !== undefined || input.sort === 'salary') {
      parts.push(
        `${json('source')}='posted'`,
        `${json('currency')}=${add(input.salary_currency)}`,
        `${json('period')}=${add(input.salary_period)}`,
      );
      if (input.salary_min !== undefined)
        parts.push(
          `CAST(coalesce(${json('max')},${json('min')}) AS REAL)>=${add(input.salary_min)}`,
        );
    }
    if (input.remote_ok !== undefined)
      parts.push(
        dialect === 'sqlite'
          ? `json_extract(c.eligibility_json,'$.remote')=${add(input.remote_ok ? 1 : 0)}`
          : `(c.eligibility_json::jsonb->>'remote')=${add(String(input.remote_ok))}`,
      );
    if (input.sort === 'newest') rank = '0.0';
    if (input.sort === 'salary')
      rank = `CAST(coalesce(${json('max')},${json('min')},'0') AS REAL)`;
    return { values, where: parts.join(' AND '), rank, skillRank };
  }
  async function state() {
    const r = (
      await query(
        'SELECT coalesce(max(generation),0) AS generation,count(*) AS visible FROM jobgeni_public_search_v1',
      )
    )[0];
    return `${r?.generation ?? 0}:${r?.visible ?? 0}`;
  }
  async function facets(
    input: PublicSearchInput,
    visibility?: string,
  ): Promise<PublicFacets> {
    let cache = facetCaches.get(db);
    if (!cache) {
      cache = new Map();
      facetCaches.set(db, cache);
    }
    const cacheKey = `${visibility ?? (await state())}:${key({ ...input, cursor: undefined, limit: 20 })}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < 300000) return cached.value;

    const p = predicate(input, false);
    const out: PublicFacets = { ...EMPTY };
    for (const col of [
      'skills',
      'seniority',
      'function',
      'work_mode',
      'employment_type',
      'country',
    ] as const) {
      const jsonCol =
        col === 'skills'
          ? 'skill_slugs_json'
          : col === 'country'
            ? 'countries_json'
            : null;
      const source = jsonCol
        ? dialect === 'sqlite'
          ? `json_each(c.${jsonCol}) j`
          : `jsonb_array_elements_text(c.${jsonCol}::jsonb) j(value)`
        : null;
      const val = source ? 'j.value' : `c.${col}`;
      out[col] = (
        await query(
          `SELECT ${val} AS value,count(DISTINCT c.id) AS count FROM jobgeni_public_search_v1 c ${source ? `CROSS JOIN ${source}` : ''} WHERE ${p.where} AND ${val} IS NOT NULL AND ${val} <> '' GROUP BY ${val} ORDER BY count DESC,value ASC LIMIT 50`,
          p.values,
        )
      ).map((r) => ({
        value: text(r.value),
        label: text(r.value),
        count: Number(r.count),
      }));
    }
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { at: Date.now(), value: out });
    return out;
  }
  async function search(raw: unknown) {
    const input = publicSearchInputSchema.parse(raw);
    const p = predicate(input);
    const generation = await state();
    const fingerprint = key(input);
    let cache = searchCaches.get(db);
    if (!cache) {
      cache = new Map();
      searchCaches.set(db, cache);
    }
    const cacheKey = `${generation}:${fingerprint}:${input.cursor ?? ''}`;
    const cur = cursor(input.cursor, secret);
    if (
      cur &&
      (cur.key !== fingerprint ||
        cur.generation !== generation ||
        Number(cur.expires) < Date.now() ||
        !Number.isInteger(cur.depth) ||
        Number(cur.depth) > 20 ||
        !Number.isFinite(Number(cur.skill_rank)))
    )
      throw new PublicSearchError(
        400,
        'Expired cursor or changed search. Restart pagination.',
      );
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    const add = (v: unknown) => {
      p.values.push(v);
      return `$${p.values.length}`;
    };
    const tail = cur
      ? `WHERE (skill_rank<${add(cur.skill_rank)} OR (skill_rank=${add(cur.skill_rank)} AND (sort_rank<${add(cur.rank)} OR (sort_rank=${add(cur.rank)} AND (sort_date<${add(cur.date)} OR (sort_date=${add(cur.date)} AND id<${add(cur.id)}))))))`
      : '';
    let result = await query(
      `WITH ${input.q && dialect === 'sqlite' ? 'fts AS MATERIALIZED (SELECT id,-bm25(jobgeni_public_catalog_fts) AS fts_rank FROM jobgeni_public_catalog_fts WHERE jobgeni_public_catalog_fts MATCH $1),' : ''} matches AS (SELECT c.id,${p.skillRank} AS skill_rank,${p.rank} AS sort_rank,coalesce(c.posted_at,'1970-01-01') AS sort_date FROM ${input.q && dialect === 'sqlite' ? 'fts CROSS JOIN jobgeni_public_search_v1 c ON c.id=fts.id' : 'jobgeni_public_search_v1 c'} WHERE ${p.where}) SELECT * FROM matches ${tail} ORDER BY skill_rank DESC,sort_rank DESC,sort_date DESC,id DESC LIMIT ${add(input.limit + 1)}`,
      p.values,
    );
    if (result.length) {
      const ids = result.map((r) => r.id);
      const detailRows = await query(
        `SELECT ${listColumns} FROM jobgeni_public_search_v1 WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
        ids,
      );
      const byId = new Map(detailRows.map((r) => [r.id, r]));
      result = result
        .filter((r) => byId.has(r.id))
        .map((r) => ({ ...byId.get(r.id), ...r }));
    }
    const more = result.length > input.limit;
    const page = result.slice(0, input.limit);
    const last = page.at(-1);
    const countPredicate = predicate(input, false);
    const count = await query(
      `SELECT count(*) AS total FROM jobgeni_public_search_v1 c WHERE ${countPredicate.where}`,
      countPredicate.values,
    );
    const pageResult = publicSearchPageSchema.parse({
      items: page.map((r) => projectPublicOpportunity(r)).filter(Boolean),
      next_cursor:
        more && last
          ? sign(
              {
                key: fingerprint,
                generation,
                expires: cur?.expires ?? Date.now() + 3600000,
                depth: Number(cur?.depth ?? 0) + 1,
                skill_rank: Number(last.skill_rank),
                rank: Number(last.sort_rank),
                date: last.sort_date,
                id: last.id,
              },
              secret,
            )
          : null,
      total_estimate: Number(count[0]?.total ?? 0),
      facets: await facets(input, generation),
    });
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { at: Date.now(), value: pageResult });
    return pageResult;
  }
  async function get(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) return null;
    const r = (
      await query(
        `SELECT * FROM jobgeni_public_search_v1 WHERE id=$1 LIMIT 1`,
        [id],
      )
    )[0];
    return r ? projectPublicOpportunity(r, true) : null;
  }
  async function getMany(ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if (
      unique.length > 500 ||
      unique.some((id) => !/^[A-Za-z0-9_-]{1,128}$/u.test(id))
    )
      throw new PublicSearchError(400, 'Invalid opportunity selection.');
    if (!unique.length) return [];
    const records = await query(
      `SELECT ${listColumns} FROM jobgeni_public_search_v1 WHERE id IN (${unique.map((_, index) => `$${index + 1}`).join(',')})`,
      unique,
    );
    return records
      .map((row) => projectPublicOpportunity(row))
      .filter((item): item is PublicOpportunity => item !== null);
  }
  async function match(raw: unknown) {
    const input = publicMatchInputSchema.parse(raw);
    const ids = input.opportunity_ids;
    const records = await query(
      `SELECT ${listColumns} FROM jobgeni_public_search_v1 ${ids?.length ? `WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})` : ''} ORDER BY posted_at DESC,id DESC LIMIT 500`,
      ids ?? [],
    );
    const details = records
      .map(
        (r) =>
          publicOpportunityDetailSchema.safeParse(
            projectPublicOpportunity(r, true),
          ).data,
      )
      .filter((v): v is NonNullable<typeof v> => Boolean(v));
    const scores = matchSkills(
      { ...input, remoteOk: input.remote_ok },
      details.map((o) => ({
        id: o.id,
        seniority: o.seniority,
        eligibility: o.eligibility,
        requirements: o.requirements,
        skills: {
          required: o.skills.required.map((s) => s.slug),
          preferred: o.skills.preferred.map((s) => s.slug),
        },
      })),
    );
    return publicMatchResultSchema.parse({
      items: scores.slice(0, 50).map((s) => ({
        opportunity: details.find((o) => o.id === s.id),
        score: s.score,
        matched_skills: s.explanation.matchedSkills,
        missing_skills: s.explanation.missingSkills,
        eligibility_notes: s.explanation.eligibilityNotes,
        requirements: s.explanation.requirements.map((r) => ({
          hash: r.hash,
          decision: r.decision,
          confidence: r.confidence,
          submitted_skill_indices: r.submittedSkillIndices,
        })),
      })),
      model_calls: 0,
    });
  }
  async function sitemap() {
    return (
      await query(
        'SELECT id,updated_at,company_id,skill_slugs_json FROM jobgeni_public_search_v1 ORDER BY id LIMIT 50000',
      )
    ).map((row) => ({
      id: text(row.id),
      updated_at: date(row.updated_at),
      company_id: text(row.company_id),
      skills: strings(row.skill_slugs_json),
    }));
  }
  return {
    search,
    get,
    sitemap,
    getMany,
    facets: (raw: unknown) => facets(publicSearchInputSchema.parse(raw)),
    match,
  };
}
async function connection() {
  const config = getDbConfig();
  if (applicationRuntime.profile === 'local')
    return {
      db: (await resolveDatabase(config)) as unknown as PublicDatabase,
      dialect: config.type,
    };
  const url = process.env.IOLAUS_PUBLIC_READ_DATABASE_URL;
  if (process.env.IOLAUS_PUBLIC_SEARCH_ENABLED !== 'true' || !url)
    throw new PublicSearchError(503, 'Public catalog is unavailable.');
  const publicUrl = new URL(url);
  publicUrl.searchParams.set('statement_timeout', '500');
  return {
    db: (await resolveDatabase({
      type: 'postgres',
      url: publicUrl.href,
      max: Math.min(5, hostedDatabasePoolMax()),
    })) as unknown as PublicDatabase,
    dialect: 'postgres' as const,
  };
}
async function reader() {
  const c = await connection();
  return createPublicSearchReader(c.db, c.dialect, cursorSecret());
}
export async function searchPublicOpportunities(input: unknown) {
  return (await reader()).search(input);
}
export async function getPublicOpportunity(id: string) {
  return (await reader()).get(id);
}
/** Bounded internal batch read through the same sanitized catalog projection. */
export async function getPublicOpportunities(ids: readonly string[]) {
  return (await reader()).getMany(ids);
}
export async function listPublicFacets(input: unknown) {
  return (await reader()).facets(input);
}
export async function matchPublicSkills(input: unknown) {
  return (await reader()).match(input);
}
/** Atomic shared budget. No caller IP header is accepted until trusted ingress is deployed. */
export async function consumePublicSearchBudget(cost = 1) {
  const { db, dialect } = await connection();
  const result =
    dialect === 'postgres'
      ? rows(
          await db.query(
            `SELECT public.consume_public_search_quota($1) AS remaining`,
            cost,
          ),
        )
      : rows(
          await db.query(
            `INSERT INTO public_search_quotas(bucket,window_start,spent) VALUES('anonymous-global',$1,$2) ON CONFLICT(bucket) DO UPDATE SET window_start=$1,spent=CASE WHEN public_search_quotas.window_start=$1 THEN public_search_quotas.spent+$2 ELSE $2 END RETURNING max(0,601-spent) AS remaining`,
            Math.floor(Date.now() / 60000),
            cost,
          ),
        );
  const remaining = Number(result[0]?.remaining ?? 0);
  if (!remaining)
    throw new PublicSearchError(
      429,
      'Public query budget exceeded. Retry in one minute.',
    );
  return remaining - 1;
}

export async function listPublicSitemapEntries() {
  return (await reader()).sitemap();
}
