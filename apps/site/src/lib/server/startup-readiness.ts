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
 * Strip anything that could carry a connection string or credential from an
 * error message before it reaches pod logs: URLs (which may embed
 * `user:password@`), `key=value` credentials and anything after a colon that
 * looks like a secret. The result is bounded so a large driver message cannot
 * flood the log.
 */
export function sanitizeStartupMessage(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, '<url>')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '<jwt>')
    .replace(/\b(Bearer|Basic)\s+\S+/giu, '$1 <redacted>')
    .replace(
      /\b([a-z_-]*(?:password|passwd|pwd|secret|token|apikey|api_key|authorization))\s*[=:]\s*(?!<redacted>|Bearer |Basic )\S+/giu,
      '$1=<redacted>',
    )
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Describe a startup failure for pod logs: the error class, the runtime's
 * code and component when present, and a sanitized, bounded message. Causes
 * are never logged. That is enough to tell a database stall from an OIDC
 * outage or a missing configuration value.
 */
export function describeStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error rejection';
  const details = error as Error & { code?: unknown; component?: unknown };
  const parts = [error.name || 'Error'];
  if (typeof details.code === 'string') parts.push(`code=${details.code}`);
  if (typeof details.component === 'string') {
    parts.push(`component=${details.component}`);
  }
  const message = sanitizeStartupMessage(error.message ?? '');
  if (message) parts.push(`"${message}"`);
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
