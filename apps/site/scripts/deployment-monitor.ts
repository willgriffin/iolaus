import { resolveDatabase } from '@happyvertical/smrt-core';
import { AUTO_SUBMIT_APPLICATION_QUEUE } from '../src/lib/server/auto-submit-application-job-schema.js';
import { getDbConfig } from '../src/lib/server/db.js';
import { projectDeploymentMonitor } from '../src/lib/server/deployment-monitor.js';
import {
  jobMonitorQuery,
  sourceCrawlMonitorQuery,
} from '../src/lib/server/deployment-monitor-query.js';
import { OPPORTUNITY_INTELLIGENCE_QUEUE } from '../src/lib/server/opportunity-intelligence-job-schema.js';
import {
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_QUEUE,
  SOURCE_CRAWL_TIMEOUT_MS,
} from '../src/lib/server/source-schedules.js';

const queues = [
  AUTO_SUBMIT_APPLICATION_QUEUE,
  OPPORTUNITY_INTELLIGENCE_QUEUE,
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_QUEUE,
];
const placeholders = queues.map(() => '?').join(', ');
const database = await resolveDatabase(getDbConfig());
const sourceCrawlDeadline = new Date(Date.now() - SOURCE_CRAWL_TIMEOUT_MS);
// This is deliberately aggregate-only: the monitor database role is permitted
// to observe queue health, never crawl identifiers, URLs, errors, or payloads.
const [sourceCrawls, jobs] = await Promise.all([
  database.query(
    sourceCrawlMonitorQuery,
    [sourceCrawlDeadline, sourceCrawlDeadline],
  ),
  database.query(
    jobMonitorQuery(placeholders),
    queues,
  ),
]);

const report = projectDeploymentMonitor({
  jobs: (jobs.rows ?? []).map((row) => ({
    count: Number(row.count) || 0,
    queue: String(row.queue ?? ''),
    status: String(row.status ?? ''),
  })),
  sourceCrawls: {
    active: Number(sourceCrawls.rows?.[0]?.active) || 0,
    queued: Number(sourceCrawls.rows?.[0]?.queued) || 0,
    staleRunning: Number(sourceCrawls.rows?.[0]?.stale_running) || 0,
    timedOut: Number(sourceCrawls.rows?.[0]?.timed_out) || 0,
  },
});
console.log(JSON.stringify(report));
if (report.status !== 'ready') process.exitCode = 1;
