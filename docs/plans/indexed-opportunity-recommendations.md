# Indexed opportunity recommendations

Tracked in https://github.com/willgriffin/iolaus/issues/163.

## Outcome

Sorting, filtering and paging opportunities must use persisted, indexed recommendation values. The displayed recommendation badge and ordering must agree. Reads must not replay every opportunity's provider receipts or rebuild a large SQL CASE expression. Existing assessments and human decisions remain intact; backfill makes no AI calls.

## Upstream decision

Initial upstream audit recommends an ordinary private SMRT model for the current-match projection. `smrt-reports` supplies aggregate materialization and refresh infrastructure, but independent aggregates cannot safely select one coherent latest assessment and its proof. Reuse native SMRT models, schema migrations, indexes, transaction and query facilities. Do not build an application-specific generic projection framework. The completed installed SMRT0.52.0 audit finds no upstream change necessary. Use native `@smrt` conflictColumns and index declarations (`name`, `columns`, optional `unique`/`where`), public `withDatabase`/`withTransaction`, and `save(expectedUpdatedAt)`/`claimRevision`. References: installed core registry/types.d.ts314+, schema/types.d.ts78+, object.d.ts287/729; upstream core/src/object.ts794 transaction,2640 afterSave,2948 claim. afterSave is not afterCommit; cache invalidation occurs before commit. ChangeFeed is best effort and raw writes bypass it. Do not use events, TTL or getTableVersion as sole freshness. Current candidate/question semantic fingerprints are read once per request and pinned in the SQL join with live source fingerprint/version.

## Execution

1. Measure current ascending/descending sorting and pagination on the daily-use database. Capture query counts and representative SQL plans without retaining private record contents.
2. Define a current-match record uniquely scoped by tenant, user, candidate profile and opportunity. Retain the authoritative assessment reference, recommendation, coverage/conflict tie-breakers, and exact source, candidate, question and scoring-contract identities. Historical assessments remain the source of evidence.
3. Publish the derived record only through the existing freshly authorized, receipt-verified assessment workflow. Use atomic publication and reject superseded inputs. Cover rollback, concurrency and idempotent repair; an older completion must not overwrite a newer current result.
4. Make freshness inexpensive and explicit. Evaluate candidate/question identity once per request, not per opportunity; compare source identity in the database query. Relevant career, profile, question, source and contract changes must prevent stale values from appearing current. TTL and asynchronous notifications alone cannot establish correctness.
5. Add scoped composite indexes aligned with real filters, recommendation order and deterministic tie-breaks. Apply filtering, sorting and pagination in SQL; load detailed evidence for the displayed page or opened assessment only. Keep unknown/stale results distinct from low scores and consistently positioned in both sort directions.
6. Backfill current verified V8 and V9 results in bounded resumable batches, with no JEV or other model calls. Record per-row outcomes and preserve reviews, applications, decisions, profile, source captures and assessment history.
7. Validate correctness and performance, run independent review, then exercise the daily-use list in the browser. Follow the user's local-development workflow; no production deployment or release ceremony is included.

## Work ownership

- Iolaus worker (`skill_matching`): detailed schema and freshness design, tracked implementation, query integration, migrations, backfill, tests, performance measurements and review coordination.
- Upstream audit worker (`daily_guard_finish`): exact installed SMRT/report/core capability assessment and reusable API guidance. Any required upstream implementation gets its own tracked scope and sibling worktree before edits.
- Coordinator: resolve scope decisions, relay findings and keep the user-facing plan current.

## Acceptance evidence

- Ascending/descending results equal badge values globally before pagination; ties and nulls are deterministic.
- Existing filtering, review modes and triage use consistent ranking semantics.
- Source, candidate and question changes invalidate affected results, including concurrent assessment completion.
- Cross-user/profile/tenant reads and writes are denied; projection rows cannot substitute for publication authority.
- Retry, rollback and resumable backfill preserve a coherent current result and history.
- Backfill invokes no AI provider; human-data preservation checks pass.
- Record before/after cold and warm timings, SQL plans and query counts on the current dataset; include a larger fixture where useful. Verify no full receipt replay occurs on re-sort and that the database uses the intended indexed path.

Status: issue163 claim6002935681 active; upstream audit and native read-only baseline complete; implementation and isolated native validation underway. High-risk trigger: new private persisted ranking and transactional publication cross ownership/currentness boundaries. Final independent review must meet review-cycle high-risk floor. No provider/payment behavior change. User explicitly authorizes orchestration and local daily-use delivery without commit/push/PR/release. Preserve unrelated edits.


## Detailed gates and worker handoffs

1. Freeze before-task copies of affected files. Capture cold first and warm repeat timings for recommendation asc/desc first/later pages, score and best on the same2606-row native dataset. Record ordering digests, page SQL bytes/parameter counts, and instrumented query count with explicit coverage caveat. Preserve private data outside the repository. SSR uses an isolated Vite cache; no daily app restart.
2. Persistence worker owns the private domain model, schema/index declaration, projection adapter and its tests. Select one coherent verified assessment, never independent aggregate maxima. Complete ownership tuple, source version/fingerprint, exact candidate/question fingerprints, supported V8/V9 contract/model, schema version and native proof identity accompany all scalar values. The unique owner/opportunity row uses revision CAS; full result dominates a title-only result for the same semantic context, and older proof cannot overwrite newer proof. Missing/stale/unestablished recommendation is NULL.
3. Publication worker owns the screening publication seam; coordinator owns the scope export and integration. Read exact current semantic scope once; fresh principal/capability and source/material fences remain authoritative. Save assessment and ranking in the same short pinned native transaction; all participating reads/writes must use that executor. Inject failure to prove rollback, then retry a reused receipt to repair missing projection without a provider call. A projection never authorizes private evidence access.
4. Query worker owns native ranking SQL and badge/list projection readers. LEFT JOIN by full owner tuple, current candidate/questions and supported semantic contract/model/schema plus live source tuple. Apply filters, ordering and pagination in SQL. Explicit recommendation/score has no hidden conflict priority; best keeps its explicit conflict/coverage policy. Unknown last both ways, deterministic updatedAt/ID ties. Review-all, review filters and triage must use the same value.
5. Coordinator owns bounded resumable backfill of existing V8/V9 receipts. Re-verify exact native q/r/run authority/currentness; page to completion rather than cap/drop rows. Record projected/already-present/stale/ambiguous outcomes. Repeat/interrupted execution does not duplicate rows or calls; provider mock/live call counters must remain zero. Preserve human/source/profile/application/decision hashes before and after.
6. Validate supported PostgreSQL and SQLite migration/status, schema binding, rollback, CAS, currentness and query behavior. Compare regression tests against captured base; record unrelated failures honestly. Benchmark head using the exact baseline requests and digest checks. Capture EXPLAIN index usage and bounded query counts; use a10k fixture for scaling,50k only if a concrete planner concern requires it.
7. Freeze final source/evidence, run SMRT review then independent read-only high-risk review, fix accepted blockers only. Perform verified backfill and daily badge/sort/page QA. Update this plan with safe aggregate evidence, hand off claim in place and remove implementation label. No release ceremony under the user's override.

Workers are not alone and must never revert others. Agree exact files and shared contracts before editing. Do not let query/persistence workers both edit the screening service; coordinator integrates that seam. Source generations may be a later optimization only after every relevant writer, including raw writes/deletes/onboarding/accepted facts, atomically participates.

## Behavior-to-test contract

| Invariant | Trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Test/evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Badge/sort parity | Asc/desc and first/later page | Exact persisted percentage orders before pagination | Unknown/title-only/stale last both directions; stable ties | Active owned workspace | Native SQL join/order/page | PostgreSQL+SQLite | NULL/unknown values | Query fixtures, browser/daily digest; Vitest |
| Ownership | Foreign tenant/user/profile, inactive/revoked principal | Complete tuple permitted | Actor×resource×active-context mismatches deny/neutral | Fresh executeAsPrincipal | Native capability fences | Both dialects | Missing/malformed subject | Adapter/publication allow+deny matrix |
| Coherent atomic publication | New or reused verified receipt | Assessment/rank same proof and scalar values | Injected failure rolls back; mixed/forged/incomplete receipts rejected | Owned current candidate | Same pinned native transaction | Both dialects | Missing/failed q/r/run, rollback | Native persistence/service tests |
| Candidate currentness | Career/resume/accepted fact/note/confirmation edit | Same semantic data remains current | Applicable edit stale; pending metadata/timestamp-only edit unchanged | Candidate owner | Once-per-request semantic scope, SQL fingerprint guard | Both dialects | Malformed canonical fact | Source-by-source freshness tests |
| Source/questions/contracts | Recapture/rule edit/toggle/version change | Exact current identities; V8/V9 coexist | Changed source/rule, missing/retired/unknown contract neutral | Owner and available posting | Native snapshot + current-source SQL join | Both dialects | Unknown enum/schema/model | Service/query regression tests |
| Concurrent publication/read | Edit or revocation during proof/write | Coherent serialized result or neutral stale | Old completion cannot publish current stale score | Owned native context | Revision CAS and explicit executor affinity | Both dialects | Concurrent edit, permission change | Deterministic barriers/native integration |
| Backfill/retry | Existing2606 outcomes or interrupted batch | Current receipts projected; repeated operation no duplicate | Stale/ambiguous/missing receipt skipped; zero AI | Authorized local operator | Bounded native transactions/lifecycle locks | PostgreSQL daily+SQLite fixture | Partial failure/reused result | Backfill tests, native ledger/provider-count proof |
| Filter/triage policy | Review modes, best/score, filters | Same ranks/counts across paths | Legacy score cannot override stale assessed row | Active owner | WHERE/order before LIMIT | Both dialects | Empty inventory/disabled screening | Existing+new query/filter tests |
| Indexed performance |2606 cold/warm,10k fixture | Bounded query count and indexed plan | Corpus replay/CASE SQL or slow plan detected | Same benchmark subject | Same native SQL executor | Both dialects | No provider calls | Before/after timings, EXPLAIN and count scope |
| Data preservation | Migration/backfill | Human/profile/source/application/decision hashes unchanged | Failure recoverable without altering assessments/history | Authorized local operator | Native migration+bounded backfill | Both dialects | Migration/status errors | db:migrate/db:status, final read-only audit |

Baseline artifacts and exact final schema/index plan will be appended when measured. N/A: no new model/provider contract or generative output; no provider calls are part of this work. The projection is an application domain record using upstream facilities, not a generic materialization library.

## Measured base (daily PostgreSQL,2606 opportunities)

Read-only isolated-SSR benchmark,100-row pages, `reviewFilter=all`, default remaining filters. Counts instrument the shared native DB adapter; retain this exact instrumentation scope for head comparison. No provider calls.

| Sort/direction/page | Cold/warm | Wall ms | Observed queries | Page SQL bytes | Parameters |
| --- | --- | --- | --- | --- | --- |
| recommendation/desc/offset0 | cold | 24919 | 11286 | 488256 | 14575 |
| recommendation/desc/offset0 | warm | 22642 | 11276 | 488256 | 14575 |
| recommendation/asc/offset0 | warm | 23003 | 11276 | 488255 | 14575 |
| recommendation/asc/offset100 | warm | 22304 | 11276 | 488255 | 14575 |
| score/desc/offset100 | warm | 22370 | 11276 | 488256 | 14575 |
| best/desc/offset0 | warm | 27178 | 11276 | 845698 | 24999 |

Cold/warm repeated recommendation-desc returned the same ordering digest. Baseline artifact: `/tmp/iolaus-indexed-rank-baseline.json`; private data is excluded from this document. Head must eliminate corpus-sized receipt replay and CASE SQL, not merely reduce elapsed time by warming caches.

## Initial implementation validation (v1)

Native persistence validation: eight tests passed, including isolated PostgreSQL registered schema/migration/index binding, concurrent insert-only publication and transaction rollback. SQL ranking:55 tests passed with PostgreSQL and SQLite execution, ownership/source-currentness/null/tie cases. No live schema migration or backfill has run yet. Publication recovery, final currentness fences and combined validation remain required before operations.

Combined isolated validation:97/97 tests passed with both PostgreSQL gates enabled; Svelte check0 errors/0 warnings. PostgreSQL fixtures use disposable schemas or connection-local TEMP tables, not application tables. Native read-only plan captured2606 IDs and preservation hashes for human review, applications, decisions, source captures, assessment history, requests and profile. No projection/backfill or provider calls have run.

Final-index10k PostgreSQL EXPLAIN: selective owner/material lookup uses the declared current_lookup index; direct selective recommendation uses backward recommendation_order scan and incremental tie sort. The complete source-current LEFT JOIN uses a hash join and top-N sort for unknown-last global ordering. This is intentional SQL ordering of the joined relation, not a claim that the index eliminates every sort. Fixtures use no planner overrides and roll back. Evidence: `/tmp/iolaus-indexed-rank-163-explain.sql` and `.out`.

## Release refinement: projection v2

Derived `requiredSkills` and `preferredSkills` participate in assessment inputs and can change independently of captured source text. The v2 private rank therefore retains exact raw snapshots of both fields. SQL ordering and the current detail/badge readers require those snapshots and the complete proof/scalar identity to agree. Old v1 ranks remain neutral until repaired from verified saved receipts. This is a projection change; the V8/V9 provider contracts remain unchanged.

Publication loads and locks one opportunity row on the transaction executor and uses that same row for final input preparation and snapshot capture. This prevents a concurrent derived-field edit from pairing an old receipt with newer snapshots. Formatting-only snapshot changes may reuse the same verified receipt without another provider call. Additive populated-schema migration, executor affinity, derived-field mutation, detail/list parity and PostgreSQL binding regressions are included in release validation.

The initial daily migration/backfill was paused after a verified preservation audit. Final v2 migration, backfill and benchmark qualification uses an isolated private database clone; publishing this release PR does not claim a live daily or production rollout. Final executable receipts and exact source identity are recorded with release issue #164.
