import { getCachedPublishedResume } from './resume-data.js';

/**
 * Warm the published resume cache at server start.
 *
 * A fresh replica used to pay the whole 27-collection read plan on its first
 * public request. Priming moves that cost into startup, and readiness reporting
 * keeps the pod out of the load balancer until it has settled.
 *
 * "Settled" deliberately includes failure: if the database is unreachable at
 * boot, the pod still reports ready rather than failing its probes into a
 * crash loop. A cold request will retry the load and surface the real error.
 *
 * A rejection is not the only way the warm-up can fail. A blackholed connection
 * stalls instead of erroring, so the settle is also bounded by a deadline —
 * without it `/health` would stay 503 forever, and because that path is the
 * liveness probe too, kubelet would restart the pod into exactly the crash loop
 * this design exists to avoid.
 */
const PRIME_DEADLINE_MS = 20_000;

let primeStarted = false;
let primeSettled = false;

export function startPublishedResumePrime(
  deadlineMs = PRIME_DEADLINE_MS,
): void {
  if (primeStarted) return;
  primeStarted = true;

  const settle = () => {
    primeSettled = true;
  };
  const deadline = setTimeout(settle, deadlineMs);
  deadline.unref?.();

  void getCachedPublishedResume()
    .catch(() => {
      // Startup priming is best-effort; request-time loading reports failures.
    })
    .finally(() => {
      clearTimeout(deadline);
      settle();
    });
}

export function isPublishedResumePrimeSettled(): boolean {
  return primeSettled;
}
