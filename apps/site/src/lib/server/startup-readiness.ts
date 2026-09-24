/**
 * Server-start sequencing for deployed web processes (#100).
 *
 * Runtime initialisation (database, authentication, assets and secrets
 * readiness) can fail transiently at boot, especially while a rollout briefly
 * runs old and new pods side by side. A single failure used to be cached for
 * the life of the process, so the resume prime never started and /health
 * stayed 503 until kubelet restarted the pod. Startup now retries with bounded
 * backoff and only then warms the published resume.
 */

type StartupLogger = Pick<Console, 'info' | 'warn'>;

export interface RuntimeThenPrimeOptions {
  ensureRuntime: () => Promise<void>;
  prime: () => void;
  log?: StartupLogger;
  sleep?: (ms: number) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Describe a startup failure without its message or cause. Messages and causes
 * can carry connection details; the runtime's error name, code and component
 * are enough to tell a database stall from an OIDC outage in pod logs.
 */
export function describeStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error rejection';
  const details = error as Error & { code?: unknown; component?: unknown };
  const parts = [error.name || 'Error'];
  if (typeof details.code === 'string') parts.push(`code=${details.code}`);
  if (typeof details.component === 'string') {
    parts.push(`component=${details.component}`);
  }
  return parts.join(' ');
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export async function startRuntimeThenPrime({
  ensureRuntime,
  prime,
  log = console,
  sleep = defaultSleep,
  initialDelayMs = 2_000,
  maxDelayMs = 30_000,
}: RuntimeThenPrimeOptions): Promise<void> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ensureRuntime();
      log.info(
        `[startup] runtime ready after ${attempt} attempt(s) in ${Date.now() - startedAt}ms`,
      );
      prime();
      return;
    } catch (error) {
      const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      log.warn(
        `[startup] runtime not ready (attempt ${attempt}, ${describeStartupFailure(error)}); retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
}
