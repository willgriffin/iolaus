import { createHash } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import {
  DECISION_REVIEW_STATUSES,
  type OpportunityFilterOptions,
  type OpportunityFilterState,
} from '$lib/opportunity-filters';
import { getDbConfig } from './db.js';

/** Hidden from every default listing; selectable through an explicit filter. */
const ARCHIVED_OPPORTUNITY_STATUS = 'archived';
const OPPORTUNITY_INDEX_BUILD_LOCK_TIMEOUT = '15s';
const OPPORTUNITY_INDEX_BUILD_STATEMENT_TIMEOUT = '15min';
const OPPORTUNITY_QUERY_INDEXES = [
  {
    name: 'idx_evaluation_scores_opportunity_fingerprint_updated',
    statement: `CREATE INDEX CONCURRENTLY idx_evaluation_scores_opportunity_fingerprint_updated
      ON evaluation_scores (
        opportunity_id,
        (COALESCE(source_content_fingerprint, '')),
        updated_at DESC
      ) INCLUDE (score)`,
  },
  {
    name: 'idx_applications_opportunity_updated',
    statement: `CREATE INDEX CONCURRENTLY idx_applications_opportunity_updated
      ON applications (opportunity_id, updated_at DESC)`,
  },
] as const;

export const OPPORTUNITY_TABLE_PAGE_SIZE = 100;

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

async function queryDatabase(): Promise<SmrtDatabase> {
  return getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
}

type QueryResult =
  | { rows?: Record<string, unknown>[] }
  | Record<string, unknown>[];

export type OpportunityQuery = {
  candidateSkills: readonly string[];
  filters: OpportunityFilterState;
  reviewFilter: string;
  search?: string;
};

export type LatestOpportunityRelatedContextRow = {
  applicationId?: string;
  applicationStatus?: string;
  opportunityId: string;
  recommendation?: string;
  score?: number | null;
  scoreId?: string;
  scoreSummary?: string;
};

function rowsFromResult(result: QueryResult): Record<string, unknown>[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function pushParam(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function sqlStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
}

function latestScoreJoinSql(): string {
  return `LEFT JOIN LATERAL (
    SELECT es.score
    FROM evaluation_scores es
    WHERE es.opportunity_id = o.id
      AND COALESCE(es.source_content_fingerprint, '') =
        COALESCE(o.source_content_fingerprint, '')
    ORDER BY es.updated_at DESC
    LIMIT 1
  ) latest ON TRUE`;
}

function latestApplicationJoinSql(): string {
  return `LEFT JOIN LATERAL (
    SELECT a.id, a.resume_mode, a.cover_letter_mode
    FROM applications a
    WHERE a.opportunity_id = o.id
    ORDER BY a.updated_at DESC
    LIMIT 1
  ) latest_application ON TRUE`;
}

function normalizedReviewStatusSql(): string {
  return 'lower(btrim(o.human_review_status))';
}

function reviewWhereSql(
  reviewFilter: string,
  values: unknown[],
): { needsApplication: boolean; where: string[] } {
  // Branch on the same value the fingerprint hashes: it trims, so `' all '`
  // must select no review filter rather than an equality that matches nothing.
  const review = reviewFilter.trim();
  if (!review || review === 'all') {
    return { needsApplication: false, where: [] };
  }
  if (review === 'missing_application_planning') {
    return {
      needsApplication: true,
      where: [
        `${normalizedReviewStatusSql()} = ${pushParam(values, 'apply')}`,
        `(latest_application.id IS NULL
          OR COALESCE(latest_application.resume_mode, '') = ''
          OR COALESCE(latest_application.cover_letter_mode, '') = '')`,
      ],
    };
  }
  if (review === 'unsorted') {
    const placeholders = DECISION_REVIEW_STATUSES.map((status) =>
      pushParam(values, status),
    ).join(', ');
    return {
      needsApplication: false,
      where: [
        `COALESCE(${normalizedReviewStatusSql()}, '') NOT IN (${placeholders})`,
      ],
    };
  }
  return {
    needsApplication: false,
    where: [
      `${normalizedReviewStatusSql()} = ${pushParam(
        values,
        review.toLowerCase(),
      )}`,
    ],
  };
}

function rangeOverlapSql({
  lower,
  lowerName,
  upper,
  upperName,
  values,
  includeMissing,
}: {
  lower: number | null;
  lowerName: string;
  upper: number | null;
  upperName: string;
  values: unknown[];
  includeMissing: boolean;
}): string | null {
  if (lower === null && upper === null) return null;

  const max = `COALESCE(o.${upperName}, o.${lowerName})`;
  const min = `COALESCE(o.${lowerName}, o.${upperName})`;
  const predicates: string[] = [];
  if (lower !== null) predicates.push(`${max} >= ${pushParam(values, lower)}`);
  if (upper !== null) predicates.push(`${min} <= ${pushParam(values, upper)}`);

  const overlaps = predicates.join(' AND ');
  if (!includeMissing) return `(${overlaps})`;
  return `(
    (o.${lowerName} IS NULL AND o.${upperName} IS NULL)
    OR (${overlaps})
  )`;
}

function normalizedPhraseSql(value: string): string {
  return `regexp_replace(lower(btrim(${value})), '[^a-z0-9]+', ' ', 'g')`;
}

function requiredSkillValuesSql(): string {
  return `unnest(
    regexp_split_to_array(COALESCE(o.required_skills, ''), E'[,\\n\\r]+')
  ) AS required_skill(value)`;
}

function allSkillValuesSql(): string {
  return `unnest(
    regexp_split_to_array(
      concat_ws(',', COALESCE(o.required_skills, ''), COALESCE(o.preferred_skills, '')),
      E'[,\\n\\r]+'
    )
  ) AS opportunity_skill(value)`;
}

/**
 * The one canonical form of a free-text term list.
 *
 * Both the fingerprint and the SQL must derive the matching set from exactly
 * the same values. When only the fingerprint trimmed, two spellings of the
 * same list -- `['react']` and `[' react ']` -- hashed identically but matched
 * differently, so a confirmation minted under one could be spent against the
 * row set of the other.
 */
export function normalizeQueryTerms(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

function candidateSkillMatchSql(candidatePlaceholder: string): string {
  const requiredPhrase = normalizedPhraseSql('required_skill.value');
  return `EXISTS (
    SELECT 1
    FROM unnest(${candidatePlaceholder}::text[]) AS candidate_term(value)
    WHERE ${requiredPhrase} <> ''
      AND (
        (' ' || ${requiredPhrase} || ' ') LIKE ('% ' || candidate_term.value || ' %')
        OR (' ' || candidate_term.value || ' ') LIKE ('% ' || ${requiredPhrase} || ' %')
      )
  )`;
}

function filterWhereSql({
  candidateSkills,
  filters,
  search,
  values,
}: Pick<OpportunityQuery, 'candidateSkills' | 'filters' | 'search'> & {
  values: unknown[];
}): { needsScore: boolean; where: string[] } {
  const where: string[] = [];
  let needsScore = false;

  const searchTerm = search?.trim().slice(0, 200);
  if (searchTerm) {
    const pattern = pushParam(values, `%${searchTerm}%`);
    where.push(`(
      o.title ILIKE ${pattern}
      OR o.description_summary ILIKE ${pattern}
      OR o.required_skills ILIKE ${pattern}
      OR o.preferred_skills ILIKE ${pattern}
      OR o.locations ILIKE ${pattern}
      OR o.posting_url ILIKE ${pattern}
      OR EXISTS (
        SELECT 1
        FROM companies search_company
        WHERE search_company.id = o.company_id
          AND search_company.name ILIKE ${pattern}
      )
    )`);
  }

  if (filters.status === 'all') {
    // Archived rows are terminal and, since the Stage 0 inactive-source sweep,
    // the bulk of the table. They stay out of every list unless a status
    // filter explicitly asks for them.
    where.push(`o.status <> ${pushParam(values, ARCHIVED_OPPORTUNITY_STATUS)}`);
  } else {
    where.push(`o.status = ${pushParam(values, filters.status)}`);
  }

  const skills = normalizeQueryTerms(filters.skills).map((skill) =>
    skill.toLowerCase(),
  );
  // Gate on the normalized list, not the raw one: `[' ']` must behave as the
  // empty list it fingerprints as, rather than adding an unsatisfiable
  // predicate the fingerprint cannot distinguish.
  if (skills.length > 0) {
    where.push(`EXISTS (
      SELECT 1
      FROM ${allSkillValuesSql()}
      WHERE lower(btrim(opportunity_skill.value)) = ANY(${pushParam(values, skills)}::text[])
    )`);
  }

  if (filters.fit !== 'all') {
    const candidatePlaceholder = pushParam(
      values,
      normalizeQueryTerms(candidateSkills),
    );
    const candidateMatch = candidateSkillMatchSql(candidatePlaceholder);
    const unmatchedRequiredSkill = `EXISTS (
      SELECT 1
      FROM ${requiredSkillValuesSql()}
      WHERE btrim(required_skill.value) <> ''
        AND NOT (${candidateMatch})
    )`;
    where.push(
      filters.fit === 'have'
        ? `NOT (${unmatchedRequiredSkill})`
        : unmatchedRequiredSkill,
    );
  }

  const salaryRange = rangeOverlapSql({
    lower: filters.salaryMin,
    lowerName: 'salary_min',
    upper: filters.salaryMax,
    upperName: 'salary_max',
    values,
    includeMissing: filters.includeMissingComp,
  });
  if (salaryRange) where.push(salaryRange);

  const hourlyRange = rangeOverlapSql({
    lower: filters.hourlyMin,
    lowerName: 'hourly_min',
    upper: filters.hourlyMax,
    upperName: 'hourly_max',
    values,
    includeMissing: filters.includeMissingComp,
  });
  if (hourlyRange) where.push(hourlyRange);

  if (filters.postedWithinDays !== null) {
    where.push(
      `COALESCE(o.posted_at, o.first_seen_at) >= NOW() - (${pushParam(
        values,
        filters.postedWithinDays,
      )} * INTERVAL '1 day')`,
    );
  }
  if (filters.excludeExpired) {
    where.push(`(o.expires_at IS NULL OR o.expires_at >= NOW())`);
  }
  if (filters.excludeStale) {
    // A posting the board reconciliation stopped seeing is not worth a
    // decision; it stays out of any listing that opts into this filter.
    where.push(`COALESCE(lower(btrim(o.freshness)), '') <> 'stale'`);
  }
  if (filters.freshness !== 'all') {
    where.push(`o.freshness = ${pushParam(values, filters.freshness)}`);
  }
  const employmentTypes = normalizeQueryTerms(filters.employmentTypes);
  if (employmentTypes.length > 0) {
    where.push(
      `o.employment_type = ANY(${pushParam(values, employmentTypes)}::text[])`,
    );
  }
  const workModes = normalizeQueryTerms(filters.workModes);
  if (workModes.length > 0) {
    where.push(`o.work_mode = ANY(${pushParam(values, workModes)}::text[])`);
  }
  if (filters.seniority !== 'all') {
    where.push(`o.seniority = ${pushParam(values, filters.seniority)}`);
  }
  if (filters.relocationOnly) where.push(`o.relocation_supported IS TRUE`);
  if (filters.visaOnly) where.push(`o.visa_or_eor_possible IS TRUE`);
  if (filters.founderOnly) where.push(`o.founder_signal IS TRUE`);
  if (filters.greenfieldOnly) where.push(`o.greenfield_signal IS TRUE`);
  if (filters.freshOnly) where.push(`lower(btrim(o.freshness)) = 'fresh'`);
  if (filters.minRating !== null) {
    where.push(`o.human_rating >= ${pushParam(values, filters.minRating)}`);
  }
  if (filters.minScore !== null) {
    needsScore = true;
    where.push(`latest.score >= ${pushParam(values, filters.minScore)}`);
  }
  if (filters.maxScore !== null) {
    needsScore = true;
    where.push(`latest.score <= ${pushParam(values, filters.maxScore)}`);
  }

  return { needsScore, where };
}

function opportunityStatusRankSql(): string {
  return `CASE o.status
    WHEN 'apply' THEN 1
    WHEN 'applied' THEN 2
    WHEN 'interviewing' THEN 3
    WHEN 'offer' THEN 4
    WHEN 'recommended' THEN 5
    WHEN 'found' THEN 6
    WHEN 'maybe' THEN 7
    WHEN 'needs_input' THEN 8
    WHEN 'archived' THEN 9
    WHEN 'reject' THEN 10
    WHEN 'rejected' THEN 11
    WHEN 'closed' THEN 12
    ELSE 13
  END`;
}

function orderBySql(
  sort: OpportunityFilterState['sort'],
  direction: OpportunityFilterState['sortDirection'],
): string {
  const sqlDirection = direction === 'asc' ? 'ASC' : 'DESC';
  switch (sort) {
    case 'newest':
      return `COALESCE(o.posted_at, o.first_seen_at) ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    case 'score':
      return `latest.score ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    case 'salary':
      return `COALESCE(o.salary_max, o.salary_min) ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    case 'rating':
      return `o.human_rating ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    default:
      return `${opportunityStatusRankSql()} ASC, latest.score DESC NULLS LAST, o.updated_at DESC, o.id ASC`;
  }
}

export function createOpportunityWhereSql(query: OpportunityQuery): {
  joins: string[];
  values: unknown[];
  whereSql: string;
} {
  const values: unknown[] = [];
  const review = reviewWhereSql(query.reviewFilter, values);
  const filters = filterWhereSql({
    candidateSkills: query.candidateSkills,
    filters: query.filters,
    search: query.search,
    values,
  });
  const joins: string[] = [];
  if (filters.needsScore) joins.push(latestScoreJoinSql());
  if (review.needsApplication) joins.push(latestApplicationJoinSql());
  const where = [...review.where, ...filters.where];
  return {
    joins,
    values,
    whereSql: where.length > 0 ? `WHERE ${where.join('\n AND ')}` : '',
  };
}

/**
 * The list's score and application joins are on the hot path for every page.
 * SMRT schema migrations own tables and columns; these application indexes are
 * deliberately idempotent supplemental query indexes.
 */
export async function ensureOpportunityListQueryIndexes(
  db?: SmrtDatabase,
): Promise<void> {
  const database = db ?? (await resolveDatabase(getDbConfig()));
  if (typeof database.acquireSession !== 'function') {
    throw new Error(
      'Opportunity list index creation requires a PostgreSQL pinned session.',
    );
  }

  // Concurrent indexes must run outside a transaction. Pin both the timeouts
  // and DDL to one session so a pooled adapter cannot apply them separately.
  const session = await database.acquireSession();
  try {
    await session.query("SELECT set_config('lock_timeout', $1, false)", [
      OPPORTUNITY_INDEX_BUILD_LOCK_TIMEOUT,
    ]);
    await session.query("SELECT set_config('statement_timeout', $1, false)", [
      OPPORTUNITY_INDEX_BUILD_STATEMENT_TIMEOUT,
    ]);
    for (const index of OPPORTUNITY_QUERY_INDEXES) {
      const existing = await session.query(
        `SELECT i.indisvalid AS "isValid"
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname = current_schema()`,
        [index.name],
      );
      const [existingIndex] = rowsFromResult(existing as QueryResult);
      if (existingIndex?.isValid === true) continue;
      if (existingIndex) {
        // PostgreSQL leaves an invalid catalog entry if a concurrent build is
        // cancelled or fails. Remove it before retrying the definition.
        await session.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
      }
      await session.query(index.statement);
    }
  } finally {
    await session.release();
  }
}

/** One matched row, carrying the revision a guarded write must present. */
export type OpportunityMatchingRow = {
  id: string;
  updatedAt: string;
};

/**
 * Canonicalize a query into the exact value the fingerprint hashes.
 *
 * Every field the WHERE clause reads is included, plus the sort, so a
 * selection captured under one ordering cannot be replayed under another.
 * The page offset is deliberately excluded: an "all matching" selection spans
 * every page by definition, so paging must not invalidate it.
 *
 * Array members are sorted and de-duplicated, and the search term is trimmed
 * and case-folded, so two spellings of the same query agree. Keys are emitted
 * in a fixed order because `JSON.stringify` preserves insertion order and a
 * fingerprint that depended on object construction order would be unstable.
 */
function canonicalOpportunityQuery(query: OpportunityQuery): string {
  const filters = query.filters;
  const list = normalizeQueryTerms;
  return JSON.stringify([
    ['candidateSkills', list(query.candidateSkills)],
    ['reviewFilter', query.reviewFilter.trim()],
    ['search', (query.search ?? '').trim().toLowerCase()],
    ['status', filters.status],
    ['fit', filters.fit],
    ['skills', list(filters.skills)],
    ['salaryMin', filters.salaryMin],
    ['salaryMax', filters.salaryMax],
    ['hourlyMin', filters.hourlyMin],
    ['hourlyMax', filters.hourlyMax],
    ['includeMissingComp', filters.includeMissingComp],
    ['postedWithinDays', filters.postedWithinDays],
    ['excludeExpired', filters.excludeExpired],
    ['freshness', filters.freshness],
    ['employmentTypes', list(filters.employmentTypes)],
    ['workModes', list(filters.workModes)],
    ['seniority', filters.seniority],
    ['relocationOnly', filters.relocationOnly],
    ['visaOnly', filters.visaOnly],
    ['founderOnly', filters.founderOnly],
    ['greenfieldOnly', filters.greenfieldOnly],
    ['freshOnly', filters.freshOnly],
    ['minRating', filters.minRating],
    ['minScore', filters.minScore],
    ['maxScore', filters.maxScore],
    ['sort', filters.sort],
    ['sortDirection', filters.sortDirection],
  ]);
}

/**
 * A stable digest of the filter state a listing was rendered under.
 *
 * A bulk action over "all matching rows" never ships browser-supplied ids: the
 * client returns this fingerprint and the server re-resolves the set. If the
 * caller's filters have drifted from the ones the fingerprint was minted
 * under, the digests disagree and the action is refused rather than applied to
 * a set the operator never saw.
 */
export function createOpportunityQueryFingerprint(
  query: OpportunityQuery,
): string {
  return createHash('sha256')
    .update(canonicalOpportunityQuery(query))
    .digest('hex');
}

/**
 * Every opportunity id matching `query`, with its current revision.
 *
 * Ordered by id — not by the listing sort — because the caller needs a set,
 * and a stable order keeps the selection fingerprint reproducible. Pass
 * `limit` one above the permitted maximum so an oversized selection is
 * detectable without counting the whole table twice.
 *
 * `updatedAt` is carried so the apply phase can pin each write to the revision
 * that was resolved here; a row edited in between fails its own guard instead
 * of silently overwriting the newer value.
 */
export async function listOpportunityMatchingIds(
  query: OpportunityQuery,
  { limit }: { limit: number },
): Promise<OpportunityMatchingRow[]> {
  const db = await queryDatabase();
  const built = createOpportunityWhereSql(query);
  const limitPlaceholder = pushParam(built.values, limit);
  const result = await db.query(
    `SELECT o.id, o.updated_at AS "updatedAt"
    FROM opportunities o
    ${built.joins.join('\n')}
    ${built.whereSql}
    ORDER BY o.id ASC
    LIMIT ${limitPlaceholder}`,
    ...built.values,
  );
  return rowsFromResult(result).flatMap((row) => {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) return [];
    const updatedAt = row.updatedAt;
    return [
      {
        id,
        updatedAt:
          updatedAt instanceof Date
            ? updatedAt.toISOString()
            : String(updatedAt ?? ''),
      },
    ];
  });
}

/**
 * Current revisions for an explicit set of opportunity ids.
 *
 * Used where the caller already knows exactly which rows it means -- an
 * explicit selection, or the ids a page listing returned -- so the set must
 * not be re-derived from, or bounded by, the filter query. Ids that no longer
 * exist are simply absent, which the caller reports as `not_found` per row.
 */
export async function listOpportunityRevisionsByIds(
  ids: readonly string[],
): Promise<OpportunityMatchingRow[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await queryDatabase();
  const result = await db.query(
    `SELECT o.id, o.updated_at AS "updatedAt"
    FROM opportunities o
    WHERE o.id = ANY($1)`,
    unique,
  );
  return rowsFromResult(result).flatMap((row) => {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) return [];
    const updatedAt = row.updatedAt;
    return [
      {
        id,
        updatedAt:
          updatedAt instanceof Date
            ? updatedAt.toISOString()
            : String(updatedAt ?? ''),
      },
    ];
  });
}

export async function countOpportunityRecords(
  query: OpportunityQuery,
): Promise<number> {
  const db = await queryDatabase();
  const { joins, values, whereSql } = createOpportunityWhereSql(query);
  const result = await db.query(
    `SELECT COUNT(*) AS count
    FROM opportunities o
    ${joins.join('\n')}
    ${whereSql}`,
    ...values,
  );
  const [row] = rowsFromResult(result);
  return Number(row?.count ?? 0);
}

export async function listOpportunityPageIds({
  candidateSkills,
  filters,
  limit,
  offset,
  reviewFilter,
  search,
}: OpportunityQuery & {
  limit: number;
  offset: number;
}): Promise<string[]> {
  const db = await queryDatabase();
  const query = createOpportunityWhereSql({
    candidateSkills,
    filters,
    reviewFilter,
    search,
  });
  const needsScoreForSort = filters.sort === 'best' || filters.sort === 'score';
  if (
    needsScoreForSort &&
    !query.joins.some((join) => join.includes('evaluation_scores'))
  ) {
    query.joins.unshift(latestScoreJoinSql());
  }
  const limitPlaceholder = pushParam(query.values, limit);
  const offsetPlaceholder = pushParam(query.values, offset);
  const result = await db.query(
    `SELECT o.id
    FROM opportunities o
    ${query.joins.join('\n')}
    ${query.whereSql}
    ORDER BY ${orderBySql(filters.sort, filters.sortDirection)}
    LIMIT ${limitPlaceholder}
    OFFSET ${offsetPlaceholder}`,
    ...query.values,
  );
  return rowsFromResult(result)
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Load at most one current application and evaluation score for each supplied
 * opportunity. The lateral joins keep history cardinality inside PostgreSQL,
 * so browser-facing summaries never hydrate an unbounded set of old rows.
 */
export async function listLatestOpportunityRelatedContext(
  opportunityIds: readonly string[],
): Promise<LatestOpportunityRelatedContextRow[]> {
  const ids = Array.from(new Set(opportunityIds.filter(Boolean))).slice(0, 25);
  if (ids.length === 0) return [];

  const db = await queryDatabase();
  const result = await db.query(
    `SELECT
      o.id AS "opportunityId",
      latest_application.id AS "applicationId",
      latest_application.status AS "applicationStatus",
      latest_score.id AS "scoreId",
      latest_score.score,
      latest_score.recommendation,
      latest_score.summary AS "scoreSummary"
    FROM opportunities o
    LEFT JOIN LATERAL (
      SELECT a.id, a.status
      FROM applications a
      WHERE a.opportunity_id = o.id
      ORDER BY a.updated_at DESC
      LIMIT 1
    ) latest_application ON TRUE
    LEFT JOIN LATERAL (
      SELECT es.id, es.score, es.recommendation, es.summary
      FROM evaluation_scores es
      WHERE es.opportunity_id = o.id
        AND COALESCE(es.source_content_fingerprint, '') =
          COALESCE(o.source_content_fingerprint, '')
      ORDER BY es.updated_at DESC
      LIMIT 1
    ) latest_score ON TRUE
    WHERE o.id = ANY($1)
    LIMIT $2`,
    ids,
    ids.length,
  );
  return rowsFromResult(result) as LatestOpportunityRelatedContextRow[];
}

export async function listOpportunityFilterOptions(
  reviewFilter: string,
): Promise<OpportunityFilterOptions> {
  const db = await queryDatabase();
  const values: unknown[] = [];
  const review = reviewWhereSql(reviewFilter, values);
  const joins = review.needsApplication ? [latestApplicationJoinSql()] : [];
  const whereSql =
    review.where.length > 0 ? `WHERE ${review.where.join('\n AND ')}` : '';
  const result = await db.query(
    `WITH scoped AS (
      SELECT o.*
      FROM opportunities o
      ${joins.join('\n')}
      ${whereSql}
    )
    SELECT
      ARRAY(SELECT DISTINCT status FROM scoped WHERE status <> '' ORDER BY status) AS statuses,
      ARRAY(SELECT DISTINCT employment_type FROM scoped WHERE employment_type NOT IN ('', 'unknown') ORDER BY employment_type) AS "employmentTypes",
      ARRAY(SELECT DISTINCT work_mode FROM scoped WHERE work_mode NOT IN ('', 'unknown') ORDER BY work_mode) AS "workModes",
      ARRAY(SELECT DISTINCT seniority FROM scoped WHERE seniority NOT IN ('', 'unknown') ORDER BY seniority) AS seniorities,
      ARRAY(SELECT DISTINCT freshness FROM scoped WHERE freshness NOT IN ('', 'unknown') ORDER BY freshness) AS freshness,
      ARRAY(
        SELECT DISTINCT btrim(skill.value)
        FROM scoped,
        LATERAL unnest(
          regexp_split_to_array(
            concat_ws(',', COALESCE(scoped.required_skills, ''), COALESCE(scoped.preferred_skills, '')),
            E'[,\\n\\r]+'
          )
        ) AS skill(value)
        WHERE btrim(skill.value) <> ''
        ORDER BY btrim(skill.value)
      ) AS skills`,
    ...values,
  );
  const [row] = rowsFromResult(result);
  return {
    employmentTypes: sqlStringArray(row?.employmentTypes),
    freshness: sqlStringArray(row?.freshness),
    seniorities: sqlStringArray(row?.seniorities),
    skills: sqlStringArray(row?.skills),
    statuses: sqlStringArray(row?.statuses),
    workModes: sqlStringArray(row?.workModes),
  };
}
