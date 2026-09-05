/**
 * SQL contract for the monitor's PostgreSQL role. It deliberately names only
 * aggregate-safe columns; operators may grant these columns directly or expose
 * equivalent aggregate views to the monitor role.
 */
export const sourceCrawlMonitorQuery = `SELECT
  COUNT(*) FILTER (WHERE status IN ('queued', 'pending')) AS queued,
  COUNT(*) FILTER (
    WHERE status = 'running' AND finished_at IS NULL AND started_at > ?
  ) AS active,
  COUNT(*) FILTER (
    WHERE status = 'running' AND finished_at IS NULL
      AND (started_at IS NULL OR started_at <= ?)
  ) AS stale_running,
  COUNT(*) FILTER (WHERE status = 'timed_out') AS timed_out
FROM source_crawls`;

export function jobMonitorQuery(placeholders: string): string {
  return `SELECT CAST(queue AS TEXT) AS queue,
    CAST(status AS TEXT) AS status,
    COUNT(*) AS count
  FROM _smrt_jobs
  WHERE queue IN (${placeholders})
    AND status IN ('pending', 'running')
  GROUP BY queue, status
  ORDER BY queue, status`;
}
