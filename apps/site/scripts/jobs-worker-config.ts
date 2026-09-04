import { AUTO_SUBMIT_APPLICATION_QUEUE } from '../src/lib/server/auto-submit-application-job-schema.js';
import { OPPORTUNITY_INTELLIGENCE_QUEUE } from '../src/lib/server/opportunity-intelligence-job-schema.js';
import {
  SCHEDULED_SOURCE_QUEUE,
  SOURCE_CRAWL_QUEUE,
} from '../src/lib/server/source-schedules.js';

// Keep this list in the process entrypoint graph: a deployment that claims only
// a subset would strand persisted work even though the feature is available.
export const taskWorkerQueues = [
  SOURCE_CRAWL_QUEUE,
  SCHEDULED_SOURCE_QUEUE,
  OPPORTUNITY_INTELLIGENCE_QUEUE,
  AUTO_SUBMIT_APPLICATION_QUEUE,
] as const;

export const TASK_WORKER_SHUTDOWN_TIMEOUT_MS = 240_000;
