import { describe, expect, it } from 'vitest';
import { projectDeploymentMonitor } from './deployment-monitor.js';

describe('projectDeploymentMonitor', () => {
  it('reports aggregate queue and provider state without error payloads', () => {
    expect(
      projectDeploymentMonitor({
        jobs: [
          { count: 2, queue: 'source-crawl', status: 'pending' },
          { count: 1, queue: 'agents', status: 'running' },
        ],
        sourceCrawls: { active: 1, queued: 2, staleRunning: 0, timedOut: 0 },
      }),
    ).toEqual({
      schemaVersion: 1,
      status: 'ready',
      jobs: [
        { count: 1, queue: 'agents', status: 'running' },
        { count: 2, queue: 'source-crawl', status: 'pending' },
      ],
      sourceCrawls: { active: 1, queued: 2, staleRunning: 0, timedOut: 0 },
    });
  });

  it.each([
    [
      'stale provider work',
      { active: 0, queued: 0, staleRunning: 1, timedOut: 0 },
    ],
    [
      'timed-out provider work',
      { active: 0, queued: 0, staleRunning: 0, timedOut: 1 },
    ],
  ])('fails closed on %s', (_scenario, sourceCrawls) => {
    expect(
      projectDeploymentMonitor({
        jobs: [],
        sourceCrawls,
      }).status,
    ).toBe('degraded');
  });
});
