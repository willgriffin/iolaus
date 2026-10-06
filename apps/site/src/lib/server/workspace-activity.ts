import { resolveDatabase } from '@happyvertical/smrt-core';
import { SmrtJobEventCollection } from '@happyvertical/smrt-jobs';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import {
  AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
  AUTO_SUBMIT_APPLICATION_METHOD,
  AUTO_SUBMIT_APPLICATION_QUEUE,
} from './auto-submit-application-job-schema.js';
import { getDbConfig } from './db.js';
import {
  OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
  OPPORTUNITY_INTELLIGENCE_METHOD,
  OPPORTUNITY_INTELLIGENCE_QUEUE,
} from './opportunity-intelligence-job-schema.js';
import { requireWorkspaceSubject } from './private-workspace.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

export const WORKSPACE_ACTIVITY_LIMIT = 20;
export const WORKSPACE_ACTIVITY_RECENT_MS = 5 * 60_000;
// Native queue from opportunity-screening-job; this reader never loads its provider adapter.
const SCREENING_ACTIVITY_QUEUE = 'opportunity-screening';

export interface WorkspaceActivityItem {
  id: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: number | null;
}

export interface WorkspaceActivitySnapshot {
  items: WorkspaceActivityItem[];
  observedAt: string;
  truncated: boolean;
}

type Row = Record<string, unknown>;
export interface WorkspaceActivityDependencies {
  database?: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>;
  };
  dialect?: 'postgres' | 'sqlite';
  now?: Date;
  loadProgress?: (
    jobIds: string[],
    tenantId: string,
  ) => Promise<Map<string, unknown>>;
}

function subjectSelector(
  dialect: 'postgres' | 'sqlite',
  key: 'userId' | 'profileId' | 'tenantId',
): string {
  return dialect === 'sqlite'
    ? `(CASE WHEN json_valid(job.args) THEN json_extract(job.args, '$.runtimeWorkspaceSubject.${key}') END)`
    : `(job.args -> 'runtimeWorkspaceSubject' ->> '${key}')`;
}

function identity(value: unknown): string {
  const hasControlCharacter = (candidate: string) =>
    Array.from(candidate).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !hasControlCharacter(value)
    ? value
    : '';
}

function timestamp(value: unknown): string | undefined {
  if (!(value instanceof Date) && typeof value !== 'string') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function title(row: Row): string | undefined {
  if (
    row.object_type === OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE &&
    row.queue === SCREENING_ACTIVITY_QUEUE &&
    row.method === 'prepareAssessmentCoverage'
  )
    return 'Screening opportunity';
  if (
    row.object_type === OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE &&
    row.queue === OPPORTUNITY_INTELLIGENCE_QUEUE
  ) {
    if (row.method === 'prepareAssessmentCoverage')
      return 'Preparing opportunity assessment';
    if (row.method === OPPORTUNITY_INTELLIGENCE_METHOD)
      return 'Processing opportunity';
  }
  if (
    row.object_type === AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE &&
    row.queue === AUTO_SUBMIT_APPLICATION_QUEUE &&
    row.method === AUTO_SUBMIT_APPLICATION_METHOD
  )
    return 'Submitting approved application';
  if (
    row.object_type === '@willgriffin/iolaus-site:Source' &&
    row.queue === 'source-crawls' &&
    row.method === 'crawl'
  )
    return 'Crawling requested source';
  return undefined;
}

/** Read owned active work and a bounded recent outcome window, never audit payloads. */
export async function loadWorkspaceActivity(
  requestedSubject: CandidateWorkspaceSubject,
  dependencies: WorkspaceActivityDependencies = {},
): Promise<WorkspaceActivitySnapshot> {
  const subject = requireWorkspaceSubject(requestedSubject);
  const now = dependencies.now ?? new Date();
  const observedAt = now.toISOString();
  const dialect =
    dependencies.dialect ??
    (getDbConfig().type === 'sqlite' ? 'sqlite' : 'postgres');
  const nativeDatabase = dependencies.database
    ? undefined
    : (getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig())));
  const database = dependencies.database ?? nativeDatabase;
  if (!database) throw new Error('Native activity storage is unavailable.');
  const tenant = subjectSelector(dialect, 'tenantId');
  const owner = subjectSelector(dialect, 'userId');
  const profile = subjectSelector(dialect, 'profileId');
  const { rows } = await database.query(
    `
    SELECT job.id, job.status, job.created_at, job.started_at, job.completed_at, job.method, job.object_type, job.queue,
           job.tenant_id, ${owner} AS owner_user_id, ${profile} AS candidate_profile_id,
           ${tenant} AS subject_tenant_id,
           job.worker_id, worker.status AS worker_status, worker.lease_expires_at
    FROM _smrt_jobs AS job
    LEFT JOIN _smrt_workers AS worker ON worker.worker_id = job.worker_id
    WHERE (
        (job.status = 'pending' AND job.completed_at IS NULL) OR
        (job.status = 'running' AND job.completed_at IS NULL
          AND worker.status = 'running' AND worker.lease_expires_at >= ?) OR
        (job.status IN ('completed', 'failed', 'cancelled') AND job.completed_at >= ?)
      )
      AND job.tenant_id = ? AND ${tenant} = ? AND ${owner} = ? AND ${profile} = ?
      AND (
        (job.object_type = ? AND job.queue = ? AND job.method IN (?, ?)) OR
        (job.object_type = ? AND job.queue = ? AND job.method = ?) OR
        (job.object_type = ? AND job.queue = ? AND job.method = ?) OR
        (job.object_type = ? AND job.queue = ? AND job.method = ?)
      )
    ORDER BY CASE WHEN job.status IN ('pending', 'running') THEN 0 ELSE 1 END,
      COALESCE(job.completed_at, job.started_at, job.created_at) DESC, job.id ASC
    LIMIT ?
  `,
    [
      observedAt,
      new Date(now.getTime() - WORKSPACE_ACTIVITY_RECENT_MS).toISOString(),
      subject.tenantId,
      subject.tenantId,
      subject.userId,
      subject.profileId,
      OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
      OPPORTUNITY_INTELLIGENCE_QUEUE,
      'prepareAssessmentCoverage',
      OPPORTUNITY_INTELLIGENCE_METHOD,
      AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
      AUTO_SUBMIT_APPLICATION_QUEUE,
      AUTO_SUBMIT_APPLICATION_METHOD,
      '@willgriffin/iolaus-site:Source',
      'source-crawls',
      'crawl',
      OPPORTUNITY_INTELLIGENCE_JOB_OBJECT_TYPE,
      SCREENING_ACTIVITY_QUEUE,
      'prepareAssessmentCoverage',
      WORKSPACE_ACTIVITY_LIMIT + 1,
    ],
  );

  // Repeat ownership and liveness checks at the DTO boundary. Native adapters
  // and test doubles cannot expand the SQL-selected authority or payload.
  const selected: Array<{ jobId: string; item: WorkspaceActivityItem }> = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, WORKSPACE_ACTIVITY_LIMIT + 1)) {
    const jobId = identity(row.id);
    const label = title(row);
    const createdAt = timestamp(row.created_at);
    const startedAt = timestamp(row.started_at);
    const completedAt = timestamp(row.completed_at);
    const lease = timestamp(row.lease_expires_at);
    const running = row.status === 'running';
    const queued = row.status === 'pending';
    const terminal = ['completed', 'failed', 'cancelled'].includes(
      String(row.status),
    );
    if (
      !jobId ||
      seen.has(jobId) ||
      !label ||
      !createdAt ||
      Date.parse(createdAt) > now.getTime() ||
      (!running && !queued && !terminal) ||
      (startedAt &&
        (Date.parse(startedAt) < Date.parse(createdAt) ||
          Date.parse(startedAt) > now.getTime())) ||
      (row.started_at != null && !startedAt) ||
      ((running || queued) && row.completed_at != null) ||
      (running &&
        (!startedAt ||
          !lease ||
          row.worker_status !== 'running' ||
          !identity(row.worker_id) ||
          Date.parse(lease) < now.getTime())) ||
      (terminal &&
        (!completedAt ||
          Date.parse(completedAt) <
            now.getTime() - WORKSPACE_ACTIVITY_RECENT_MS ||
          Date.parse(completedAt) > now.getTime() ||
          Date.parse(completedAt) < Date.parse(startedAt ?? createdAt))) ||
      row.tenant_id !== subject.tenantId ||
      row.subject_tenant_id !== subject.tenantId ||
      row.owner_user_id !== subject.userId ||
      row.candidate_profile_id !== subject.profileId
    )
      continue;
    seen.add(jobId);
    selected.push({
      jobId,
      item: {
        id: `job:${jobId}`,
        title: label,
        status: queued
          ? 'queued'
          : row.status === 'cancelled'
            ? 'canceled'
            : (row.status as WorkspaceActivityItem['status']),
        createdAt,
        startedAt: startedAt ?? null,
        completedAt: completedAt ?? null,
        progress: null,
      },
    });
  }
  const truncated = selected.length > WORKSPACE_ACTIVITY_LIMIT;
  const page = selected.slice(0, WORKSPACE_ACTIVITY_LIMIT);
  const runningPage = page.filter((row) => row.item.status === 'running');
  if (runningPage.length) {
    const loadProgress =
      dependencies.loadProgress ??
      (async (
        ids: string[],
        tenantId: string,
      ): Promise<Map<string, unknown>> => {
        if (!nativeDatabase)
          throw new Error('Native activity progress storage is unavailable.');
        const events = await SmrtJobEventCollection.create({
          db: nativeDatabase,
        });
        return await events.latestProgressByJobIds(ids, { tenantId });
      });
    const progress = await loadProgress(
      runningPage.map((row) => row.jobId),
      subject.tenantId,
    );
    for (const { jobId, item } of runningPage) {
      const value = progress.get(jobId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const event = value as Row;
      const createdAt = timestamp(event.createdAt);
      if (
        event.jobId !== jobId ||
        event.tenantId !== subject.tenantId ||
        event.type !== 'progress' ||
        !createdAt ||
        Date.parse(createdAt) < Date.parse(item.startedAt!) ||
        Date.parse(createdAt) > now.getTime() ||
        typeof event.progress !== 'number' ||
        !Number.isFinite(event.progress) ||
        event.progress < 0 ||
        event.progress > 100
      )
        continue;
      item.progress = event.progress;
    }
  }
  return { items: page.map((row) => row.item), observedAt, truncated };
}
