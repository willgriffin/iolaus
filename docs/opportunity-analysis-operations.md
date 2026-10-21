# Opportunity analysis operations

Analysis is platform-funded and candidate-free. The deterministic artifact remains readable when enrichment is disabled, malformed, over budget, or fails. Existing AI kill switches, opportunity-intelligence controls, global/provider quotas and gateway limits apply. The provider is pinned to `openai/gpt-6-luna`; no fallback model or price override is introduced.

## Migration and bounded backfill

Run the normal database migration first. It creates the analysis objects plus `opportunity_analysis_windows`. The latter holds admission counts only, with no candidate or posting payload. Operators can then run:

```sh
pnpm --filter @willgriffin/iolaus-site opportunities:analyze --backfill --max 100
pnpm --filter @willgriffin/iolaus-site opportunities:analyze --backfill --max 100 --cursor TOKEN
pnpm --filter @willgriffin/iolaus-site opportunities:analyze --backfill --max 10 --enrich --budget-micros 50000
pnpm --filter @willgriffin/iolaus-site opportunities:analyze --prune
```

`--enrich` is explicitly paid work; the budget is an integer number of USD micros. Without it, the command performs deterministic analysis only. Output contains aggregate counts and an opaque `nextCursor`. Persist that cursor outside request logs and pass it to resume; null means the current scan ended. Failed rows count as attempted and are skipped by that cursor; start a later scan to retry them. `windowExhausted` means resume after UTC rollover with the returned cursor. `--max` must be 1–300; it is never silently expanded.

Admission is shared by native jobs and the CLI and limited to 300 attempted postings per UTC hour **and day**, across replicas. Every paid attempt also reserves against a durable hourly `AgentRun` whose call/token/spend ceilings do not exceed the existing per-run configuration. An invocation can lower the hourly spend ceiling but cannot raise it or reset consumed funds. Consequently an operator's requested `--max` may exceed the number that can be enriched under existing run/global caps; counts distinguish deterministic and enriched results. No new budget window is associated with a source crawl, and analysis does not consume the crawl enqueue allowance.

The new queue is `opportunity-analysis`, using the native Opportunity `analyzeSourcePosting` method. It is excluded from public generated tools. The durable job contains only opportunity/source identity and explicit enrichment settings. Execution verifies the active runner, persisted target and arguments, current source version, and shared admission. Superseded source versions return `obsolete`. This queue requires the ordinary jobs worker and repository queue configuration; a CLI run is not evidence that a deployed worker drains it.

## Provider and retry behavior

The prompt contains only the verified posting title and exact raw description. It is bounded to 60,000 description characters and a conservative 24,000 input-token ceiling; oversized input retains deterministic coverage rather than being silently truncated. Output must contain bounded skills, requirement clauses and short source-grounded summary clauses. Exact UTF-16 spans, quotations, canonical skill aliases, negation, PII and enum/type constraints are validated before the result becomes reusable. Compensation and authoritative eligibility remain the deterministic source projection.

The idempotency key includes source content identity, version, exact serialized messages (including whitespace), model, prompt and schema versions. Successful output is reused without another provider charge. The global `opportunity-analysis` contract alone supports up to three total provider attempts for a failed key; other intelligence features keep their existing terminal-failure behavior. Retry hands the locked result to a new request ID without erasing prior terminal request/accounting rows. Every attempt passes full budget/provider/circuit admission. Concurrent duplicates cannot invoke twice; a refusal rolls back the handover. Retries use bounded backoff, and a circuit/budget refusal stops immediately. Exhausted terminal keys need operator investigation; the adapter never changes keys to evade the limit.

Provider usage must be present and valid. The ledger records actual usage when available and conservative reserved cost on an uncertain failure; missing usage fails closed under the existing circuit policy. Public analysis provenance carries the recorded request/model/prompt/tokens/cost, never private user billing or workspace state.

## Retention and verification

Pruning is transactional and bounded to 300 old candidates per invocation. It retains current pointers, anything newer than 30 days, malformed requirement metadata, any analysis whose requirement hashes are referenced by private decisions, and source versions referenced by private recommendation ranks. Only hash existence is queried; private decision payloads are never read into shared artifacts. Junction rows and eligible analyses are removed together. PostgreSQL locks opportunities in the same order as publication to prevent a stale prune racing a new pointer.

Focused checks (use the repository-pinned Node/pnpm):

```sh
ANALYSIS_LEDGER_TEST_DATABASE_URL=postgres://.../test_database \
  pnpm --filter @willgriffin/iolaus-site exec vitest run \
  src/lib/server/opportunity-analysis-enrichment.spec.ts \
  src/lib/server/opportunity-analysis-provider.spec.ts \
  src/lib/server/opportunity-analysis-job.spec.ts \
  src/lib/server/opportunity-analysis-maintenance.integration.spec.ts \
  src/lib/server/opportunity-analysis-retry.integration.spec.ts \
  src/lib/server/opportunity-intelligence-governance.sqlite.spec.ts \
  src/lib/server/opportunity-intelligence-governance.spec.ts \
  src/lib/server/opportunity-intelligence-governance.ai-usage.spec.ts
```

The integration suites create isolated temporary PostgreSQL schemas and delete them after the test. They require a disposable test database with schema creation rights. SQLite suites use temporary files; retry coverage includes both supported SQLite drivers. Provider protocol tests mock transport and do not make paid calls. Native UUID backfill/window tests, real database retry accounting, rollback, quota refusal and retained private references are exercised separately.

Live enrichment cost (target <= $0.002/posting), deployed queue drain, production caps and backlog completion remain operational acceptance steps. Local fixtures do not establish those results. Do not run an unbounded live backfill to collect evidence.
