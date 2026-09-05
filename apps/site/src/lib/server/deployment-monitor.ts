export type DeploymentMonitorJobCount = {
  readonly queue: string;
  readonly status: string;
  readonly count: number;
};

export type DeploymentMonitorSourceCrawls = {
  readonly active: number;
  readonly queued: number;
  readonly staleRunning: number;
  readonly timedOut: number;
};

/**
 * Project the monitor onto aggregate, non-sensitive operational facts. Queue
 * depth itself is observational; stale or timed-out provider work is a bounded
 * fault condition that must fail this read-only monitor job until triaged.
 */
export function projectDeploymentMonitor({
  jobs,
  sourceCrawls,
}: {
  readonly jobs: readonly DeploymentMonitorJobCount[];
  readonly sourceCrawls: DeploymentMonitorSourceCrawls;
}) {
  const normalizedJobs = jobs
    .map((job) => ({
      count: Math.max(0, Math.floor(Number(job.count) || 0)),
      queue: String(job.queue),
      status: String(job.status),
    }))
    .sort(
      (left, right) =>
        left.queue.localeCompare(right.queue) ||
        left.status.localeCompare(right.status),
    );
  const normalizedCrawls = {
    active: Math.max(0, Math.floor(Number(sourceCrawls.active) || 0)),
    queued: Math.max(0, Math.floor(Number(sourceCrawls.queued) || 0)),
    staleRunning: Math.max(
      0,
      Math.floor(Number(sourceCrawls.staleRunning) || 0),
    ),
    timedOut: Math.max(0, Math.floor(Number(sourceCrawls.timedOut) || 0)),
  };
  return {
    schemaVersion: 1,
    status:
      normalizedCrawls.staleRunning === 0 && normalizedCrawls.timedOut === 0
        ? 'ready'
        : 'degraded',
    jobs: normalizedJobs,
    sourceCrawls: normalizedCrawls,
  } as const;
}
