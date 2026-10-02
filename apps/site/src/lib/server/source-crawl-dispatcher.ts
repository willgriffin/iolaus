import { createHash } from 'node:crypto';
import { AgentScheduleCollection } from '@happyvertical/smrt-agents';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';
import {
  type RuntimeWorkspaceSubject,
  runAsRevalidatedJobWorkspaceSubject,
  runtimeWorkspaceSubjectFromJobArgs,
} from './job-workspace-subject.js';
import { getCollection } from './smrt.js';
import {
  assertSourceCrawlOperations,
  captureSourceCrawlOperator,
  requireSourceCrawlOperator,
} from './source-crawl-operator.js';
import { assertActiveOperableRootSource } from './source-provenance.js';
import {
  nextRunForCron,
  SOURCE_CRAWL_METHOD,
  SOURCE_JOB_OBJECT_TYPE,
} from './source-schedules.js';
import { enqueueRootSourceCrawl } from './source-webmcp.js';

type Database = Awaited<ReturnType<typeof resolveDatabase>>;
type Schedule = {
  id?: string;
  agentId?: string | null;
  agentType?: string;
  enabled?: boolean;
  status?: string;
  tenantId?: string | null;
  method?: string;
  methodArgs?: Record<string, unknown>;
  cron?: string;
  timezone?: string;
  nextRun?: Date | string | null;
  updated_at?: Date | string | null;
};
type Schedules = {
  get: (
    filter: { id: string },
    options: { cache: false },
  ) => Promise<Schedule | null>;
  list: (options: Record<string, unknown>) => Promise<Schedule[]>;
};
type Sources = {
  get: (
    id: string,
    options: { cache: false },
  ) => Promise<Record<string, unknown> | null>;
};

export interface SourceCrawlDispatchOptions {
  /** Explicit public-source admission. Active catalog state alone is insufficient. */
  allowSourceIds: readonly string[];
  database?: Database;
  maxSchedules?: number;
  sourceLimit?: number;
  now?: Date;
}

export interface SourceCrawlDispatcherDependencies {
  schedules?: Schedules;
  sources?: Sources;
  enqueue?: typeof enqueueRootSourceCrawl;
  captureOperator?: typeof captureSourceCrawlOperator;
  revalidate?: typeof runAsRevalidatedJobWorkspaceSubject;
}

export interface SourceCrawlDispatchOutcome {
  scheduleId: string;
  sourceId: string;
  status: 'dispatched' | 'superseded' | 'refused';
  receipt?: Awaited<ReturnType<typeof enqueueRootSourceCrawl>>;
  error?: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_STATUSES = new Set([
  'pending',
  'running',
  'queued',
  'completed',
  'completed_with_errors',
  'failed',
  'timed_out',
  'cancelled',
]);

function bound(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 1 || actual > 75) {
    throw new Error(`${label} must be an integer between 1 and 75.`);
  }
  return actual;
}

function instant(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sameSubject(
  a: RuntimeWorkspaceSubject,
  b: RuntimeWorkspaceSubject,
): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.userId === b.userId &&
    a.profileId === b.profileId
  );
}

function assertSchedule(
  schedule: Schedule,
  operator: RuntimeWorkspaceSubject,
  admitted: Set<string>,
  now: Date,
): { due: Date; next: Date; revision: Date } {
  if (
    !schedule.id ||
    !schedule.agentId ||
    !admitted.has(schedule.agentId) ||
    schedule.agentType !== SOURCE_JOB_OBJECT_TYPE ||
    schedule.method !== SOURCE_CRAWL_METHOD ||
    schedule.enabled !== true ||
    schedule.status !== 'active' ||
    schedule.tenantId !== operator.tenantId
  ) {
    throw new Error(
      'Only admitted, active, operator-bound Source.crawl schedules may dispatch.',
    );
  }
  const subject = runtimeWorkspaceSubjectFromJobArgs(schedule.methodArgs ?? {});
  if (!sameSubject(subject, operator))
    throw new Error(
      'Schedule operator does not match the verified dispatcher operator.',
    );
  const due = instant(schedule.nextRun);
  const revision = instant(schedule.updated_at);
  if (!due || due > now || !revision)
    throw new Error('Schedule is not due or lacks its durable revision.');
  // These schedules are authored by syncSourceSchedule in UTC. Do not reinterpret
  // an unrelated native agent schedule's timezone or richer cron expression.
  if (
    schedule.timezone !== 'UTC' ||
    !schedule.cron ||
    !/^(?:\*|\d{1,2})(?:\s+(?:\*|\d{1,2})){4}$/.test(schedule.cron)
  ) {
    throw new Error('Source schedule requires its supported UTC cadence.');
  }
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  if (
    schedule.cron
      .split(/\s+/)
      .some(
        (part, index) =>
          part !== '*' &&
          (Number(part) < ranges[index][0] || Number(part) > ranges[index][1]),
      )
  ) {
    throw new Error('Source schedule has an invalid cadence field.');
  }
  return { due, next: nextRunForCron(schedule.cron, now), revision };
}

/** One bounded tick; the caller owns recurrence, admission and failure cooldown.
 * Jobs remain in the native source-crawls queue. Its bound worker enforces
 * intelligenceEnqueueCap=0; no general scheduler or worker is started here.
 */
export async function dispatchDueSourceCrawls(
  options: SourceCrawlDispatchOptions,
  dependencies: SourceCrawlDispatcherDependencies = {},
): Promise<{ scanned: number; outcomes: SourceCrawlDispatchOutcome[] }> {
  if (
    !Array.isArray(options.allowSourceIds) ||
    options.allowSourceIds.length < 1 ||
    options.allowSourceIds.length > 75 ||
    options.allowSourceIds.some(
      (id) => typeof id !== 'string' || !UUID.test(id),
    )
  ) {
    throw new Error(
      'allowSourceIds requires 1 to 75 explicit valid source IDs.',
    );
  }
  const admitted = new Set(options.allowSourceIds);
  const maximum = bound(options.maxSchedules, 25, 'maxSchedules');
  const sourceLimit = bound(options.sourceLimit, 75, 'sourceLimit');
  const now = instant(options.now ?? new Date());
  if (!now) throw new Error('A valid dispatch time is required.');
  const operator = (
    dependencies.captureOperator ?? captureSourceCrawlOperator
  )();
  const database = options.database ?? (await resolveDatabase(getDbConfig()));
  const schedules: Schedules =
    dependencies.schedules ??
    ((await AgentScheduleCollection.create({
      db: database,
    })) as unknown as Schedules);
  const sources =
    dependencies.sources ??
    ((await getCollection('Source', { db: database })) as unknown as Sources);
  const fence = async <T>(work: () => Promise<T>): Promise<T> =>
    await (dependencies.revalidate ?? runAsRevalidatedJobWorkspaceSubject)(
      operator,
      'audit.record',
      async (fresh, run) => {
        if (!sameSubject(fresh, operator))
          throw new Error('Dispatcher operator changed.');
        requireSourceCrawlOperator();
        await assertSourceCrawlOperations(run);
        return await work();
      },
    );
  const candidates = await fence(
    async () =>
      await schedules.list({
        where: {
          agentType: SOURCE_JOB_OBJECT_TYPE,
          method: SOURCE_CRAWL_METHOD,
          enabled: true,
          status: 'active',
          tenantId: operator.tenantId,
          'agentId in': [...admitted],
          'nextRun <=': now,
        },
        orderBy: 'next_run ASC',
        limit: maximum,
      }),
  );
  const outcomes: SourceCrawlDispatchOutcome[] = [];
  for (const candidate of candidates.slice(0, maximum)) {
    const outcome: SourceCrawlDispatchOutcome = {
      scheduleId: candidate.id ?? '',
      sourceId: candidate.agentId ?? '',
      status: 'refused',
    };
    try {
      const initial = assertSchedule(candidate, operator, admitted, now);
      const accepted = await fence(async () => {
        // Native get(string) treats non-UUID identifiers as slugs. Legacy
        // schedules retain text primary keys, so always select their exact ID.
        const current = await schedules.get(
          { id: outcome.scheduleId },
          { cache: false },
        );
        if (!current) throw new Error('Source schedule no longer exists.');
        if (
          instant(current.nextRun)?.getTime() !== initial.due.getTime() ||
          instant(current.updated_at)?.getTime() !== initial.revision.getTime()
        )
          return null;
        const state = assertSchedule(current, operator, admitted, now);
        if (
          current.agentId !== candidate.agentId ||
          state.due.getTime() !== initial.due.getTime() ||
          state.revision.getTime() !== initial.revision.getTime()
        )
          return null;
        const source = await sources.get(outcome.sourceId, { cache: false });
        if (!source) throw new Error('Admitted source not found.');
        assertActiveOperableRootSource(source);
        // Source is an installation-wide catalog; reject an explicit foreign
        // tenant without inventing ownership fields for shared catalog records.
        if (source.tenantId != null && source.tenantId !== operator.tenantId) {
          throw new Error('Source belongs to a different tenant.');
        }
        const idempotencyKey = `source-schedule-${createHash('sha256')
          .update(`${outcome.scheduleId}:${initial.due.toISOString()}`)
          .digest('hex')}`;
        const receipt = await (dependencies.enqueue ?? enqueueRootSourceCrawl)(
          {
            sourceId: outcome.sourceId,
            idempotencyKey,
            limit: sourceLimit,
            reason: `scheduled source pull ${outcome.scheduleId} due ${initial.due.toISOString()}`,
          },
          { id: operator.userId },
          { database, now: () => new Date(now) },
        );
        if (
          receipt.sourceId !== outcome.sourceId ||
          !UUID.test(receipt.crawlId) ||
          !UUID.test(receipt.jobId) ||
          !RECEIPT_STATUSES.has(receipt.status) ||
          (!['pending', 'running', 'queued'].includes(receipt.status) &&
            receipt.reused !== true)
        ) {
          throw new Error(
            'Source enqueue did not return a durable accepted receipt.',
          );
        }
        return receipt;
      });
      if (!accepted) {
        outcome.status = 'superseded';
        outcomes.push(outcome);
        continue;
      }
      outcome.receipt = accepted;
      const advanced = await fence(async () => {
        const current = await schedules.get(
          { id: outcome.scheduleId },
          { cache: false },
        );
        if (!current) return false;
        if (
          instant(current.nextRun)?.getTime() !== initial.due.getTime() ||
          instant(current.updated_at)?.getTime() !== initial.revision.getTime()
        )
          return false;
        const state = assertSchedule(current, operator, admitted, now);
        if (
          state.due.getTime() !== initial.due.getTime() ||
          state.revision.getTime() !== initial.revision.getTime() ||
          current.agentId !== candidate.agentId
        )
          return false;
        // The source update permission above authorizes its native schedule row.
        // CAS never overwrites a completion sync or a concurrent operator edit.
        const write = await database.update(
          '_smrt_agent_schedules',
          {
            id: outcome.scheduleId,
            tenant_id: operator.tenantId,
            agent_id: outcome.sourceId,
            agent_type: SOURCE_JOB_OBJECT_TYPE,
            method: SOURCE_CRAWL_METHOD,
            enabled: true,
            status: 'active',
            next_run: initial.due.toISOString(),
            updated_at: initial.revision.toISOString(),
          },
          {
            next_run: initial.next.toISOString(),
            updated_at: now.toISOString(),
          },
        );
        return write.affected === 1;
      });
      outcome.status = advanced ? 'dispatched' : 'superseded';
    } catch (cause) {
      outcome.error = (
        cause instanceof Error ? cause.message : 'Source dispatch refused.'
      ).slice(0, 300);
    }
    outcomes.push(outcome);
  }
  return { scanned: Math.min(candidates.length, maximum), outcomes };
}
