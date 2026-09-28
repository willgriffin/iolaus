# Optional opportunity intelligence

Background intelligence is disabled by default. The first local workflow uses
the user's harness to browse and prepare applications. Enabling app-side model
calls or crawlers is an advanced deployment choice requiring explicit provider
configuration, credentials, budgets and validation.

Before enabling any provider, configure its URL and model explicitly, restrict
its credentials to approved models, and verify request/token/spend accounting.
Never send candidate contact details or whole resumes for opportunity scoring.
Keep the per-run and per-crawl limits bounded; accounting failures must stop work
rather than silently bypass the circuit. No production quota or model selection
from the predecessor deployment is an Iolaus default.

Inspect the control state with
`pnpm --filter @willgriffin/iolaus-site opportunities:intelligence-control status`.
Use `opportunities:intelligence-control stop` before investigating unexplained
usage, repeated provider errors or an open circuit. Re-enable only after the
deployment owner has verified configuration, accounting and the relevant tests.

Crawler rendering uses Crawl4AI only when its URL is explicitly configured via
`HAVE_SPIDER_CRAWL4AI_URL`, `CRAWL4AI_URL` or `CRAWL4AI_BASE_URL`. Merely running
inside Kubernetes never selects a private service. Without that configuration,
the generic simple adapter remains selected.

Keep deployment-specific cohorts, incident records, gateway budgets, alert
thresholds and operational rollout instructions outside the public source tree.

## Saved evaluation freshness

The schedule worker reconciles one bounded page of saved opportunities every
minute. It derives a model-independent material fingerprint from the exact
reviewed candidate evidence, skills, profile excerpts, prepared posting facts,
and scoring policy selected for that opportunity. An automated evaluation is
shown as current only when its source fingerprint and material fingerprint both
match the reconciled target. Historical automated scores remain available for
audit; source-current human evaluations remain authoritative.

The reconciler uses a durable cursor, a 25-row page limit, and at most three
one-shot attempts per material fingerprint with a 15-minute backoff. A changed
source or candidate material fingerprint resets that bounded retry state. Jobs
carry both source and material fences, so an in-flight result is discarded when
either changes. Candidate reads fail closed: an unavailable evidence collection
does not mark existing evaluations stale or enqueue a broad refresh.

Freshness is eventual: for N previously scored, non-archived opportunities, a
full scan takes approximately `ceil(N / 25)` minutes, plus queue time. Existing
scores without a material fingerprint are hidden until refreshed. The migration
registers one `opportunity-score-refresh` schedule; the schedule and task workers
must both be running. Refresh uses the existing governed intelligence queue and
cannot enable a stopped circuit or bypass its request/token/spend limits.

After three failed attempts for unchanged material, inspect the opportunity's
`scoringRefreshAttempts` / `scoringRefreshNextAttemptAt` fields and its score jobs.
Resolve the provider/evidence error first. An operator can then reset those two
retry fields to zero and null for the affected opportunity; the next scan will
retry it. Historical scores are retained throughout. The executable validation
contract is in [the freshness test matrix](opportunity-score-refresh-test-matrix.md).
