import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { ScheduleRunner, TaskRunner, type SmrtJob } from '@happyvertical/smrt-jobs';
import { getDbConfig } from '../src/lib/server/db.js';
import { AUTO_SUBMIT_APPLICATION_QUEUE } from '../src/lib/server/auto-submit-application-job-schema.js';
import { OPPORTUNITY_INTELLIGENCE_QUEUE } from '../src/lib/server/opportunity-intelligence-job-schema.js';
import { ensureSourceScheduleTable, SCHEDULED_SOURCE_QUEUE, SOURCE_CRAWL_QUEUE } from '../src/lib/server/source-schedules.js';
import {
  reapStaleSourceCrawls,
  reconcileFailedSourceCrawlJob,
} from '../src/lib/server/source-crawl-watchdog.js';

process.env.TZ ||= 'UTC';

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function scheduleIdForJob(job: SmrtJob): string {
  const scheduleId = job.args?._scheduleId;
  return typeof scheduleId === 'string' ? scheduleId : '';
}

const taskHeartbeatInterval = numberFromEnv('SMRT_JOBS_WORKER_HEARTBEAT_MS', 30_000);
const staleJobThresholdMs = numberFromEnv('SMRT_JOBS_WORKER_STALE_MS', 10 * 60_000);
const sourceCrawlWatchdogIntervalMs = numberFromEnv(
  'SOURCE_CRAWL_WATCHDOG_MS',
  60_000,
);
const db = await resolveDatabase(getDbConfig());
await ensureSourceScheduleTable(db);
await reapStaleSourceCrawls(db);

const taskRunner = new TaskRunner({
  concurrency: numberFromEnv('SMRT_JOBS_WORKER_CONCURRENCY', 2),
  heartbeatInterval: taskHeartbeatInterval,
  pollInterval: numberFromEnv('SMRT_JOBS_WORKER_POLL_MS', 1_000),
  queues: [
    SOURCE_CRAWL_QUEUE,
    SCHEDULED_SOURCE_QUEUE,
    OPPORTUNITY_INTELLIGENCE_QUEUE,
    AUTO_SUBMIT_APPLICATION_QUEUE,
  ],
  shutdownTimeout: numberFromEnv('SMRT_JOBS_WORKER_SHUTDOWN_MS', 60_000),
  staleJobThresholdMs,
});
const scheduleRunner = new ScheduleRunner({
  pollInterval: numberFromEnv('SMRT_JOBS_SCHEDULE_POLL_MS', 60_000),
  staleJobThresholdMs,
  taskHeartbeatInterval,
});

taskRunner.on('job:completed', (job) => {
  const scheduleId = scheduleIdForJob(job);
  if (!scheduleId) return;
  void scheduleRunner.handleJobCompletion(scheduleId, true).catch((error) => {
    console.error('Failed to mark schedule completed:', error);
  });
});

taskRunner.on('job:failed', (job, error) => {
  if (
    [SOURCE_CRAWL_QUEUE, SCHEDULED_SOURCE_QUEUE].includes(job.queue) &&
    job.id
  ) {
    void reconcileFailedSourceCrawlJob(job.id, db).catch((reconcileError) => {
      console.error('Failed to reconcile source crawl job:', reconcileError);
    });
  }
  const scheduleId = scheduleIdForJob(job);
  if (!scheduleId) return;
  void scheduleRunner.handleJobCompletion(scheduleId, false, error.message).catch((scheduleError) => {
    console.error('Failed to mark schedule failed:', scheduleError);
  });
});

taskRunner.on('runner:error', (error) => {
  console.error('Task runner error:', error);
});
scheduleRunner.on('runner:error', (error) => {
  console.error('Schedule runner error:', error);
});

await taskRunner.initialize(db);
await scheduleRunner.initialize(db);
await taskRunner.start();
await scheduleRunner.start();

const sourceCrawlWatchdog = setInterval(() => {
  void reapStaleSourceCrawls(db).catch((error) => {
    console.error('Source crawl watchdog failed:', error);
  });
}, sourceCrawlWatchdogIntervalMs);

console.log(
  `SMRT jobs worker started for queues ${SOURCE_CRAWL_QUEUE}, ${SCHEDULED_SOURCE_QUEUE}, ${OPPORTUNITY_INTELLIGENCE_QUEUE}, ${AUTO_SUBMIT_APPLICATION_QUEUE}.`,
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping SMRT jobs worker.`);

  clearInterval(sourceCrawlWatchdog);
  await Promise.allSettled([scheduleRunner.stop(), taskRunner.stop()]);
  process.exit(0);
}

process.once('SIGINT', (signal) => {
  void shutdown(signal);
});
process.once('SIGTERM', (signal) => {
  void shutdown(signal);
});
