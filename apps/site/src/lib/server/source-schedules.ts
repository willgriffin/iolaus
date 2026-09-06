import { randomUUID } from 'node:crypto';
import { AgentScheduleCollection } from '@happyvertical/smrt-agents';
import type { SmrtObject } from '@happyvertical/smrt-core';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  type SmrtJob,
  SmrtJobCollection,
  type SmrtJobData,
} from '@happyvertical/smrt-jobs';
import { getDbConfig, getSmrtOptions } from './db.js';
import type { SourceLike } from './opportunity-source-crawler.js';
import { getCollection } from './smrt.js';
import { assertActiveOperableRootSource } from './source-provenance.js';

export const SOURCE_JOB_OBJECT_TYPE = '@willgriffin/iolaus-site:Source';
export const SOURCE_CRAWL_QUEUE = 'source-crawls';
export const SCHEDULED_SOURCE_QUEUE = 'agents';
export const SOURCE_CRAWL_METHOD = 'crawl';
export const SOURCE_CRAWL_TIMEOUT_MS = 3 * 60 * 1000;

export const refreshCadences = [
  'daily',
  'weekly',
  'monthly',
  'ad_hoc',
] as const;
export type RefreshCadence = (typeof refreshCadences)[number];

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

export interface SourceScheduleRecord {
  id: string;
  agentType: string;
  agentId: string;
  cron: string | null;
  enabled: boolean;
  method: string;
  methodArgs: Record<string, unknown>;
  nextRun: Date | null;
  status: 'active' | 'inactive';
}

export interface SyncSourceScheduleOptions {
  db?: SmrtDatabase;
  now?: Date;
  saveSource?: boolean;
}

export interface SyncAllSourceSchedulesSummary {
  disabled: number;
  enabled: number;
  total: number;
}

export interface EnqueueSourceCrawlOptions {
  collection?: {
    create: (data: SmrtJobData) => Promise<SmrtJob>;
  };
  now?: Date;
  reason?: string;
  sourceCollection?: {
    get: (id: string) => Promise<unknown | null | undefined>;
  };
}

export interface SourceCrawlJobArgs {
  includeGeneric?: boolean;
  limit?: number;
  reason?: string;
  sourceCrawlId?: string;
}

interface ScheduleSource extends SourceLike {
  refreshCadence?: unknown;
  nextCheckAt?: Date | string | null;
  save?: () => Promise<unknown>;
}

interface SourceListCollection {
  list: (options: { limit: number; offset?: number }) => Promise<unknown[]>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceKey(source: Pick<SourceLike, 'id' | 'name'>): string {
  return stringValue(source.id) || stringValue(source.name) || 'source';
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cronPartMatches(part: string, value: number): boolean {
  return part === '*' || Number(part) === value;
}

function cronMatchesDate(cron: string, date: Date): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return false;

  return (
    cronPartMatches(minute, date.getUTCMinutes()) &&
    cronPartMatches(hour, date.getUTCHours()) &&
    cronPartMatches(dayOfMonth, date.getUTCDate()) &&
    cronPartMatches(month, date.getUTCMonth() + 1) &&
    cronPartMatches(dayOfWeek, date.getUTCDay())
  );
}

function startOfNextUtcMinute(date: Date): Date {
  const next = new Date(date);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next;
}

export function normalizeRefreshCadence(value: unknown): RefreshCadence {
  const cadence = stringValue(value).toLowerCase();
  return refreshCadences.includes(cadence as RefreshCadence)
    ? (cadence as RefreshCadence)
    : 'ad_hoc';
}

export function sourceScheduleId(sourceId: string): string {
  // Keep this aligned with SMRT's legacy schedule backfill, which normalizes
  // the former `source-crawl:<uuid>` textual id into this stable slug.
  return `source-crawl-${sourceId}`;
}

export function cronForSourceCadence(
  cadenceValue: unknown,
  source: Pick<SourceLike, 'id' | 'name'>,
): string | null {
  const cadence = normalizeRefreshCadence(cadenceValue);
  if (cadence === 'ad_hoc') return null;

  const hash = stableHash(sourceKey(source));
  const minute = hash % 60;
  const hour = Math.floor(hash / 60) % 24;

  if (cadence === 'daily') return `${minute} ${hour} * * *`;
  if (cadence === 'weekly') return `${minute} ${hour} * * ${hash % 7}`;

  const dayOfMonth = (hash % 28) + 1;
  return `${minute} ${hour} ${dayOfMonth} * *`;
}

export function nextRunForCron(cron: string, now = new Date()): Date {
  const candidate = startOfNextUtcMinute(now);
  const maxMinutes = 60 * 24 * 370;

  for (let index = 0; index < maxMinutes; index += 1) {
    if (cronMatchesDate(cron, candidate)) return new Date(candidate);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error(`Unable to compute next run for cron: ${cron}`);
}

export function buildSourceSchedule(
  source: ScheduleSource,
  now = new Date(),
): SourceScheduleRecord | null {
  const sourceId = stringValue(source.id);
  if (!sourceId) return null;

  const cron =
    source.isActive !== true ||
    !('sourceRole' in source) ||
    source.sourceRole !== 'root' ||
    ('parentSourceId' in source && Boolean(stringValue(source.parentSourceId)))
      ? null
      : cronForSourceCadence(source.refreshCadence, source);
  const enabled = Boolean(cron);

  return {
    id: sourceScheduleId(sourceId),
    agentType: SOURCE_JOB_OBJECT_TYPE,
    agentId: sourceId,
    cron,
    enabled,
    method: SOURCE_CRAWL_METHOD,
    methodArgs: { includeGeneric: true, reason: 'scheduled' },
    nextRun: cron ? nextRunForCron(cron, now) : null,
    status: enabled ? 'active' : 'inactive',
  };
}

export async function ensureSourceScheduleTable(
  db?: SmrtDatabase,
): Promise<void> {
  const database = db ?? (await resolveDatabase(getDbConfig()));
  await AgentScheduleCollection.create({ db: database });
}

async function sourceSchedules(db: SmrtDatabase) {
  return await AgentScheduleCollection.create({ db });
}

async function assertSourceScheduleBackfillApplied(
  schedules: Awaited<ReturnType<typeof sourceSchedules>>,
  sourceId: string,
): Promise<void> {
  const legacyId = `source-crawl:${sourceId}`;
  const schedulesForSource = await schedules.list({
    where: {
      agentId: sourceId,
      agentType: SOURCE_JOB_OBJECT_TYPE,
      method: SOURCE_CRAWL_METHOD,
    },
  });
  const unbackfilledSchedule = schedulesForSource.find(
    (schedule) =>
      stringValue(schedule.id) === legacyId && !stringValue(schedule.slug),
  );

  if (unbackfilledSchedule) {
    throw new Error(
      `Source schedule ${legacyId} requires SMRT schedule backfill; run smrt db:migrate before synchronizing source schedules.`,
    );
  }
}

export async function syncSourceSchedule(
  source: ScheduleSource,
  options: SyncSourceScheduleOptions = {},
): Promise<SourceScheduleRecord | null> {
  const db = options.db ?? (await resolveDatabase(getDbConfig()));
  const schedule = buildSourceSchedule(source, options.now);
  if (!schedule) return null;

  const schedules = await sourceSchedules(db);
  await assertSourceScheduleBackfillApplied(schedules, schedule.agentId);
  await schedules.getOrUpsert({
    agentId: schedule.agentId,
    agentType: schedule.agentType,
    context: '',
    cron: schedule.cron ?? '* * * * *',
    enabled: schedule.enabled,
    maxConcurrent: 1,
    method: schedule.method,
    methodArgs: schedule.methodArgs,
    nextRun: schedule.nextRun,
    slug: schedule.id,
    status: schedule.enabled ? 'active' : 'disabled',
    timeout: SOURCE_CRAWL_TIMEOUT_MS,
    timezone: 'UTC',
  });

  source.nextCheckAt = schedule.nextRun;
  if (options.saveSource !== false && typeof source.save === 'function') {
    await source.save();
  }

  return schedule;
}

export async function deleteSourceSchedule(
  sourceId: string,
  options: Pick<SyncSourceScheduleOptions, 'db'> = {},
): Promise<void> {
  const normalizedSourceId = sourceId.trim();
  if (!normalizedSourceId) return;

  const db = options.db ?? (await resolveDatabase(getDbConfig()));
  const schedules = await sourceSchedules(db);
  const schedule = await schedules.get({
    context: '',
    slug: sourceScheduleId(normalizedSourceId),
  });
  if (
    schedule &&
    schedule.agentType === SOURCE_JOB_OBJECT_TYPE &&
    schedule.method === SOURCE_CRAWL_METHOD
  ) {
    await schedule.delete();
  }
}

async function listAllScheduleSources(
  collection: SourceListCollection,
): Promise<ScheduleSource[]> {
  const pageSize = 500;
  const sources: ScheduleSource[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const page = (await collection.list({
      limit: pageSize,
      offset,
    })) as ScheduleSource[];
    sources.push(...page);
    if (page.length < pageSize) break;
  }

  return sources;
}

async function deleteOrphanSourceSchedules(
  sourceIds: string[],
  db: SmrtDatabase,
): Promise<void> {
  const schedules = await sourceSchedules(db);
  const sourceIdsSet = new Set(sourceIds);
  const candidates = await schedules.list({
    where: {
      agentType: SOURCE_JOB_OBJECT_TYPE,
      method: SOURCE_CRAWL_METHOD,
    },
  });
  for (const schedule of candidates) {
    if (!sourceIdsSet.has(stringValue(schedule.agentId)))
      await schedule.delete();
  }
}

export async function syncAllSourceSchedules(
  options: SyncSourceScheduleOptions = {},
): Promise<SyncAllSourceSchedulesSummary> {
  const db = options.db ?? (await resolveDatabase(getDbConfig()));
  await ensureSourceScheduleTable(db);
  const collection = await getCollection('Source');
  const sources = await listAllScheduleSources(
    collection as unknown as SourceListCollection,
  );
  const sourceIds = new Set<string>();
  const summary: SyncAllSourceSchedulesSummary = {
    disabled: 0,
    enabled: 0,
    total: 0,
  };

  for (const source of sources) {
    const sourceId = stringValue(source.id);
    if (sourceId) sourceIds.add(sourceId);
    const schedule = await syncSourceSchedule(source, { ...options, db });
    if (!schedule) continue;
    summary.total += 1;
    if (schedule.enabled) summary.enabled += 1;
    else summary.disabled += 1;
  }

  await deleteOrphanSourceSchedules(Array.from(sourceIds), db);
  return summary;
}

async function assertSourceExists(
  sourceId: string,
  options: Pick<EnqueueSourceCrawlOptions, 'sourceCollection'>,
): Promise<void> {
  const sourceCollection =
    options.sourceCollection ?? (await getCollection('Source'));
  const source = await sourceCollection.get(sourceId);
  if (!source) {
    throw new Error('Source not found.');
  }
  assertActiveOperableRootSource(
    source as Parameters<typeof assertActiveOperableRootSource>[0],
  );
}

export async function enqueueSourceCrawl(
  sourceId: string,
  args: SourceCrawlJobArgs = {},
  options: EnqueueSourceCrawlOptions = {},
): Promise<SmrtJob> {
  const normalizedSourceId = sourceId.trim();
  if (!normalizedSourceId) throw new Error('Source id is required.');
  await assertSourceExists(normalizedSourceId, options);

  const collection =
    options.collection ??
    (await SmrtJobCollection.create({
      ...getSmrtOptions(),
    }));
  const job = await collection.create({
    args: {
      includeGeneric: true,
      ...args,
      reason: options.reason ?? args.reason ?? 'manual',
    },
    // LLM-backed crawls are intentionally one-shot. Operators must inspect the
    // failed run and explicitly requeue it to incur another provider attempt.
    maxAttempts: 1,
    method: SOURCE_CRAWL_METHOD,
    objectId: normalizedSourceId,
    objectType: SOURCE_JOB_OBJECT_TYPE,
    priority: 75,
    queue: SOURCE_CRAWL_QUEUE,
    runAt: options.now ?? new Date(),
    timeout: SOURCE_CRAWL_TIMEOUT_MS,
  });

  if (!('id' in job) || !job.id) {
    (job as SmrtObject).id = randomUUID();
  }

  await job.save();
  return job as SmrtJob;
}

export function isSourceCrawlEnqueueError(cause: unknown): cause is Error {
  if (!(cause instanceof Error)) return false;
  return (
    cause.message === 'Source id is required.' ||
    cause.message === 'Source not found.' ||
    cause.message.includes('not an explicitly classified root source') ||
    cause.message.includes('not explicitly active')
  );
}
