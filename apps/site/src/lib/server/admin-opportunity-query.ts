import { createHash } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import {
  DECISION_REVIEW_STATUSES,
  type OpportunityFilterOptions,
  type OpportunityFilterState,
} from '$lib/opportunity-filters';
import { getDbConfig } from './db.js';
import { OPPORTUNITY_ASSESSMENT_VERSION } from './opportunity-assessment.js';
import type { WorkspaceSubject } from './workspace-subject.js';

/** Hidden from every default listing; selectable through an explicit filter. */
const ARCHIVED_OPPORTUNITY_STATUS = 'archived';
const ELIGIBILITY_FLAG_BY_BUCKET = new Map<string, number>([
  ['eligible', 1],
  ['sponsorship_possible', 2],
  ['location_restriction', 8],
  ['conflicting', 16],
  ['unknown', 32],
]);
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

export { OPPORTUNITY_TABLE_PAGE_SIZE } from '$lib/admin/resource-shell';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type OpportunityQueryDialect = 'postgres' | 'sqlite';

async function queryDatabase(): Promise<SmrtDatabase> {
  return getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
}

/**
 * The hosted list runs against PostgreSQL, while the packaged local app runs
 * the same list against SQLite. Keep the dialect choice at this raw-query
 * boundary: collection reads elsewhere stay engine-neutral.
 */
function opportunityQueryDialect(): OpportunityQueryDialect {
  return getDbConfig().type === 'sqlite' ? 'sqlite' : 'postgres';
}

type QueryResult =
  | { rows?: Record<string, unknown>[] }
  | Record<string, unknown>[];

export type OpportunityQuery = {
  candidateSkills: readonly string[];
  filters: OpportunityFilterState;
  reviewFilter: string;
  search?: string;
  /** Triage keeps currently excluded assessment projections behind other rows. */
  triageRejectDepriority?: boolean;
  /** Current private evidence and preferences that make ranking materialized scalars usable. */
  assessmentCandidateMaterialFingerprint?: string;
  assessmentPreferencesFingerprint?: string;
  /** Verified request subject for every candidate-owned score, app, and review. */
  workspaceSubject?: WorkspaceSubject;
};

export type WorkspaceOpportunityQuery = OpportunityQuery & {
  workspaceSubject: WorkspaceSubject & { profileId: string };
};

export type LatestOpportunityRelatedContextRow = {
  applicationId?: string;
  applicationStatus?: string;
  humanRating?: number | null;
  humanReviewNotes?: string;
  humanReviewStatus?: string;
  opportunityId: string;
  recommendation?: string;
  reviewedAt?: Date | string | null;
  reviewedByProfileId?: string;
  reviewedByUserId?: string;
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

/**
 * The embedded SQLite driver binds numbered placeholders in the order they
 * appear in SQL, while PostgreSQL binds by the numeric suffix. Our list SQL
 * deliberately renders joins before WHERE clauses, so a subject join can
 * contain `$9` before a filter's `$1`. Reorder the arguments once at this
 * boundary without renumbering SQL; each distinct placeholder keeps its
 * intended value on both engines.
 */
function sqliteArgumentsInSqlOrder(
  sql: string,
  values: readonly unknown[],
): unknown[] {
  const indexes = new Set<number>();
  const ordered: unknown[] = [];
  for (const match of sql.matchAll(/\$(\d+)/g)) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1 || indexes.has(index)) continue;
    indexes.add(index);
    ordered.push(values[index - 1]);
  }
  return ordered;
}

async function queryOpportunitySql(
  db: SmrtDatabase,
  dialect: OpportunityQueryDialect,
  sql: string,
  values: readonly unknown[],
): Promise<QueryResult> {
  const parameters =
    dialect === 'sqlite' ? sqliteArgumentsInSqlOrder(sql, values) : values;
  return (await db.query(sql, ...parameters)) as QueryResult;
}

function sqlStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
  }
  return typeof value === 'string' && value.length > 0
    ? value.split('\u001f').filter(Boolean)
    : [];
}

function safeHumanRating(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
    ? value
    : null;
}

function safeReviewStatus(value: unknown): string | undefined {
  return value === 'apply' ||
    value === 'archived' ||
    value === 'maybe' ||
    value === 'needs_input' ||
    value === 'reject'
    ? value
    : undefined;
}

function hasCandidateWorkspaceSubject(
  subject: WorkspaceSubject | undefined,
): subject is WorkspaceSubject & { profileId: string } {
  return Boolean(subject?.tenantId && subject.userId && subject.profileId);
}

function privateSubjectWhereSql(
  alias: string,
  subject: WorkspaceSubject | undefined,
  values: unknown[],
): string {
  if (!hasCandidateWorkspaceSubject(subject)) return 'FALSE';
  const tenantId = pushParam(values, subject.tenantId);
  const ownerUserId = pushParam(values, subject.userId);
  const candidateProfileId = pushParam(values, subject.profileId);
  return `${alias}.tenant_id = ${tenantId}
    AND ${alias}.owner_user_id = ${ownerUserId}
    AND ${alias}.candidate_profile_id = ${candidateProfileId}`;
}

function latestScoreJoinSql(
  dialect: OpportunityQueryDialect,
  workspaceSubject: WorkspaceSubject | undefined,
  values: unknown[],
  alias = 'latest',
): string {
  const currentScore = `COALESCE(es.source_content_fingerprint, '') =
            COALESCE(o.source_content_fingerprint, '')
          AND (
            COALESCE(es.created_by_profile_id, '') <> ''
            OR (
              COALESCE(o.scoring_material_fingerprint, '') <> ''
              AND COALESCE(es.scoring_material_fingerprint, '') =
                COALESCE(o.scoring_material_fingerprint, '')
            )
          )`;
  const scoreOrder = `CASE WHEN COALESCE(es.created_by_profile_id, '') <> '' THEN 0 ELSE 1 END,
        es.updated_at DESC`;
  if (dialect === 'sqlite') {
    // SQLite has no LATERAL join. Its correlated subquery in the join
    // condition expresses the same one-current-score relation without
    // multiplying opportunity rows.
    return `LEFT JOIN evaluation_scores ${alias}
      ON ${alias}.id = (
        SELECT es.id
        FROM evaluation_scores es
        WHERE es.opportunity_id = CAST(o.id AS TEXT)
          AND (${privateSubjectWhereSql('es', workspaceSubject, values)})
          AND ${currentScore}
        ORDER BY ${scoreOrder}
        LIMIT 1
      )`;
  }
  return `LEFT JOIN LATERAL (
    SELECT es.id, es.score, es.recommendation, es.summary
    FROM evaluation_scores es
    WHERE es.opportunity_id = CAST(o.id AS TEXT)
      AND (${privateSubjectWhereSql('es', workspaceSubject, values)})
      AND ${currentScore}
    ORDER BY ${scoreOrder}
    LIMIT 1
  ) ${alias} ON TRUE`;
}

/** Match the persisted recommendation vocabulary without making unknown values rejects. */
export function normalizeOpportunityRecommendation(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function latestApplicationJoinSql(
  dialect: OpportunityQueryDialect,
  workspaceSubject: WorkspaceSubject | undefined,
  values: unknown[],
): string {
  if (dialect === 'sqlite') {
    return `LEFT JOIN applications latest_application
      ON latest_application.id = (
        SELECT a.id
        FROM applications a
        WHERE a.opportunity_id = CAST(o.id AS TEXT)
          AND (${privateSubjectWhereSql('a', workspaceSubject, values)})
        ORDER BY a.updated_at DESC
        LIMIT 1
      )`;
  }
  return `LEFT JOIN LATERAL (
    SELECT a.id, a.status, a.resume_mode, a.cover_letter_mode
    FROM applications a
    WHERE a.opportunity_id = CAST(o.id AS TEXT)
      AND (${privateSubjectWhereSql('a', workspaceSubject, values)})
    ORDER BY a.updated_at DESC
    LIMIT 1
  ) latest_application ON TRUE`;
}

function latestReviewJoinSql(
  dialect: OpportunityQueryDialect,
  workspaceSubject: WorkspaceSubject | undefined,
  values: unknown[],
): string {
  const subjectWhere = privateSubjectWhereSql('d', workspaceSubject, values);
  if (dialect === 'sqlite') {
    return `LEFT JOIN decisions latest_review
      ON latest_review.id = (
        SELECT d.id
        FROM decisions d
        WHERE d.opportunity_id = CAST(o.id AS TEXT)
          AND (${subjectWhere})
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 1
      )`;
  }
  return `LEFT JOIN LATERAL (
    SELECT
      d.decision,
      d.human_rating,
      d.reason AS human_review_notes,
      d.created_at AS reviewed_at,
      d.decider_profile_id AS reviewed_by_profile_id,
      d.decider_user_id AS reviewed_by_user_id
    FROM decisions d
    WHERE d.opportunity_id = CAST(o.id AS TEXT)
      AND (${subjectWhere})
    ORDER BY d.created_at DESC NULLS LAST, d.id DESC
    LIMIT 1
  ) latest_review ON TRUE`;
}

/**
 * Assessment scalars are the only private values allowed to affect paging.
 * A score row is historical evidence for a rendered page, not an ordering
 * authority: preference or candidate-evidence changes make it stale.
 */
function latestAssessmentJoinSql(
  dialect: OpportunityQueryDialect,
  query: OpportunityQuery,
  values: unknown[],
): string {
  const candidateFingerprint = query.assessmentCandidateMaterialFingerprint;
  const preferencesFingerprint = query.assessmentPreferencesFingerprint;
  const currentAssessment =
    candidateFingerprint && preferencesFingerprint
      ? `${privateSubjectWhereSql('oa', query.workspaceSubject, values)}
          AND oa.opportunity_id = CAST(o.id AS TEXT)
          AND oa.status = 'current'
          AND oa.contract_version = ${pushParam(values, OPPORTUNITY_ASSESSMENT_VERSION)}
          AND oa.source_content_fingerprint = COALESCE(o.source_content_fingerprint, '')
          AND oa.source_content_version = COALESCE(o.source_content_version, 0)
          AND oa.candidate_material_fingerprint = ${pushParam(values, candidateFingerprint)}
          AND oa.preferences_fingerprint = ${pushParam(values, preferencesFingerprint)}`
      : 'FALSE';
  if (dialect === 'sqlite') {
    return `LEFT JOIN opportunity_assessments latest_assessment
      ON latest_assessment.id = (
        SELECT oa.id
        FROM opportunity_assessments oa
        WHERE ${currentAssessment}
        ORDER BY oa.updated_at DESC, oa.id DESC
        LIMIT 1
      )`;
  }
  return `LEFT JOIN LATERAL (
    SELECT
      oa.eligibility_bucket,
      oa.eligibility_priority,
      oa.excluded,
      oa.fit_score,
      oa.match_readiness
    FROM opportunity_assessments oa
    WHERE ${currentAssessment}
    ORDER BY oa.updated_at DESC NULLS LAST, oa.id DESC
    LIMIT 1
  ) latest_assessment ON TRUE`;
}

function normalizedReviewStatusSql(dialect: OpportunityQueryDialect): string {
  const status = `CASE
    WHEN latest_review.decision IS NULL THEN NULL
    WHEN latest_review.decision = 'accept_to_apply' THEN 'apply'
    WHEN latest_review.decision = 'archive' THEN 'archived'
    WHEN latest_review.decision = 'defer' THEN 'maybe'
    WHEN latest_review.decision = 'reject' THEN 'reject'
    ELSE 'needs_input'
  END`;
  return dialect === 'sqlite'
    ? `lower(trim(${status}))`
    : `lower(btrim(${status}))`;
}

function reviewWhereSql(
  reviewFilter: string,
  values: unknown[],
  workspaceSubject: WorkspaceSubject | undefined,
  dialect: OpportunityQueryDialect,
): { needsApplication: boolean; needsReview: boolean; where: string[] } {
  // Branch on the same value the fingerprint hashes: it trims, so `' all '`
  // must select no review filter rather than an equality that matches nothing.
  const review = reviewFilter.trim();
  if (!review || review === 'all') {
    return { needsApplication: false, needsReview: false, where: [] };
  }
  void workspaceSubject;
  const normalized = normalizedReviewStatusSql(dialect);
  if (review === 'missing_application_planning') {
    return {
      needsApplication: true,
      needsReview: true,
      where: [
        `${normalized} = ${pushParam(values, 'apply')}`,
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
      needsReview: true,
      where: [`COALESCE(${normalized}, '') NOT IN (${placeholders})`],
    };
  }
  return {
    needsApplication: false,
    needsReview: true,
    where: [`${normalized} = ${pushParam(values, review.toLowerCase())}`],
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
  dialect,
  filters,
  search,
  values,
}: Pick<OpportunityQuery, 'candidateSkills' | 'filters' | 'search'> & {
  dialect: OpportunityQueryDialect;
  values: unknown[];
}): { needsAssessment: boolean; needsReview: boolean; where: string[] } {
  const where: string[] = [];
  let needsAssessment = false;
  let needsReview = false;

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
        WHERE CAST(search_company.id AS TEXT) = o.company_id
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
      dialect === 'sqlite'
        ? `o.employment_type IN (${employmentTypes.map((value) => pushParam(values, value)).join(', ')})`
        : `o.employment_type = ANY(${pushParam(values, employmentTypes)}::text[])`,
    );
  }
  const workModes = normalizeQueryTerms(filters.workModes);
  if (workModes.length > 0) {
    where.push(
      dialect === 'sqlite'
        ? `o.work_mode IN (${workModes.map((value) => pushParam(values, value)).join(', ')})`
        : `o.work_mode = ANY(${pushParam(values, workModes)}::text[])`,
    );
  }
  const eligibilityBuckets = normalizeQueryTerms(
    filters.eligibilityBuckets,
  ).filter((bucket) => ELIGIBILITY_FLAG_BY_BUCKET.has(bucket));
  if (eligibilityBuckets.length > 0) {
    const assessmentBuckets = eligibilityBuckets.flatMap((bucket) => {
      switch (bucket) {
        case 'eligible':
          return ['eligible'];
        case 'sponsorship_possible':
          return ['sponsorship_possible'];
        case 'location_restriction':
          return ['location_restriction'];
        case 'conflicting':
          return ['conflicting'];
        case 'unknown':
          return ['unknown'];
        default:
          return [];
      }
    });
    const predicates: string[] = [];
    if (assessmentBuckets.length > 0) {
      needsAssessment = true;
      predicates.push(
        dialect === 'sqlite'
          ? `COALESCE(latest_assessment.eligibility_bucket, 'unknown') IN (${assessmentBuckets.map((bucket) => pushParam(values, bucket)).join(', ')})`
          : `COALESCE(latest_assessment.eligibility_bucket, 'unknown') = ANY(${pushParam(values, assessmentBuckets)}::text[])`,
      );
    }
    if (predicates.length > 0) where.push(`(${predicates.join(' OR ')})`);
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
    // Ratings live on the private review overlay, never on the global posting.
    needsReview = true;
    where.push(
      `latest_review.human_rating >= ${pushParam(values, filters.minRating)}`,
    );
  }
  if (filters.minScore !== null) {
    needsAssessment = true;
    where.push(
      `latest_assessment.match_readiness = 'assessable' AND latest_assessment.fit_score >= ${pushParam(values, filters.minScore)}`,
    );
  }
  if (filters.maxScore !== null) {
    needsAssessment = true;
    where.push(
      `latest_assessment.match_readiness = 'assessable' AND latest_assessment.fit_score <= ${pushParam(values, filters.maxScore)}`,
    );
  }

  return { needsAssessment, needsReview, where };
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
  options: {
    dialect: OpportunityQueryDialect;
    triageRejectDepriority?: boolean;
  },
): string {
  const sqlDirection = direction === 'asc' ? 'ASC' : 'DESC';
  const assessableFit = `CASE WHEN latest_assessment.match_readiness = 'assessable' THEN latest_assessment.fit_score ELSE NULL END`;
  switch (sort) {
    case 'eligibility':
      return `latest_assessment.eligibility_priority ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    case 'newest':
      return `COALESCE(o.posted_at, o.first_seen_at) ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    case 'score':
      return `${
        options.triageRejectDepriority
          ? 'CASE WHEN latest_assessment.excluded THEN 1 ELSE 0 END ASC, '
          : ''
      }${assessableFit} ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    case 'salary':
      return `COALESCE(o.salary_max, o.salary_min) ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    case 'rating':
      return `latest_review.human_rating ${sqlDirection} NULLS LAST, o.updated_at DESC, o.id ASC`;
    default:
      return `${opportunityStatusRankSql()} ASC, latest_assessment.eligibility_priority ASC NULLS LAST, ${assessableFit} DESC NULLS LAST, o.updated_at DESC, o.id ASC`;
  }
}

export function createOpportunityWhereSql(
  query: OpportunityQuery,
  dialect: OpportunityQueryDialect = 'postgres',
): {
  joins: string[];
  values: unknown[];
  whereSql: string;
} {
  const values: unknown[] = [];
  const review = reviewWhereSql(
    query.reviewFilter,
    values,
    query.workspaceSubject,
    dialect,
  );
  const filters = filterWhereSql({
    candidateSkills: query.candidateSkills,
    dialect,
    filters: query.filters,
    search: query.search,
    values,
  });
  const joins: string[] = [];
  if (filters.needsAssessment) {
    joins.push(latestAssessmentJoinSql(dialect, query, values));
  }
  if (review.needsApplication) {
    joins.push(
      latestApplicationJoinSql(dialect, query.workspaceSubject, values),
    );
  }
  if (review.needsReview || filters.needsReview) {
    joins.push(latestReviewJoinSql(dialect, query.workspaceSubject, values));
  }
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
    [
      'assessmentCandidateMaterialFingerprint',
      query.assessmentCandidateMaterialFingerprint ?? '',
    ],
    [
      'assessmentPreferencesFingerprint',
      query.assessmentPreferencesFingerprint ?? '',
    ],
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
    ['eligibilityBuckets', list(filters.eligibilityBuckets)],
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
  query: WorkspaceOpportunityQuery,
  { limit }: { limit: number },
): Promise<OpportunityMatchingRow[]> {
  if (!hasCandidateWorkspaceSubject(query.workspaceSubject)) return [];
  const db = await queryDatabase();
  const dialect = opportunityQueryDialect();
  const built = createOpportunityWhereSql(query, dialect);
  const limitPlaceholder = pushParam(built.values, limit);
  const sql = `SELECT o.id, o.updated_at AS "updatedAt"
    FROM opportunities o
    ${built.joins.join('\n')}
    ${built.whereSql}
    ORDER BY o.id ASC
    LIMIT ${limitPlaceholder}`;
  const result = await queryOpportunitySql(db, dialect, sql, built.values);
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
  workspaceSubject: WorkspaceSubject & { profileId: string },
): Promise<OpportunityMatchingRow[]> {
  if (!hasCandidateWorkspaceSubject(workspaceSubject)) return [];
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await queryDatabase();
  const dialect = opportunityQueryDialect();
  const values: unknown[] = [];
  const idWhere =
    dialect === 'sqlite'
      ? `o.id IN (${unique.map((id) => pushParam(values, id)).join(', ')})`
      : `o.id = ANY(${pushParam(values, unique)})`;
  const result = await queryOpportunitySql(
    db,
    dialect,
    `SELECT o.id, o.updated_at AS "updatedAt"
    FROM opportunities o
    WHERE ${idWhere}`,
    values,
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
  query: WorkspaceOpportunityQuery,
): Promise<number> {
  if (!hasCandidateWorkspaceSubject(query.workspaceSubject)) return 0;
  const db = await queryDatabase();
  const dialect = opportunityQueryDialect();
  const { joins, values, whereSql } = createOpportunityWhereSql(query, dialect);
  const result = await queryOpportunitySql(
    db,
    dialect,
    `SELECT COUNT(*) AS count
    FROM opportunities o
    ${joins.join('\n')}
    ${whereSql}`,
    values,
  );
  const [row] = rowsFromResult(result);
  return Number(row?.count ?? 0);
}

export async function listOpportunityPageIds({
  candidateSkills,
  assessmentCandidateMaterialFingerprint,
  assessmentPreferencesFingerprint,
  filters,
  limit,
  offset,
  reviewFilter,
  search,
  triageRejectDepriority,
  workspaceSubject,
}: WorkspaceOpportunityQuery & {
  limit: number;
  offset: number;
}): Promise<string[]> {
  if (!hasCandidateWorkspaceSubject(workspaceSubject)) return [];
  const db = await queryDatabase();
  const dialect = opportunityQueryDialect();
  const query = createOpportunityWhereSql(
    {
      candidateSkills,
      assessmentCandidateMaterialFingerprint,
      assessmentPreferencesFingerprint,
      filters,
      reviewFilter,
      search,
      workspaceSubject,
    },
    dialect,
  );
  const needsAssessmentForSort =
    filters.sort === 'best' ||
    filters.sort === 'eligibility' ||
    filters.sort === 'score';
  if (
    needsAssessmentForSort &&
    !query.joins.some((join) => join.includes('opportunity_assessments'))
  ) {
    query.joins.unshift(
      latestAssessmentJoinSql(
        dialect,
        {
          assessmentCandidateMaterialFingerprint,
          assessmentPreferencesFingerprint,
          candidateSkills,
          filters,
          reviewFilter,
          search,
          triageRejectDepriority,
          workspaceSubject,
        },
        query.values,
      ),
    );
  }
  if (
    filters.sort === 'rating' &&
    !query.joins.some((join) => join.includes('latest_review'))
  ) {
    query.joins.push(
      latestReviewJoinSql(dialect, workspaceSubject, query.values),
    );
  }
  const limitPlaceholder = pushParam(query.values, limit);
  const offsetPlaceholder = pushParam(query.values, offset);
  const sql = `SELECT o.id
    FROM opportunities o
    ${query.joins.join('\n')}
    ${query.whereSql}
    ORDER BY ${orderBySql(filters.sort, filters.sortDirection, {
      dialect,
      triageRejectDepriority:
        triageRejectDepriority && filters.sort === 'score',
    })}
    LIMIT ${limitPlaceholder}
    OFFSET ${offsetPlaceholder}`;
  const result = await queryOpportunitySql(db, dialect, sql, query.values);
  return rowsFromResult(result)
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Current evaluation score context for the bounded local triage collection.
 *
 * This is display-only hydration after a page has already been selected by a
 * current assessment projection. It cannot be used for filtering or ranking.
 */
export async function listCurrentOpportunityScores(
  opportunityIds: readonly string[],
  workspaceSubject: WorkspaceSubject & { profileId: string },
): Promise<Map<string, { recommendation: string; score: number | null }>> {
  const requestedIds = [...new Set(opportunityIds.filter(Boolean))];
  const requestedIdSet = new Set(requestedIds);
  const scores = new Map<
    string,
    { recommendation: string; score: number | null }
  >();
  if (
    requestedIds.length === 0 ||
    !hasCandidateWorkspaceSubject(workspaceSubject)
  ) {
    return scores;
  }

  const dialect = opportunityQueryDialect();
  const db = await queryDatabase();
  // Keep SQLite safely below its conservative bind-variable floor, while the
  // local triage cap still bounds this to two small requests at most.
  for (let start = 0; start < requestedIds.length; start += 500) {
    const values: unknown[] = [];
    const placeholders = requestedIds
      .slice(start, start + 500)
      .map((id) => pushParam(values, id))
      .join(', ');
    const sql = `SELECT CAST(o.id AS TEXT) AS "opportunityId", latest.score, latest.recommendation
      FROM opportunities o
      ${latestScoreJoinSql(dialect, workspaceSubject, values)}
      WHERE CAST(o.id AS TEXT) IN (${placeholders})`;
    const result = await queryOpportunitySql(db, dialect, sql, values);
    for (const row of rowsFromResult(result)) {
      const id = row.opportunityId;
      if (typeof id !== 'string' || !requestedIdSet.has(id)) continue;
      scores.set(id, {
        recommendation: normalizeOpportunityRecommendation(row.recommendation),
        score: typeof row.score === 'number' ? row.score : null,
      });
    }
  }
  return scores;
}

/**
 * Load at most one current subject-owned application, evaluation score, and
 * decision overlay for each supplied opportunity. The joins run after paging,
 * so browser-facing summaries never hydrate unbounded private history.
 */
export async function listLatestOpportunityRelatedContext(
  opportunityIds: readonly string[],
  workspaceSubject: WorkspaceSubject & { profileId: string },
): Promise<LatestOpportunityRelatedContextRow[]> {
  const ids = Array.from(new Set(opportunityIds.filter(Boolean))).slice(0, 25);
  if (ids.length === 0 || !hasCandidateWorkspaceSubject(workspaceSubject)) {
    return [];
  }

  const db = await queryDatabase();
  const dialect = opportunityQueryDialect();
  const values: unknown[] = [];
  const idsWhere =
    dialect === 'sqlite'
      ? `CAST(o.id AS TEXT) IN (${ids.map((id) => pushParam(values, id)).join(', ')})`
      : `o.id = ANY(${pushParam(values, ids)})`;
  const applicationJoin = latestApplicationJoinSql(
    dialect,
    workspaceSubject,
    values,
  );
  const scoreJoin = latestScoreJoinSql(
    dialect,
    workspaceSubject,
    values,
    'latest_score',
  );
  const reviewJoin = latestReviewJoinSql(dialect, workspaceSubject, values);
  const reviewContextColumns =
    dialect === 'sqlite'
      ? `latest_review.reason AS "humanReviewNotes",
      latest_review.created_at AS "reviewedAt",
      latest_review.decider_profile_id AS "reviewedByProfileId",
      latest_review.decider_user_id AS "reviewedByUserId"`
      : `latest_review.human_review_notes AS "humanReviewNotes",
      latest_review.reviewed_at AS "reviewedAt",
      latest_review.reviewed_by_profile_id AS "reviewedByProfileId",
      latest_review.reviewed_by_user_id AS "reviewedByUserId"`;
  const limitPlaceholder = pushParam(values, ids.length);
  const sql = `SELECT
      o.id AS "opportunityId",
      latest_application.id AS "applicationId",
      latest_application.status AS "applicationStatus",
      latest_score.id AS "scoreId",
      latest_score.score,
      latest_score.recommendation,
      latest_score.summary AS "scoreSummary",
      latest_review.human_rating AS "humanRating",
      ${normalizedReviewStatusSql(dialect)} AS "humanReviewStatus",
      ${reviewContextColumns}
    FROM opportunities o
    ${applicationJoin}
    ${scoreJoin}
    ${reviewJoin}
    WHERE ${idsWhere}
    LIMIT ${limitPlaceholder}`;
  const result = await queryOpportunitySql(db, dialect, sql, values);
  return rowsFromResult(result).map((row) => ({
    ...row,
    humanRating: safeHumanRating(row.humanRating),
    humanReviewNotes:
      typeof row.humanReviewNotes === 'string' ? row.humanReviewNotes : '',
    humanReviewStatus: safeReviewStatus(row.humanReviewStatus),
    reviewedAt:
      row.reviewedAt instanceof Date || typeof row.reviewedAt === 'string'
        ? row.reviewedAt
        : null,
    reviewedByProfileId:
      typeof row.reviewedByProfileId === 'string'
        ? row.reviewedByProfileId
        : '',
    reviewedByUserId:
      typeof row.reviewedByUserId === 'string' ? row.reviewedByUserId : '',
  })) as LatestOpportunityRelatedContextRow[];
}

export async function listOpportunityFilterOptions(
  reviewFilter: string,
  workspaceSubject: WorkspaceSubject & { profileId: string },
): Promise<OpportunityFilterOptions> {
  if (!hasCandidateWorkspaceSubject(workspaceSubject)) {
    return {
      employmentTypes: [],
      freshness: [],
      seniorities: [],
      skills: [],
      statuses: [],
      workModes: [],
    };
  }
  const db = await queryDatabase();
  const values: unknown[] = [];
  const dialect = opportunityQueryDialect();
  const review = reviewWhereSql(
    reviewFilter,
    values,
    workspaceSubject,
    dialect,
  );
  const joins: string[] = [];
  if (review.needsApplication) {
    joins.push(latestApplicationJoinSql(dialect, workspaceSubject, values));
  }
  if (review.needsReview) {
    joins.push(latestReviewJoinSql(dialect, workspaceSubject, values));
  }
  const whereSql =
    review.where.length > 0 ? `WHERE ${review.where.join('\n AND ')}` : '';
  if (dialect === 'sqlite') {
    const sql = `WITH RECURSIVE scoped AS (
        SELECT o.*
        FROM opportunities o
        ${joins.join('\n')}
        ${whereSql}
      ), skill_values(skill, rest) AS (
        SELECT '', COALESCE(required_skills, '') || ',' || COALESCE(preferred_skills, '') || ','
        FROM scoped
        UNION ALL
        SELECT trim(substr(rest, 1, instr(rest, ',') - 1)), substr(rest, instr(rest, ',') + 1)
        FROM skill_values
        WHERE rest <> ''
      )
      SELECT
        COALESCE((SELECT group_concat(status, char(31)) FROM (SELECT DISTINCT status FROM scoped WHERE status <> '' ORDER BY status)), '') AS statuses,
        COALESCE((SELECT group_concat(employment_type, char(31)) FROM (SELECT DISTINCT employment_type FROM scoped WHERE employment_type NOT IN ('', 'unknown') ORDER BY employment_type)), '') AS "employmentTypes",
        COALESCE((SELECT group_concat(work_mode, char(31)) FROM (SELECT DISTINCT work_mode FROM scoped WHERE work_mode NOT IN ('', 'unknown') ORDER BY work_mode)), '') AS "workModes",
        COALESCE((SELECT group_concat(seniority, char(31)) FROM (SELECT DISTINCT seniority FROM scoped WHERE seniority NOT IN ('', 'unknown') ORDER BY seniority)), '') AS seniorities,
        COALESCE((SELECT group_concat(freshness, char(31)) FROM (SELECT DISTINCT freshness FROM scoped WHERE freshness NOT IN ('', 'unknown') ORDER BY freshness)), '') AS freshness,
        COALESCE((SELECT group_concat(skill, char(31)) FROM (SELECT DISTINCT skill FROM skill_values WHERE skill <> '' ORDER BY skill)), '') AS skills`;
    const result = await queryOpportunitySql(db, dialect, sql, values);
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
  const sql = `WITH scoped AS (
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
      ) AS skills`;
  const result = await queryOpportunitySql(db, dialect, sql, values);
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
