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
