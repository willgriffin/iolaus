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

Candidate ownership regression: `scope.profileId` identifies a
`candidate_profiles` row, while `users.profile_id` identifies the separate SMRT
person profile. Admission joins candidate owner and tenant to the active native
user/membership/tenant under the same users-row lock. Ledger fixtures seed both
identities separately; native host coverage admits a valid candidate profile
without matching `users.profile_id` and refuses reassigned/moved/missing profiles
before receipt or source writes. This is a correction to the ownership predicate,
not a new identity contract.

Follow-up evidence: corrected ledger/host unit checks passed 28 cases
(`225-candidate-profile-narrow.log`); the new ordinary native SQLite ownership
case passed (`225-candidate-profile-native-sqlite.log`). The corrected ownership
fixture fails with the pre-fix admission query
(`225-candidate-profile-base.log`). PostgreSQL rerun remains coordinator-owned.

Published PostgreSQL schema boundary: native `users.id`, `tenants.id`,
`memberships.user_id` and `memberships.tenant_id` are UUID columns;
CandidateProfile `owner_user_id` and `tenant_id` are text fields. Admission casts
both sides of cross-record identity joins to text using syntax also supported by
SQLite. The PostgreSQL contract asserts those actual schema types before an
ordinary successful admission. Model key types are unchanged; schema migration
is not used to avoid the cross-package comparison. Worker SQLite regression
results are in `225-uuid-join-sqlite.log`; actual PostgreSQL qualification must be
rerun by the coordinator after this correction.
