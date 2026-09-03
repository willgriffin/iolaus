import { createHash } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { SmrtJobCollection } from '@happyvertical/smrt-jobs';
import { getRequestScopedDatabase, type User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { recordAgentAudit } from './application-workflow.js';
import { getDbConfig } from './db.js';
import { resolveOpportunityIntelligenceBudgetConfig } from './opportunity-intelligence-config.js';
import { getCollection } from './smrt.js';
import {
  getSourceCrawlJobDedupeStatus,
  isSourceCrawlActiveJobConflict,
} from './source-crawl-job-schema.js';
import {
  assertActiveOperableRootSource,
  assertOperableRootSource,
  isOperableRootSource,
} from './source-provenance.js';
import { persistedSourceProvider } from './source-provider.js';
import {
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_METHOD,
  SOURCE_CRAWL_QUEUE,
  SOURCE_CRAWL_TIMEOUT_MS,
  SOURCE_JOB_OBJECT_TYPE,
  syncSourceSchedule,
} from './source-schedules.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<unknown>;
};

type RecordCollection = {
  create: (payload: Record<string, unknown>) => Promise<MutableRecord>;
  get: (id: string) => Promise<MutableRecord | null>;
  list: (options?: Record<string, unknown>) => Promise<MutableRecord[]>;
};

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type SourceLock = <T>(sourceId: string, work: () => Promise<T>) => Promise<T>;

export interface SourceWebMcpDependencies {
  audit?: typeof recordAgentAudit;
  crawlCollection?: RecordCollection;
  database?: SmrtDatabase;
  jobDedupeStatus?: typeof getSourceCrawlJobDedupeStatus;
  jobCollectionFactory?: (database: SmrtDatabase) => Promise<RecordCollection>;
  jobCollection?: RecordCollection;
  now?: () => Date;
  sourceCollection?: RecordCollection;
  sourceLock?: SourceLock;
  syncSchedule?: typeof syncSourceSchedule;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_CRAWL_STATUSES = [
  'completed',
  'completed_with_errors',
  'failed',
  'timed_out',
] as const;
const ACTIVE_JOB_STATUSES = ['pending', 'running'] as const;
const MAX_SOURCE_RESULTS = 25;
const MAX_SOURCE_SCAN = 500;
const MAX_CRAWL_RESULTS = 20;
const MAX_HISTORY_PER_SOURCE = 20;
const MAX_ERROR_SAMPLES = 5;
const MAX_ERROR_LENGTH = 300;
const MAX_LABEL_LENGTH = 200;
const MAX_ENUM_LENGTH = 64;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedText(value: unknown, maximum = MAX_ENUM_LENGTH): string {
  return stringValue(value).slice(0, maximum);
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    error(400, `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function requiredUuid(value: unknown, label: string): string {
  const id = stringValue(value);
  if (!UUID_PATTERN.test(id)) error(400, `${label} must be a UUID.`);
  return id;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const text = stringValue(value);
  if (!text) error(400, `${label} is required.`);
  if (text.length > maximum) {
    error(400, `${label} must be ${maximum} characters or fewer.`);
  }
  return text;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  error(400, `${label} must be true or false.`);
}

function stableUuid(namespace: string, value: string): string {
  const bytes = createHash('sha256')
    .update(`${namespace}\0${value}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const SENSITIVE_ERROR_KEY =
  /^(?:(?:proxy-)?authorization|(?:set-)?cookie)$|(?:^|[_ -])(?:token|key|password|passphrase|secret|credential|session)s?(?:$|[_ -])/i;
const SENSITIVE_COMPACT_ERROR_KEY =
  /^(?:(?:access|refresh|oauth|id)tokens?|apikeys?|clientsecrets?|secretaccesskeys?|sessionkeys?)$/i;
const SENSITIVE_NORMALIZED_ERROR_KEY =
  /^(?:authorization|proxyauthorization|cookie|setcookie|(?:access|refresh|oauth|auth|id)tokens?|apikeys?|clientsecrets?|secretaccesskeys?|sessionkeys?|(?:[a-z0-9]+)?(?:password|passphrase)s?|(?:private|signing)keys?)$/;
const SENSITIVE_CAMEL_ERROR_KEY =
  /^[A-Za-z][A-Za-z0-9]*(?:Token|Key|Password|Passphrase|Secret|Credential|Session)s?$/;
const SENSITIVE_CAMEL_PLAIN_KEY_SOURCE =
  '[A-Za-z][A-Za-z0-9]*(?:Token|Key|Password|Passphrase|Secret|Credential|Session)s?';
const SENSITIVE_PLAIN_KEY_SOURCE =
  '(?:proxy[\\s_-]?)?authorization|(?:set[\\s_-]?)?cookie|(?:x[\\s_-]?)?api[\\s_-]?keys?|(?:access|refresh|oauth|id)[\\s_-]?tokens?|client[\\s_-]?secrets?|secret[\\s_-]?access[\\s_-]?keys?|session[\\s_-]?keys?|(?:[a-z][a-z0-9]+)?(?:password|passphrase)s?|(?:private|signing)keys?|credentials?|secrets?|sessions?|tokens?|[a-z][a-z0-9]*(?:[\\s_-](?:tokens?|keys?|passwords?|passphrases?|secrets?|credentials?|sessions?))';
const SENSITIVE_PLAIN_QUOTED_VALUE = new RegExp(
  String.raw`\b(${SENSITIVE_PLAIN_KEY_SOURCE})\s*[:=]\s*(["'])[^\r\n]*?\2`,
  'gi',
);
const SENSITIVE_PLAIN_UNQUOTED_VALUE = new RegExp(
  String.raw`\b(${SENSITIVE_PLAIN_KEY_SOURCE})\s*[:=]\s*[^,;|\r\n]+`,
  'gi',
);
const SENSITIVE_PLAIN_SPACE_VALUE = new RegExp(
  String.raw`\b(${SENSITIVE_PLAIN_KEY_SOURCE})\s+(?:(?:is|was|equals?|value)\s+)?[^\s,;|\r\n]+`,
  'gi',
);
const SENSITIVE_CAMEL_PLAIN_QUOTED_VALUE = new RegExp(
  String.raw`\b(${SENSITIVE_CAMEL_PLAIN_KEY_SOURCE})\s*[:=]\s*(["'])[^\r\n]*?\2`,
  'g',
);
const SENSITIVE_CAMEL_PLAIN_UNQUOTED_VALUE = new RegExp(
  String.raw`\b(${SENSITIVE_CAMEL_PLAIN_KEY_SOURCE})\s*[:=]\s*[^,;|\r\n]+`,
  'g',
);
const SENSITIVE_CAMEL_PLAIN_SPACE_VALUE = new RegExp(
  String.raw`\b(${SENSITIVE_CAMEL_PLAIN_KEY_SOURCE})\s+(?:(?:is|was|equals?|value)\s+)?[^\s,;|\r\n]+`,
  'g',
);

function isSensitiveErrorKey(key: string): boolean {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    SENSITIVE_ERROR_KEY.test(key) ||
    SENSITIVE_COMPACT_ERROR_KEY.test(key) ||
    SENSITIVE_CAMEL_ERROR_KEY.test(key) ||
    SENSITIVE_NORMALIZED_ERROR_KEY.test(normalizedKey)
  );
}

function redactQuotedCredentials(line: string): string {
  return line.replace(
    /(["'])([^"'\r\n]{1,80})\1\s*[:=]\s*(["'])[^"'\r\n]*\3/gi,
    (match, keyQuote: string, key: string, valueQuote: string) =>
      isSensitiveErrorKey(key)
        ? `${keyQuote}${key}${keyQuote}:${valueQuote}[redacted]${valueQuote}`
        : match,
  );
}

function redactPlainCredentials(line: string): string {
  return line
    .replace(
      SENSITIVE_CAMEL_PLAIN_QUOTED_VALUE,
      (_match, key: string, quote: string) =>
        `${key}=${quote}[redacted]${quote}`,
    )
    .replace(
      SENSITIVE_CAMEL_PLAIN_UNQUOTED_VALUE,
      (_match, key: string) => `${key}=[redacted]`,
    )
    .replace(
      SENSITIVE_CAMEL_PLAIN_SPACE_VALUE,
      (_match, key: string) => `${key} [redacted]`,
    )
    .replace(
      SENSITIVE_PLAIN_QUOTED_VALUE,
      (_match, key: string, quote: string) =>
        `${key}=${quote}[redacted]${quote}`,
    )
    .replace(
      SENSITIVE_PLAIN_UNQUOTED_VALUE,
      (_match, key: string) => `${key}=[redacted]`,
    )
    .replace(
      SENSITIVE_PLAIN_SPACE_VALUE,
      (_match, key: string) => `${key} [redacted]`,
    );
}

function redactStructuredError(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredError);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveErrorKey(key) ? '[redacted]' : redactStructuredError(item),
    ]),
  );
}

function sanitizedErrors(value: unknown): string[] {
  const raw = stringValue(value);
  let sanitized = raw;
  try {
    sanitized = JSON.stringify(redactStructuredError(JSON.parse(raw)));
  } catch {
    // Operational errors are commonly plain text. The fallback below handles
    // header syntax and quoted JSON fragments embedded inside prose.
  }
  return sanitized
    .split(/\r?\n/)
    .map((line) =>
      redactPlainCredentials(
        redactQuotedCredentials(
          line
            .replace(
              /\b(bearer|basic|digest)\s*(["'])[^\r\n]*?\2/gi,
              '$1 $2[redacted]$2',
            )
            .replace(
              /\b(bearer|basic|digest)\s+[^\s,;|\r\n]+/gi,
              '$1 [redacted]',
            ),
        ),
      )
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, (raw) => {
          try {
            const url = new URL(raw);
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            return url.toString();
          } catch {
            return '[url redacted]';
          }
        })
        .slice(0, MAX_ERROR_LENGTH),
    )
    .filter(Boolean)
    .slice(0, MAX_ERROR_SAMPLES);
}

function safeCrawl(crawl: MutableRecord) {
  return {
    id: boundedText(crawl.id),
    sourceId: boundedText(crawl.sourceId),
    jobId: boundedText(crawl.jobId),
    status: boundedText(crawl.status),
    crawlType: boundedText(crawl.crawlType),
    startedAt: crawl.startedAt ?? null,
    finishedAt: crawl.finishedAt ?? null,
    counts: {
      candidates: numberValue(crawl.attemptCount ?? crawl.resultCount),
      created: numberValue(crawl.newOpportunityCount),
      duplicates: numberValue(crawl.duplicateCount),
      skipped: numberValue(crawl.skippedCount),
      errors: numberValue(crawl.failedPersistenceCount),
      reused: numberValue(crawl.reusedCount),
      relisted: numberValue(crawl.relistedCount),
      terminal: numberValue(crawl.terminalCount),
      pending: numberValue(crawl.pendingCount),
    },
    errors: sanitizedErrors(crawl.error),
  };
}

async function requestDatabase(
  dependencies: SourceWebMcpDependencies,
): Promise<SmrtDatabase> {
  return (
    dependencies.database ??
    getRequestScopedDatabase() ??
    (await resolveDatabase(getDbConfig()))
  );
}

async function collections(
  dependencies: SourceWebMcpDependencies,
  database: SmrtDatabase,
) {
  return {
    crawls:
      dependencies.crawlCollection ??
      ((await getCollection('SourceCrawl', {
        db: database,
      })) as unknown as RecordCollection),
    jobs:
      dependencies.jobCollection ??
      (dependencies.jobCollectionFactory
        ? await dependencies.jobCollectionFactory(database)
        : ((await SmrtJobCollection.create({
            db: database,
          })) as unknown as RecordCollection)),
    sources:
      dependencies.sourceCollection ??
      ((await getCollection('Source', {
        db: database,
      })) as unknown as RecordCollection),
  };
}

async function withDatabaseSourceLock<T>(
  database: SmrtDatabase,
  sourceId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!database.acquireSession) {
    error(503, 'Database-backed source crawl locking is unavailable.');
  }
  const session = await database.acquireSession();
  const lockKey = `webmcp-source-crawl:${sourceId}`;
  try {
    await session.query('SELECT pg_advisory_lock(hashtext(?))', [lockKey]);
    return await work();
  } finally {
    try {
      await session.query('SELECT pg_advisory_unlock(hashtext(?))', [lockKey]);
    } finally {
      await session.release();
    }
  }
}

async function terminalCrawlsForSource(
  crawlCollection: RecordCollection,
  sourceId: string,
  limit: number,
): Promise<MutableRecord[]> {
  const crawls = await crawlCollection.list({
    limit,
    orderBy: 'started_at DESC',
    where: { sourceId, status: [...TERMINAL_CRAWL_STATUSES] },
  });
  return crawls.filter((crawl) =>
    TERMINAL_CRAWL_STATUSES.includes(
      stringValue(crawl.status) as (typeof TERMINAL_CRAWL_STATUSES)[number],
    ),
  );
}

function aggregateHealth(crawls: MutableRecord[]) {
  return crawls.reduce(
    (summary, crawl) => {
      summary.runs += 1;
      summary.candidates += numberValue(
        crawl.attemptCount ?? crawl.resultCount,
      );
      summary.created += numberValue(crawl.newOpportunityCount);
      summary.duplicates += numberValue(crawl.duplicateCount);
      summary.skipped += numberValue(crawl.skippedCount);
      summary.errors += numberValue(crawl.failedPersistenceCount);
      if (['failed', 'timed_out'].includes(stringValue(crawl.status))) {
        summary.failedRuns += 1;
      }
      return summary;
    },
    {
      runs: 0,
      candidates: 0,
      created: 0,
      duplicates: 0,
      skipped: 0,
      errors: 0,
      failedRuns: 0,
    },
  );
}

export async function listRootSourceHealth(
  input: Record<string, unknown>,
  dependencies: SourceWebMcpDependencies = {},
) {
  const limit = boundedInteger(input.limit, 'limit', 1, MAX_SOURCE_RESULTS, 10);
  const historyLimit = boundedInteger(
    input.historyLimit,
    'historyLimit',
    1,
    MAX_HISTORY_PER_SOURCE,
    10,
  );
  const query = stringValue(input.query).toLowerCase();
  if (query.length > 120) error(400, 'query must be 120 characters or fewer.');
  const database = await requestDatabase(dependencies);
  const { crawls, sources } = await collections(dependencies, database);
  const candidates = await sources.list({
    limit: MAX_SOURCE_SCAN + 1,
    orderBy: 'updated_at DESC',
    where: { sourceRole: 'root' },
  });
  const scanTruncated = candidates.length > MAX_SOURCE_SCAN;
  const selected = candidates
    .slice(0, MAX_SOURCE_SCAN)
    .filter(
      (source) =>
        isOperableRootSource(source) &&
        (!query ||
          [source.name, source.type, source.provider]
            .map((value) => stringValue(value).toLowerCase())
            .some((value) => value.includes(query))),
    );
  const allItems = await Promise.all(
    selected.map(async (source) => {
      const history = await terminalCrawlsForSource(
        crawls,
        stringValue(source.id),
        historyLimit,
      );
      return {
        id: boundedText(source.id),
        name: boundedText(source.name, MAX_LABEL_LENGTH),
        type: boundedText(source.type),
        provider: persistedSourceProvider(source.provider),
        active: source.isActive === true,
        cadence: boundedText(source.refreshCadence),
        lastCheckedAt: source.lastCheckedAt ?? null,
        nextCheckAt: source.nextCheckAt ?? null,
        health: aggregateHealth(history),
      };
    }),
  );
  const providerMap = new Map<string, ReturnType<typeof aggregateHealth>>();
  for (const item of allItems) {
    if (item.provider === 'unknown') continue;
    const current = providerMap.get(item.provider) ?? aggregateHealth([]);
    for (const key of Object.keys(current) as Array<keyof typeof current>) {
      current[key] += item.health[key];
    }
    providerMap.set(item.provider, current);
  }
  const allProviders = [...providerMap.entries()]
    .map(([provider, health]) => ({ provider, ...health }))
    .sort(
      (left, right) =>
        right.created - left.created ||
        left.errors - right.errors ||
        left.provider.localeCompare(right.provider),
    );
  const providers = allProviders.slice(0, MAX_SOURCE_RESULTS);
  return {
    items: allItems.slice(0, limit),
    providers,
    limit,
    historyLimit,
    scan: {
      candidateLimit: MAX_SOURCE_SCAN,
      matched: allItems.length,
      providerProvenance: 'persisted_adapter_identity',
      providerTruncated: allProviders.length > providers.length,
      truncated: scanTruncated || allItems.length > limit,
    },
  };
}

export async function setRootSourceActive(
  input: Record<string, unknown>,
  user: Pick<User, 'id'>,
  dependencies: SourceWebMcpDependencies = {},
) {
  const sourceId = requiredUuid(input.sourceId, 'sourceId');
  const active = booleanValue(input.active, 'active');
  const reason = requiredText(input.reason, 'reason', 500);
  const database = await requestDatabase(dependencies);
  const transaction = database.transaction;
  if (!transaction) {
    error(503, 'Transactional source activation is unavailable.');
  }
  const lock =
    dependencies.sourceLock ??
    ((id, work) => withDatabaseSourceLock(database, id, work));
  const operation = await lock(sourceId, async () =>
    transaction(async (transactionDatabase) => {
      const sources =
        dependencies.sourceCollection ??
        ((await getCollection('Source', {
          db: transactionDatabase,
        })) as unknown as RecordCollection);
      const source = await sources.get(sourceId);
      if (!source) error(404, 'Source not found.');
      try {
        assertOperableRootSource(source);
      } catch (cause) {
        error(
          409,
          cause instanceof Error ? cause.message : 'Source is not operable.',
        );
      }
      source.isActive = active;
      await source.save();
      const schedule = dependencies.syncSchedule
        ? await dependencies.syncSchedule(source as never, {
            db: transactionDatabase,
          })
        : await syncSourceSchedule(source as never, {
            db: transactionDatabase,
          });
      await (dependencies.audit ?? recordAgentAudit)({
        database: transactionDatabase,
        input: { active, reason, sourceId },
        output: {
          active,
          scheduleEnabled: Boolean(schedule?.enabled),
          sourceId,
        },
        runType: 'webmcp_source_activation',
        sourceId,
        status: 'completed',
        user,
      });
      return { schedule, source };
    }),
  );
  const { schedule, source } = operation;
  return {
    sourceId,
    active,
    scheduleEnabled: Boolean(schedule?.enabled),
    nextCheckAt: source.nextCheckAt ?? null,
  };
}

async function createCrawlIfMissing(
  crawlCollection: RecordCollection,
  input: {
    crawlId: string;
    idempotencyKey: string;
    jobId: string;
    sourceId: string;
    userId: string;
  },
): Promise<MutableRecord> {
  const existing = await crawlCollection.get(input.crawlId);
  if (existing) {
    if (
      existing.id !== input.crawlId ||
      existing.sourceId !== input.sourceId ||
      existing.requestKey !== input.idempotencyKey ||
      typeof existing.jobId !== 'string' ||
      !existing.jobId ||
      existing.jobId !== input.jobId
    ) {
      error(409, 'The deterministic source crawl identifier is in use.');
    }
    return existing;
  }
  const budget = resolveOpportunityIntelligenceBudgetConfig();
  const crawl = await crawlCollection.create({
    crawlType: 'manual',
    id: input.crawlId,
    initiatedByUserId: input.userId,
    integrationMethod: 'webmcp',
    intelligenceCallLimit: budget.crawl.calls,
    intelligenceInputTokenLimit: budget.crawl.inputTokens,
    intelligenceSpendLimitMicros: budget.crawl.spendMicros,
    jobId: input.jobId,
    requestKey: input.idempotencyKey,
    sourceId: input.sourceId,
    startedAt: null,
    status: 'queued',
  });
  crawl.id = input.crawlId;
  await crawl.save();
  return crawl;
}

export async function enqueueRootSourceCrawl(
  input: Record<string, unknown>,
  user: Pick<User, 'id'>,
  dependencies: SourceWebMcpDependencies = {},
) {
  const sourceId = requiredUuid(input.sourceId, 'sourceId');
  const idempotencyKey = requiredText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  if (idempotencyKey.length < 8) {
    error(400, 'idempotencyKey must be at least 8 characters.');
  }
  const reason = requiredText(input.reason, 'reason', 500);
  const limit = boundedInteger(input.limit, 'limit', 1, 100, 50);
  const database = await requestDatabase(dependencies);
  const transaction = database.transaction;
  if (!transaction) {
    error(503, 'Transactional source crawl enqueue is unavailable.');
  }
  if (!dependencies.jobCollection) {
    const status = await (
      dependencies.jobDedupeStatus ?? getSourceCrawlJobDedupeStatus
    )(database);
    if (!status.activeIndexPresent) {
      error(503, 'Source crawl idempotency guard is unavailable.');
    }
  }
  const lock =
    dependencies.sourceLock ??
    ((id, work) => withDatabaseSourceLock(database, id, work));
  const operation = await lock(sourceId, async () =>
    transaction(async (transactionDatabase) => {
      const { crawls, jobs, sources } = await collections(
        dependencies,
        transactionDatabase,
      );
      const source = await sources.get(sourceId);
      if (!source) error(404, 'Source not found.');
      try {
        assertActiveOperableRootSource(source);
      } catch (cause) {
        error(
          409,
          cause instanceof Error ? cause.message : 'Source is not operable.',
        );
      }

      const now = dependencies.now?.() ?? new Date();
      const activeJobs = await jobs.list({
        limit: 10,
        orderBy: 'run_at ASC',
        where: {
          method: SOURCE_CRAWL_METHOD,
          objectId: sourceId,
          objectType: SOURCE_JOB_OBJECT_TYPE,
          queue: [SOURCE_CRAWL_QUEUE, SCHEDULED_SOURCE_QUEUE],
          status: [...ACTIVE_JOB_STATUSES],
        },
      });
      let job = activeJobs.find(
        (candidate) =>
          (candidate.args as Record<string, unknown>)?.idempotencyKey ===
          idempotencyKey,
      );
      if (!job && activeJobs.length > 0) {
        error(
          409,
          'This source already has an active crawl under a different idempotency key.',
        );
      }
      const storedActiveJobCrawlId = (
        job?.args as Record<string, unknown> | undefined
      )?.sourceCrawlId;
      const activeJobCrawlId =
        typeof storedActiveJobCrawlId === 'string'
          ? storedActiveJobCrawlId
          : '';
      if (
        job &&
        (typeof job.id !== 'string' ||
          !UUID_PATTERN.test(job.id) ||
          !UUID_PATTERN.test(activeJobCrawlId))
      ) {
        error(
          409,
          'The active source crawl job has an invalid durable binding.',
        );
      }
      const correlationKey = job
        ? `${sourceId}:${job.id}`
        : `${sourceId}:${idempotencyKey}`;
      const jobId = job?.id || stableUuid('source-webmcp-job', correlationKey);
      const crawlId =
        activeJobCrawlId || stableUuid('source-webmcp-crawl', correlationKey);
      const unsettledCrawls = await crawls.list({
        limit: 2,
        where: {
          sourceId,
          status: ['queued', 'running'],
        },
      });
      const unsettledCrawl = unsettledCrawls[0];
      if (
        unsettledCrawls.length > 1 ||
        (unsettledCrawl &&
          (!job ||
            unsettledCrawl.id !== crawlId ||
            unsettledCrawl.sourceId !== sourceId ||
            unsettledCrawl.requestKey !== idempotencyKey ||
            unsettledCrawl.jobId !== jobId))
      ) {
        error(
          409,
          'An existing source crawl requires durable reconciliation before another can be enqueued.',
        );
      }
      const crawl = await createCrawlIfMissing(crawls, {
        crawlId,
        idempotencyKey,
        jobId,
        sourceId,
        userId: stringValue(user.id),
      });

      const args = {
        idempotencyKey,
        includeGeneric: true,
        limit,
        reason,
        sourceCrawlId: crawlId,
      };
      let reused = Boolean(job);
      if (!job) {
        const completedRetry = await jobs.get(jobId);
        if (completedRetry) {
          const completedArgs = (completedRetry.args ?? {}) as Record<
            string,
            unknown
          >;
          const completedStatus = completedRetry.status;
          if (
            completedRetry.id !== jobId ||
            completedArgs.idempotencyKey !== idempotencyKey ||
            completedArgs.sourceCrawlId !== crawlId ||
            completedRetry.objectId !== sourceId ||
            completedRetry.queue !== SOURCE_CRAWL_QUEUE ||
            completedRetry.objectType !== SOURCE_JOB_OBJECT_TYPE ||
            completedRetry.method !== SOURCE_CRAWL_METHOD ||
            typeof completedStatus !== 'string' ||
            ACTIVE_JOB_STATUSES.includes(
              completedStatus as (typeof ACTIVE_JOB_STATUSES)[number],
            ) ||
            !['completed', 'failed', 'cancelled'].includes(completedStatus)
          ) {
            error(409, 'The deterministic source crawl identifier is in use.');
          }
          job = completedRetry;
          reused = true;
        }
      }
      const crawlStatus = stringValue(crawl.status);
      if (
        job &&
        !ACTIVE_JOB_STATUSES.includes(
          stringValue(job.status) as (typeof ACTIVE_JOB_STATUSES)[number],
        ) &&
        crawlStatus === 'queued' &&
        !crawl.finishedAt
      ) {
        error(
          409,
          'The terminal source crawl job is awaiting durable crawl reconciliation.',
        );
      }
      const durableCrawlOwnsOperation =
        !job && (crawlStatus !== 'queued' || Boolean(crawl.finishedAt));
      if (durableCrawlOwnsOperation) reused = true;
      if (!job && !durableCrawlOwnsOperation) {
        job = await jobs.create({
          args,
          id: jobId,
          maxAttempts: 1,
          method: SOURCE_CRAWL_METHOD,
          objectId: sourceId,
          objectType: SOURCE_JOB_OBJECT_TYPE,
          priority: 75,
          queue: SOURCE_CRAWL_QUEUE,
          runAt: now,
          status: 'pending',
          timeout: SOURCE_CRAWL_TIMEOUT_MS,
        });
        job.id = jobId;
        await job.save();
      }
      await (dependencies.audit ?? recordAgentAudit)({
        database: transactionDatabase,
        input: { idempotencyKey, limit, reason, sourceId },
        output: { crawlId, jobId, reused },
        runType: 'webmcp_source_crawl_enqueue',
        sourceId,
        status: 'completed',
        user,
      });
      return {
        crawlId,
        jobId,
        reused,
        status: stringValue(job?.status) || crawlStatus || 'queued',
      };
    }),
  ).catch((cause: unknown) => {
    if (isSourceCrawlActiveJobConflict(cause)) {
      error(
        409,
        'This source already has an active crawl under a different idempotency key.',
      );
    }
    throw cause;
  });
  const { crawlId, jobId, reused, status } = operation;
  return {
    crawlId,
    jobId,
    reused,
    sourceId,
    status,
  };
}

export async function listSourceCrawlStatus(
  input: Record<string, unknown>,
  dependencies: SourceWebMcpDependencies = {},
) {
  const crawlId = input.crawlId ? requiredUuid(input.crawlId, 'crawlId') : '';
  const sourceId = input.sourceId
    ? requiredUuid(input.sourceId, 'sourceId')
    : '';
  if (!crawlId && !sourceId) {
    error(400, 'crawlId or sourceId is required.');
  }
  const limit = boundedInteger(input.limit, 'limit', 1, MAX_CRAWL_RESULTS, 10);
  const database = await requestDatabase(dependencies);
  const { crawls, sources } = await collections(dependencies, database);
  if (sourceId) {
    const requestedSource = await sources.get(sourceId);
    if (!requestedSource) error(404, 'Source not found.');
    assertOperableRootSource(requestedSource);
  }
  const records = crawlId
    ? [await crawls.get(crawlId)].filter(Boolean)
    : await crawls.list({
        limit,
        orderBy: 'started_at DESC',
        where: { sourceId },
      });
  for (const record of records) {
    if (!record) continue;
    const recordSourceId = stringValue(record.sourceId);
    if (!recordSourceId || (sourceId && recordSourceId !== sourceId)) {
      error(409, 'Crawl does not belong to the requested source.');
    }
    const crawlSource = await sources.get(recordSourceId);
    if (!crawlSource) error(404, 'Crawl source not found.');
    assertOperableRootSource(crawlSource);
  }
  return {
    items: records
      .filter((crawl): crawl is MutableRecord => Boolean(crawl))
      .slice(0, limit)
      .map((crawl) => safeCrawl(crawl)),
    limit,
  };
}
