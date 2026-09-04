import { describe, expect, it } from 'vitest';
import { AUTO_SUBMIT_APPLICATION_QUEUE } from '../src/lib/server/auto-submit-application-job-schema.js';
import {
  OPPORTUNITY_INTELLIGENCE_QUEUE,
} from '../src/lib/server/opportunity-intelligence-job-schema.js';
import { taskWorkerQueues } from './jobs-worker-config.js';

describe('deployed TaskRunner entrypoint', () => {
  it('claims every application queue from its imported entrypoint configuration', () => {
    expect(taskWorkerQueues).toEqual(
      expect.arrayContaining([
        'source-crawls',
        'agents',
        OPPORTUNITY_INTELLIGENCE_QUEUE,
        AUTO_SUBMIT_APPLICATION_QUEUE,
      ]),
    );
  });
});
