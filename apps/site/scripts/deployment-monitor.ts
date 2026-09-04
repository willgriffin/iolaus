import { resolveDatabase } from '@happyvertical/smrt-core';
import { AUTO_SUBMIT_APPLICATION_QUEUE } from '../src/lib/server/auto-submit-application-job-schema.js';
import { getDbConfig } from '../src/lib/server/db.js';
import { projectDeploymentMonitor } from '../src/lib/server/deployment-monitor.js';
import { OPPORTUNITY_INTELLIGENCE_QUEUE } from '../src/lib/server/opportunity-intelligence-job-schema.js';
import {
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_QUEUE,
} from '../src/lib/server/source-schedules.js';
import { getSourceCrawlWatchdogStatus } from '../src/lib/server/source-crawl-watchdog.js';

const queues = [
  AUTO_SUBMIT_APPLICATION_QUEUE,
  OPPORTUNITY_INTELLIGENCE_QUEUE,
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_QUEUE,
];
const placeholders = queues.map(() => '?').join(', ');
const database = await resolveDatabase(getDbConfig());
const [sourceCrawls, jobs] = await Promise.all([
  getSourceCrawlWatchdogStatus(database),
  database.query(
    `SELECT CAST(queue AS TEXT) AS queue,
            CAST(status AS TEXT) AS status,
            COUNT(*) AS count
       FROM _smrt_jobs
      WHERE queue IN (${placeholders})
        AND status IN ('pending', 'running')
      GROUP BY queue, status
      ORDER BY queue, status`,
    queues,
  ),
]);

const report = projectDeploymentMonitor({
  jobs: (jobs.rows ?? []).map((row) => ({
    count: Number(row.count) || 0,
    queue: String(row.queue ?? ''),
    status: String(row.status ?? ''),
  })),
  sourceCrawls,
});
console.log(JSON.stringify(report));
if (report.status !== 'ready') process.exitCode = 1;
