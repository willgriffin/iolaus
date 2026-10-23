# Durable private source admission (#225)

Named high risk: privacy lifecycle and account deletion. Implementation uses the
existing native users row as the stable transaction gate; advisory sessions remain
normal capacity/drain aids. No lease, age, or disconnected session clears evidence.

| Behavior / reachable trigger | Positive | Negative / failure | Actor/context | Executor/runtime | External edge | Level / command |
|---|---|---|---|---|---|---|
| Receive before source persistence | Commit fresh invocation marker before native receive; accepted/duplicate removes its own row | Retry, rejected, unknown, thrown provider result leaves marker; denied admission never invokes receive | Active owner + profile + tenant | Native transaction; SQLite and PostgreSQL | Native source preservation promise | Host unit and admission integration specs |
| Admission closure and repeat deletion | Atomic started record closes admission, retry reuses record | Unresolved marker returns pending before any purge/identity deletion | Same account, independent other owner | Same native users-row lock and executor; SQLite writer / PostgreSQL FOR UPDATE | Account deletion response 503, CLI typed pending error | Admission integration; account integration |
| Scope and identity | Valid active owner admitted | Wrong tenant/profile, missing/inactive identity/membership/tenant denied; scope-mismatched resolution preserves marker | Two actors, own/cross resources | Same gate transaction both dialects | No generated API/CLI/MCP access | Integration + exposure unit |
| Rollback / persistence | A committed marker survives handles/retries; explicit successful resolution permits deletion | Transaction abort leaves no half admission; missing ledger fails closed | Native account scope | Adapter transaction affinity | No pool/engine substitute | Integration |
| Provider uncertainty recovery | Operator preserves locators and proves all writers quiescent before reconciling | No timeout/age expiry or automatic clearing; incomplete evidence blocks completion | Operator only | Retained account + deletion + write rows | Actual provider object reconciliation is deployment qualification | Runbook; provider qualification remains coordinator-owned |

Focused command: `pnpm --filter @willgriffin/iolaus-site exec vitest run
src/lib/server/resume-import-write-admission.integration.spec.ts
src/lib/server/resume-import-host.spec.ts src/lib/server/account-deletion.spec.ts
src/lib/server/api-exposure.spec.ts`. PostgreSQL ordinary admission tests use
`RESUME_WRITE_ADMISSION_POSTGRES_TEST_DATABASE_URL` and a temporary isolated schema;
they must be executed by the integration coordinator. No session termination or
fault-injection workflow is executed or reproduced here. The stopped dirty host
integration artifact is preserved separately.

Evidence: the six host admission/outcome regressions fail against a temporary
copy of the pre-change host and pass after the fix (`225-base-host.log`). No
production file was swapped and no stopped workflow was executed. Focused host,
admission SQLite, exposure, account policy/page and database class-list tests:
`225-narrow-final.log`. Existing SQLite deletion contract: 17 pass
(`225-account-sqlite.log`). PostgreSQL ordinary admission cases are authored for
the integration coordinator, unexecuted by the worker. Actual provider and
deployment qualification remains open; mocks do not establish drain.
