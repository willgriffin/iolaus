import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase, type User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { DEFAULT_TRIAGE_SORT, TRIAGE_SORTS } from '$lib/admin/triage-session';
import {
  DEFAULT_OPPORTUNITY_FILTERS,
  matchesOpportunity,
  type OpportunityFilterState,
  sortOpportunities,
} from '$lib/opportunity-filters';
import {
  countOpportunityRecords,
  listLatestOpportunityRelatedContext,
  listOpportunityPageIds,
} from './admin-opportunity-query.js';
import {
  recordAgentAudit,
  recordExplicitOpportunityDecision,
} from './application-workflow.js';
import { getDbConfig } from './db.js';
import { loadOpportunityDetails } from './opportunity-details.js';
import { sweepInactiveSourceOpportunities } from './opportunity-sweep.js';
import { recordPostingPreflight } from './posting-preflight.js';
import {
  latestPostingPreflightStatus,
  postingPreflightStatusFromAgentRun,
} from './posting-preflight-status.js';
import {
  createPublicHttpsFetch,
  PUBLIC_HTTPS_TIMEOUT_MS,
  validatePublicHttpsUrl,
} from './public-https.js';
import { getCollection } from './smrt.js';
import { mergeOpportunityCrawlReferences } from './source-crawl-opportunity-integrity.js';
import {
  KeyedLockTimeoutError,
  withSqliteOperationLock,
} from './sqlite-operation-lock.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};

type Collection = {
  create: (payload: Record<string, unknown>) => Promise<MutableRecord>;
  delete: (id: string) => Promise<boolean>;
  get: (id: string) => Promise<MutableRecord | null>;
  list: (options?: Record<string, unknown>) => Promise<MutableRecord[]>;
};

type Actor = Pick<User, 'id'>;
type ResolvedDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

const opportunityImportDatabase = new AsyncLocalStorage<ResolvedDatabase>();
const opportunityImportDatabaseProxy = new Proxy({} as ResolvedDatabase, {
  get(_target, property) {
    const database = opportunityImportDatabase.getStore();
    if (!database) {
      throw new Error('Import database accessed outside its transaction.');
    }
    const value = Reflect.get(database, property, database);
    return typeof value === 'function' ? value.bind(database) : value;
  },
  getOwnPropertyDescriptor(_target, property) {
    const database = opportunityImportDatabase.getStore();
    if (!database) return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(database, property);
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
  has(_target, property) {
    const database = opportunityImportDatabase.getStore();
    return database ? Reflect.has(database, property) : false;
  },
  ownKeys() {
    return Reflect.ownKeys(opportunityImportDatabase.getStore() ?? {});
  },
});

const DECISIONS = ['apply', 'maybe', 'reject'] as const;
const REVIEW_FILTERS = ['all', 'unsorted', ...DECISIONS] as const;
const WORK_MODES = ['all', 'remote', 'hybrid', 'onsite', 'unknown'] as const;
const EMPLOYMENT_TYPES = [
  'all',
  'full_time',
  'contract',
  'fractional',
  'advisory',
  'founder',
  'unknown',
] as const;
const SORTS = ['best', 'newest', 'score', 'salary', 'rating'] as const;
const SORT_DIRECTIONS = ['asc', 'desc'] as const;
const TEXT_LIST_MAX_ENTRIES = 40;
const TEXT_LIST_MAX_ENTRY_LENGTH = 240;
const TEXT_LIST_MAX_TOTAL_LENGTH = 4_000;
const TEXT_LIST_MAX_SOURCE_LENGTH = 12_000;
const LOCAL_BROWSE_RECORD_LIMIT = 1_001;
const LOCAL_RELATED_HISTORY_PER_OPPORTUNITY = 25;
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function collection(className: string): Promise<Collection> {
  const database = opportunityImportDatabase.getStore();
  return getCollection(
    className,
    database ? { db: opportunityImportDatabaseProxy } : undefined,
  ) as unknown as Promise<Collection>;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 2000,
): string {
  const text = stringValue(value);
  if (!text) error(400, `${label} is required.`);
  if (text.length > maxLength) {
    error(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const text = stringValue(value);
  if (text.length > maxLength) {
    error(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    error(400, `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    error(400, `${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return number;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  error(400, 'Boolean filters must be true or false.');
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
  label: string,
): T[number] {
  const text = stringValue(value) || fallback;
  if (!allowed.includes(text as T[number])) {
    error(400, `Invalid ${label}.`);
  }
  return text as T[number];
}

function textList(value: unknown): string[] {
  const entries: string[] = [];
  let remaining = TEXT_LIST_MAX_TOTAL_LENGTH;
  for (const raw of stringValue(value)
    .slice(0, TEXT_LIST_MAX_SOURCE_LENGTH)
    .split(/[\n,]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const maximum = Math.min(TEXT_LIST_MAX_ENTRY_LENGTH, remaining);
    const bounded =
      entry.length <= maximum
        ? entry
        : maximum === 1
          ? '…'
          : `${entry.slice(0, maximum - 1)}…`;
    if (!bounded) break;
    entries.push(bounded);
    remaining -= bounded.length;
    if (entries.length >= TEXT_LIST_MAX_ENTRIES || remaining <= 0) break;
  }
  return entries;
}

function limitedText(value: unknown, maximum: number): string {
  const text = stringValue(value);
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

async function requirePublicPostingUrl(
  value: unknown,
  deadlineAt: number,
): Promise<string> {
  const raw = requiredString(value, 'Posting URL', 2048);
  try {
    const { url } = await validatePublicHttpsUrl(raw, undefined, deadlineAt);
    url.hash = '';
    return url.toString();
  } catch (cause) {
    error(
      400,
      cause instanceof Error ? cause.message : 'Posting URL is not safe.',
    );
  }
}

async function withOpportunityImportLock<T>(
  url: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockKey = `job-opportunity-import:${createHash('sha256').update(url).digest('hex')}`;
  const activeTransaction = opportunityImportDatabase.getStore();
  if (activeTransaction) {
    if (getDbConfig().type === 'sqlite') return await action();
    await activeTransaction.query("SET LOCAL lock_timeout = '15s'");
    await activeTransaction.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
      lockKey,
    ]);
    return await action();
  }

  const database =
    getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
  if (typeof database.transaction !== 'function') {
    throw new Error(
      'Opportunity imports require transactional database support.',
    );
  }
  const transaction = database.transaction.bind(database);
  const run = async () =>
    await transaction(async (transactionDatabase) =>
      opportunityImportDatabase.run(transactionDatabase, async () => {
        if (getDbConfig().type !== 'sqlite') {
          await transactionDatabase.query("SET LOCAL lock_timeout = '15s'");
          await transactionDatabase.query(
            'SELECT pg_advisory_xact_lock(hashtext(?))',
            [lockKey],
          );
        }
        return await action();
      }),
    );
  if (getDbConfig().type !== 'sqlite') return await run();

  try {
    return await withSqliteOperationLock(lockKey, run);
  } catch (cause) {
    if (cause instanceof KeyedLockTimeoutError) error(409, cause.message);
    throw cause;
  }
}

function opportunityAdminUrl(id: string): string {
  return `/admin/opportunities/${encodeURIComponent(id)}/`;
}

function applicationAdminUrl(id: string): string {
  return `/admin/applications/${encodeURIComponent(id)}/`;
}

async function relatedContext(opportunities: MutableRecord[]) {
  const ids = Array.from(
    new Set(
      opportunities.map((record) => stringValue(record.id)).filter(Boolean),
    ),
  );
  const companyIds = Array.from(
    new Set(
      opportunities
        .map((record) => stringValue(record.companyId))
        .filter(Boolean),
    ),
  );
  if (ids.length === 0) {
    return {
      applications: new Map<string, Record<string, unknown>>(),
      companies: new Map<string, Record<string, unknown>>(),
      scores: new Map<string, Record<string, unknown>>(),
    };
  }

  const [relatedRows, companies] = await Promise.all([
    getDbConfig().type === 'sqlite'
      ? localLatestOpportunityRelatedContext(opportunities, ids)
      : listLatestOpportunityRelatedContext(ids),
    companyIds.length > 0
      ? (await collection('Company')).list({
          limit: companyIds.length,
          where: { 'id in': companyIds },
        })
      : Promise.resolve([]),
  ]);

  const companyById = new Map<string, Record<string, unknown>>();
  for (const company of companies) {
    const serialized = jsonRecord(company);
    const id = stringValue(serialized.id);
    if (id) companyById.set(id, serialized);
  }

  const applications = new Map<string, Record<string, unknown>>();
  const scores = new Map<string, Record<string, unknown>>();
  for (const row of relatedRows) {
    const opportunityId = stringValue(row.opportunityId);
    if (!opportunityId) continue;
    const applicationId = stringValue(row.applicationId);
    if (applicationId) {
      applications.set(opportunityId, {
        id: applicationId,
        opportunityId,
        status: stringValue(row.applicationStatus),
      });
    }
    const scoreId = stringValue(row.scoreId);
    if (scoreId) {
      scores.set(opportunityId, {
        id: scoreId,
        opportunityId,
        recommendation: stringValue(row.recommendation),
        score: row.score ?? null,
        summary: stringValue(row.scoreSummary),
      });
    }
  }

  return {
    applications,
    companies: companyById,
    scores,
  };
}

async function localLatestOpportunityRelatedContext(
  opportunities: MutableRecord[],
  opportunityIds: string[],
) {
  const historyLimit =
    opportunityIds.length * LOCAL_RELATED_HISTORY_PER_OPPORTUNITY;
  const [applications, scores] = await Promise.all([
    (await collection('Application')).list({
      limit: historyLimit,
      orderBy: 'updated_at DESC',
      where: { 'opportunityId in': opportunityIds },
    }),
    (await collection('EvaluationScore')).list({
      limit: historyLimit,
      orderBy: 'updated_at DESC',
      where: { 'opportunityId in': opportunityIds },
    }),
  ]);
  const opportunityById = new Map(
    opportunities.map((opportunity) => [
      stringValue(opportunity.id),
      opportunity,
    ]),
  );
  const applicationByOpportunity = new Map<string, MutableRecord>();
  for (const application of applications) {
    const opportunityId = stringValue(application.opportunityId);
    if (opportunityId && !applicationByOpportunity.has(opportunityId)) {
      applicationByOpportunity.set(opportunityId, application);
    }
  }
  const scoreByOpportunity = new Map<string, MutableRecord>();
  for (const score of scores) {
    const opportunityId = stringValue(score.opportunityId);
    const opportunity = opportunityById.get(opportunityId);
    if (
      opportunityId &&
      opportunity &&
      !scoreByOpportunity.has(opportunityId) &&
      stringValue(score.sourceContentFingerprint) ===
        stringValue(opportunity.sourceContentFingerprint)
    ) {
      scoreByOpportunity.set(opportunityId, score);
    }
  }
  return opportunityIds.map((opportunityId) => {
    const application = applicationByOpportunity.get(opportunityId);
    const score = scoreByOpportunity.get(opportunityId);
    return {
      applicationId: stringValue(application?.id),
      applicationStatus: stringValue(application?.status),
      opportunityId,
      recommendation: stringValue(score?.recommendation),
      score: typeof score?.score === 'number' ? score.score : null,
      scoreId: stringValue(score?.id),
      scoreSummary: stringValue(score?.summary),
    };
  });
}

function localReviewMatches(
  record: MutableRecord,
  reviewFilter: string,
): boolean {
  const review = stringValue(record.humanReviewStatus).toLowerCase();
  if (!reviewFilter || reviewFilter === 'all') return true;
  if (reviewFilter === 'unsorted') {
    return !DECISIONS.includes(review as (typeof DECISIONS)[number]);
  }
  return review === reviewFilter;
}

function localSearchMatches(
  record: MutableRecord,
  companyName: string,
  search: string | undefined,
): boolean {
  const needle = stringValue(search).toLowerCase();
  if (!needle) return true;
  return [
    record.title,
    record.descriptionSummary,
    record.requiredSkills,
    record.preferredSkills,
    record.locations,
    record.postingUrl,
    companyName,
  ].some((value) => stringValue(value).toLowerCase().includes(needle));
}

async function browseLocalJobOpportunities({
  decision,
  filters,
  limit,
  offset,
  search,
}: {
  decision: string;
  filters: OpportunityFilterState;
  limit: number;
  offset: number;
  search: string | undefined;
}) {
  const opportunityCollection = await collection('Opportunity');
  const rawRecords = await opportunityCollection.list({
    limit: LOCAL_BROWSE_RECORD_LIMIT,
    orderBy: 'updated_at DESC',
  });
  if (rawRecords.length >= LOCAL_BROWSE_RECORD_LIMIT) {
    throw new Error(
      `Local opportunity browsing is bounded to ${LOCAL_BROWSE_RECORD_LIMIT - 1} records; archive or deploy this data set before continuing.`,
    );
  }
  const context = await relatedContext(rawRecords);
  const enriched = rawRecords.map((record) => {
    const id = stringValue(record.id);
    const score = context.scores.get(id);
    return {
      ...jsonRecord(record),
      latestScore: score?.score ?? null,
      save: record.save,
    } as MutableRecord;
  });
  const matches = enriched.filter((record) => {
    const company = context.companies.get(stringValue(record.companyId));
    if (filters.status === 'all' && stringValue(record.status) === 'archived') {
      return false;
    }
    return (
      localReviewMatches(record, decision) &&
      localSearchMatches(record, stringValue(company?.name), search) &&
      matchesOpportunity(record, filters, { hasSkill: () => false })
    );
  });
  const ordered = sortOpportunities(
    matches,
    filters.sort,
    filters.sortDirection,
  );
  const page = ordered.slice(offset, offset + limit) as MutableRecord[];
  return {
    items: page.map((record) => opportunitySummary(record, context)),
    limit,
    offset,
    total: ordered.length,
    nextOffset:
      offset + page.length < ordered.length ? offset + page.length : null,
  };
}

function opportunitySummary(
  record: MutableRecord,
  context: Awaited<ReturnType<typeof relatedContext>>,
) {
  const id = stringValue(record.id);
  const application = context.applications.get(id);
  const company = context.companies.get(stringValue(record.companyId));
  const score = context.scores.get(id);
  const applicationId = stringValue(application?.id);
  return {
    id,
    title: stringValue(record.title) || 'Untitled opportunity',
    company: stringValue(company?.name),
    locations: textList(record.locations),
    workMode: stringValue(record.workMode),
    employmentType: stringValue(record.employmentType),
    seniority: stringValue(record.seniority),
    status: stringValue(record.status),
    decision: stringValue(record.humanReviewStatus),
    freshness: stringValue(record.freshness),
    postedAt: record.postedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    salary: {
      currency: stringValue(record.currency),
      minimum: record.salaryMin ?? null,
      maximum: record.salaryMax ?? null,
    },
    score: score?.score ?? null,
    recommendation: stringValue(score?.recommendation),
    humanRating: record.humanRating ?? null,
    summary: limitedText(record.descriptionSummary, 1200),
    requiredSkills: textList(record.requiredSkills),
    postingUrl: stringValue(record.postingUrl),
    application: applicationId
      ? {
          id: applicationId,
          status: stringValue(application?.status),
          adminUrl: applicationAdminUrl(applicationId),
        }
      : null,
    adminUrl: opportunityAdminUrl(id),
  };
}

export async function browseJobOpportunities(input: Record<string, unknown>) {
  const query = optionalString(input.query, 'Search query', 200);
  const limit = boundedInteger(input.limit, 'Limit', 1, 25, 10);
  const offset = boundedInteger(input.offset, 'Offset', 0, 1000, 0);
  const decision = enumValue(
    input.decision,
    REVIEW_FILTERS,
    'all',
    'decision filter',
  );
  const workMode = enumValue(input.workMode, WORK_MODES, 'all', 'work mode');
  const employmentType = enumValue(
    input.employmentType,
    EMPLOYMENT_TYPES,
    'all',
    'employment type',
  );
  const filters = {
    ...DEFAULT_OPPORTUNITY_FILTERS,
    excludeExpired: booleanValue(input.excludeExpired, true),
    employmentTypes: employmentType === 'all' ? [] : [employmentType],
    minRating: boundedNumber(input.minRating, 'Minimum rating', 1, 10),
    minScore: boundedNumber(input.minScore, 'Minimum score', 0, 100),
    postedWithinDays:
      input.postedWithinDays === undefined || input.postedWithinDays === ''
        ? null
        : boundedInteger(
            input.postedWithinDays,
            'Posted-within days',
            1,
            365,
            90,
          ),
    sort: enumValue(input.sort, SORTS, 'best', 'sort'),
    sortDirection: enumValue(
      input.sortDirection,
      SORT_DIRECTIONS,
      'desc',
      'sort direction',
    ),
    status: optionalString(input.status, 'Status', 40) || 'all',
    workModes: workMode === 'all' ? [] : [workMode],
  };

  const search = query || undefined;
  if (getDbConfig().type === 'sqlite') {
    return browseLocalJobOpportunities({
      decision,
      filters,
      limit,
      offset,
      search,
    });
  }
  const [total, ids] = await Promise.all([
    countOpportunityRecords({
      candidateSkills: [],
      filters,
      reviewFilter: decision,
      search,
    }),
    listOpportunityPageIds({
      candidateSkills: [],
      filters,
      limit,
      offset,
      reviewFilter: decision,
      search,
    }),
  ]);
  const opportunityCollection = await collection('Opportunity');
  const records =
    ids.length > 0
      ? await opportunityCollection.list({ where: { 'id in': ids } })
      : [];
  const byId = new Map(
    records.map((record) => [stringValue(record.id), record]),
  );
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((record): record is MutableRecord => Boolean(record));
  const context = await relatedContext(ordered);

  return {
    items: ordered.map((record) => opportunitySummary(record, context)),
    limit,
    offset,
    total,
    nextOffset:
      offset + ordered.length < total ? offset + ordered.length : null,
  };
}

/**
 * The agent-facing half of the one-at-a-time triage view (issue #425): the
 * single highest-scoring undecided opportunity under the shared triage preset.
 *
 * There is deliberately no server-side skip list — an agent has no session to
 * hold one — so passing on a candidate means asking again with a higher
 * `offset`. The verdict itself still goes through `job_search_record_decision`,
 * the one audited decision path.
 */
export async function nextJobTriageCandidate(input: Record<string, unknown>) {
  // Loaded on demand: the triage queue reaches the admin resource loaders for
  // record hydration, and this module must stay cheap for every other tool.
  const { applyTriagePreset, nextTriageCandidate } = await import(
    './opportunity-triage.js'
  );
  const query = optionalString(input.query, 'Search query', 200);
  const offset = boundedInteger(input.offset, 'Offset', 0, 1000, 0);
  const workMode = enumValue(input.workMode, WORK_MODES, 'all', 'work mode');
  const employmentType = enumValue(
    input.employmentType,
    EMPLOYMENT_TYPES,
    'all',
    'employment type',
  );
  const filters = applyTriagePreset(
    {
      ...DEFAULT_OPPORTUNITY_FILTERS,
      employmentTypes: employmentType === 'all' ? [] : [employmentType],
      minRating: boundedNumber(input.minRating, 'Minimum rating', 1, 10),
      minScore: boundedNumber(input.minScore, 'Minimum score', 0, 100),
      postedWithinDays:
        input.postedWithinDays === undefined || input.postedWithinDays === ''
          ? null
          : boundedInteger(
              input.postedWithinDays,
              'Posted-within days',
              1,
              365,
              90,
            ),
      workModes: workMode === 'all' ? [] : [workMode],
    },
    // The same two orderings the admin deck offers, so an agent working the
    // queue and an operator working it see the same cards in the same order.
    enumValue(input.sort, TRIAGE_SORTS, DEFAULT_TRIAGE_SORT, 'sort'),
  );

  const result = await nextTriageCandidate({
    filters,
    offset,
    search: query || undefined,
  });
  const record = result.candidate as MutableRecord | null;
  const context = await relatedContext(record ? [record] : []);

  return {
    candidate: record ? opportunitySummary(record, context) : null,
    offset,
    position: result.position,
    remaining: result.remaining,
    total: result.total,
    next: record
      ? 'Record the verdict with job_search_record_decision, or ask again with a higher offset to pass on this candidate without recording anything.'
      : 'No undecided opportunity matches this filter; the triage queue is empty.',
  };
}

/**
 * The agent counterpart of the triage right-swipe (issue #425): record the
 * `maybe` verdict and queue the deep dive — opportunity intelligence, one
 * bounded posting check, and the company's `research_company` task — in the
 * same call.
 *
 * This is a mutation and it is **not** idempotent: calling it twice records a
 * second review write and a second posting check, even though the intelligence
 * job and the research task are themselves deduplicated. It never starts an
 * application: applying stays with `job_search_open_application` and the owner's
 * own admin surfaces.
 *
 * A follow-up step that fails is reported in `steps` (and `failed`); the
 * verdict is written first and is never rolled back by one.
 */
export async function digDeeperOnJobOpportunity(
  input: Record<string, unknown>,
  user: Actor,
) {
  const opportunityId = requiredString(
    input.opportunityId,
    'Opportunity id',
    128,
  );
  const reviewedByProfileId = optionalString(
    input.reviewedByProfileId,
    'Reviewer profile id',
    128,
  );
  const { digDeeperOnOpportunity } = await import('./opportunity-deep-dive.js');
  const result = await digDeeperOnOpportunity({
    // An absent field keeps what the opportunity already carries; only a
    // supplied one overwrites it.
    humanRating:
      input.rating === undefined
        ? undefined
        : boundedInteger(input.rating, 'Rating', 1, 10, 0),
    humanReviewNotes:
      input.reason === undefined
        ? undefined
        : optionalString(input.reason, 'Reason', 2000),
    opportunityId,
    reviewedByProfileId,
    user,
  });

  return {
    ...result,
    next:
      result.failed.length > 0
        ? 'The maybe verdict is recorded. Some follow-up work could not be queued; report the failed steps rather than re-deciding the opportunity.'
        : 'The maybe verdict is recorded and the deep dive is queued. Read the results later with job_search_inspect_opportunity; applying is a separate, owner-driven step.',
  };
}

export async function inspectJobOpportunity(input: Record<string, unknown>) {
  const opportunityId = requiredString(
    input.opportunityId,
    'Opportunity id',
    128,
  );
  const opportunities = await collection('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity) error(404, 'Opportunity not found.');
  const [context, preflight] = await Promise.all([
    relatedContext([opportunity]),
    latestPostingPreflightStatus(opportunityId),
  ]);
  const summary = opportunitySummary(opportunity, context);
  const company = context.companies.get(stringValue(opportunity.companyId));
  const score = context.scores.get(opportunityId);

  return {
    ...summary,
    preflight,
    apply: {
      method: stringValue(opportunity.applyMethod),
      url: stringValue(opportunity.applyUrl),
      instructions: limitedText(opportunity.applyInstructions, 2000),
    },
    compensationNotes: limitedText(opportunity.compNotes, 2000),
    company: company
      ? {
          id: stringValue(company.id),
          name: stringValue(company.name),
          websiteUrl: stringValue(company.websiteUrl),
          careersUrl: stringValue(company.careersUrl),
          stage: stringValue(company.stage),
          remotePolicy: stringValue(company.remotePolicy),
          productSummary: limitedText(company.productSummary, 2000),
          whyInteresting: limitedText(company.whyInteresting, 2000),
          concerns: limitedText(company.concerns, 2000),
          researchStatus: stringValue(company.researchStatus),
        }
      : null,
    description: limitedText(opportunity.descriptionRaw, 12_000),
    preferredSkills: textList(opportunity.preferredSkills),
    responsibilities: textList(opportunity.responsibilities),
    qualifications: textList(opportunity.qualifications),
    reviewNotes: limitedText(opportunity.humanReviewNotes, 4000),
    evaluation: score
      ? {
          id: stringValue(score.id),
          score: score.score ?? null,
          recommendation: stringValue(score.recommendation),
          summary: limitedText(score.summary, 3000),
        }
      : null,
  };
}

/**
 * Run one bounded live-posting preflight for one opportunity and record the
 * verdict as a `posting_preflight` audit. This never archives the opportunity,
 * never accepts an override, and never touches an application: the agent gets
 * fresh evidence, and every lifecycle transition still runs its own gate.
 */
export async function verifyJobPosting(
  input: Record<string, unknown>,
  user: Actor,
) {
  const opportunityId = requiredString(
    input.opportunityId,
    'Opportunity id',
    128,
  );
  const opportunity = await (await collection('Opportunity')).get(
    opportunityId,
  );
  if (!opportunity) error(404, 'Opportunity not found.');
  const result = await recordPostingPreflight({
    opportunity: jsonRecord(opportunity),
    user,
  });
  const preflight = postingPreflightStatusFromAgentRun({
    ...result.agentRun,
    output: {
      evidence: result.evidence,
      outcome: result.outcome,
      reason: result.reason,
    },
  });

  return {
    opportunityId,
    preflight,
    next:
      preflight.state === 'live'
        ? 'The posting is verified live; application work may proceed through the normal workflow.'
        : preflight.state === 'closed'
          ? 'The posting is closed. Do not prepare materials; the next lifecycle action will archive it.'
          : 'The posting could not be verified. Only the owner can decide whether to proceed, in the admin UI.',
  };
}

/**
 * Archive the opportunities that can never be re-seen: those under an inactive
 * source whose posting has not been seen for `notSeenDays`. Dry run unless the
 * caller explicitly passes `dryRun: false`.
 */
export async function sweepJobOpportunities(
  input: Record<string, unknown>,
  user: Actor,
) {
  const dryRun = booleanValue(input.dryRun, true);
  const result = await sweepInactiveSourceOpportunities({
    dryRun,
    notSeenDays: input.notSeenDays,
    user,
  });

  return {
    ...result,
    next: result.dryRun
      ? result.count === 0
        ? 'Nothing matches this filter; no apply is needed.'
        : 'Re-run with dryRun false to archive exactly these opportunities.'
      : 'The matched opportunities are archived and hidden from the default listings. Each row can be restored individually.',
  };
}

export async function importJobOpportunity(
  input: Record<string, unknown>,
  user: Actor,
) {
  const deadlineAt = Date.now() + PUBLIC_HTTPS_TIMEOUT_MS;
  const url = await requirePublicPostingUrl(input.url, deadlineAt);
  const title = optionalString(input.title, 'Title', 300);
  const refreshExisting = booleanValue(input.refreshExisting, false);
  const publicHttpsFetch = createPublicHttpsFetch({ deadlineAt });
  let failedCreated = false;
  let failedOpportunityId = '';
  let imported: {
    created: boolean;
    current: MutableRecord;
    details: { message: unknown; provider?: unknown; status: unknown };
    opportunityId: string;
  };

  try {
    imported = await withOpportunityImportLock(url, async () => {
      const opportunities = await collection('Opportunity');
      let [opportunity] = await opportunities.list({
        limit: 1,
        where: { postingUrl: url },
      });
      if (!opportunity) {
        [opportunity] = await opportunities.list({
          limit: 1,
          where: { canonicalUrl: url },
        });
      }

      let created = !opportunity;
      failedCreated = created;
      if (!opportunity) {
        const now = new Date();
        opportunity = await opportunities.create({
          canonicalUrl: url,
          firstSeenAt: now,
          freshness: 'unknown',
          humanReviewStatus: 'needs_input',
          lastSeenAt: now,
          postingUrl: url,
          status: 'found',
          title,
        });
        await opportunity.save();
      } else if (title && !stringValue(opportunity.title)) {
        opportunity.title = title;
        await opportunity.save();
      }

      let opportunityId = stringValue(opportunity.id);
      failedOpportunityId = opportunityId;
      const needsRefresh =
        created || refreshExisting || !stringValue(opportunity.descriptionRaw);
      let details = needsRefresh
        ? await loadOpportunityDetails(opportunityId, publicHttpsFetch, {
            db: opportunityImportDatabaseProxy,
            normalizeCanonicalUrl: async (canonicalUrl) =>
              canonicalUrl === url
                ? url
                : await requirePublicPostingUrl(canonicalUrl, deadlineAt),
          })
        : {
            message: 'Existing opportunity reused without refresh.',
            status: 'reused',
          };
      let current = (await opportunities.get(opportunityId)) ?? opportunity;
      const canonicalUrl = stringValue(current.canonicalUrl) || url;

      if (canonicalUrl !== url) {
        await withOpportunityImportLock(canonicalUrl, async () => {
          current = (await opportunities.get(opportunityId)) ?? current;
          const matches = [
            ...(await opportunities.list({
              limit: 25,
              where: { postingUrl: canonicalUrl },
            })),
            ...(await opportunities.list({
              limit: 25,
              where: { canonicalUrl },
            })),
          ];
          const existing = matches.find(
            (candidate) => stringValue(candidate.id) !== opportunityId,
          );
          if (!existing) return;

          // Detail resolution updated the alias row. Refresh the record that
          // will survive reconciliation before discarding or archiving it. The
          // outer transaction rolls the alias transition back if this fails.
          const survivorId = stringValue(existing.id);
          details = await loadOpportunityDetails(survivorId, publicHttpsFetch, {
            db: opportunityImportDatabaseProxy,
            normalizeCanonicalUrl: async (resolvedUrl) =>
              resolvedUrl === canonicalUrl
                ? canonicalUrl
                : await requirePublicPostingUrl(resolvedUrl, deadlineAt),
          });

          if (created) {
            await mergeOpportunityCrawlReferences(
              opportunityImportDatabaseProxy,
              {
                aliasId: opportunityId,
                deleteAlias: async () =>
                  await opportunities.delete(opportunityId),
                survivorId,
              },
            );
          } else {
            // Preserve a previously known alias row (and anything linked to
            // it), but take it out of the active job-search lifecycle.
            Object.assign(current, {
              canonicalUrl: url,
              humanReviewNotes: [
                stringValue(current.humanReviewNotes),
                `Archived URL alias after canonical reconciliation with opportunity ${survivorId}.`,
              ]
                .filter(Boolean)
                .join('\n'),
              humanReviewStatus: 'archived',
              postingUrl: url,
              status: 'archived',
            });
            await current.save();
          }
          current = (await opportunities.get(survivorId)) ?? existing;
          opportunityId = survivorId;
          created = false;
        });
      }

      await recordAgentAudit({
        application: { opportunityId },
        database: opportunityImportDatabaseProxy,
        input: { refreshExisting, url },
        output: {
          created,
          detailStatus: stringValue(details.status),
          opportunityId,
        },
        runType: 'webmcp_import_opportunity',
        status: 'completed',
        user,
      });

      return { created, current, details, opportunityId };
    });
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'Posting import failed.';
    await recordAgentAudit({
      application: { opportunityId: failedOpportunityId },
      error: message,
      input: { refreshExisting, url },
      output: {
        created: failedCreated,
        opportunityId: failedOpportunityId,
      },
      runType: 'webmcp_import_opportunity',
      status: 'failed',
      user,
    });
    throw cause;
  }

  const { created, current } = imported;
  const context = await relatedContext([current]);

  return {
    created,
    detail: {
      message: limitedText(imported.details.message, 2000),
      provider: stringValue(imported.details.provider),
      status: stringValue(imported.details.status),
    },
    opportunity: opportunitySummary(current, context),
  };
}

export async function recordJobOpportunityDecision(
  input: Record<string, unknown>,
  user: Actor,
) {
  const opportunityId = requiredString(
    input.opportunityId,
    'Opportunity id',
    128,
  );
  const decision = enumValue(
    requiredString(input.decision, 'Decision', 20),
    DECISIONS,
    'maybe',
    'decision',
  );
  const reason = optionalString(input.reason, 'Reason', 2000);
  const reviewedByProfileId = optionalString(
    input.reviewedByProfileId,
    'Reviewer profile id',
    128,
  );
  const result = await recordExplicitOpportunityDecision({
    deciderProfileId: reviewedByProfileId,
    decision,
    opportunityId,
    reason,
    user,
  });
  const opportunity = await (await collection('Opportunity')).get(
    opportunityId,
  );
  if (!opportunity) error(404, 'Opportunity not found after decision.');
  const context = await relatedContext([opportunity]);

  return {
    ...result,
    opportunity: opportunitySummary(opportunity, context),
    next:
      decision === 'apply'
        ? 'Review the local application workspace and prepare its packet.'
        : decision === 'maybe'
          ? 'Return to this opportunity when more information or time is available.'
          : 'No application will be prepared unless the decision is changed later.',
  };
}

export async function openJobApplication(
  input: Record<string, unknown>,
  user: Actor,
) {
  const opportunityId = requiredString(
    input.opportunityId,
    'Opportunity id',
    128,
  );
  const applications = await collection('Application');
  let [application] = await applications.list({
    limit: 1,
    orderBy: 'updated_at DESC',
    where: { opportunityId },
  });
  let created = !application;
  let decision: Record<string, unknown> | null = null;

  if (!application) {
    const result = await recordExplicitOpportunityDecision({
      deciderProfileId: optionalString(
        input.reviewedByProfileId,
        'Reviewer profile id',
        128,
      ),
      decision: 'apply',
      opportunityId,
      reason:
        optionalString(input.reason, 'Reason', 2000) ||
        'Opened through the WebMCP job-search workflow.',
      reuseExistingApplication: true,
      user,
    });
    created = !result.applicationReused;
    decision = (result.decision as Record<string, unknown> | null) ?? null;
    [application] = await applications.list({
      limit: 1,
      orderBy: 'updated_at DESC',
      where: { opportunityId },
    });
  }

  if (!application) {
    error(409, 'Application workflow did not create a local application.');
  }
  const applicationId = stringValue(application.id);
  return {
    application: {
      id: applicationId,
      opportunityId,
      status: stringValue(application.status),
      applyMethod: stringValue(application.applyMethod),
      applicationUrl: stringValue(application.applicationUrl),
      adminUrl: applicationAdminUrl(applicationId),
    },
    created,
    decision,
    next: 'Open the local admin link to review or prepare the application. External submission still requires the normal approval workflow.',
  };
}
