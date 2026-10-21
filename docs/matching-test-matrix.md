# Private staged matching validation

Scope: #198, release #195. Scores describe evidence coverage, not calibrated probability. Real-owner quality targets and latency remain unmeasured until the aggregate evaluator runs in that workspace.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Public requirement coverage | anonymous match | all requirement skills supported | missing/unknown never contradictory; partial conjunction; years scoped | anonymous submitted facts | pure/no writes | Node / N/A SQL | missing fields and unknown seniority | unit `vitest run public-search/match.spec.ts` |
| Private evidence and eligibility | authenticated refresh | skill evidence refs and typed rights | partial/conditional rights remain unknown | full tenant/user/profile tuple | scoped reads | Node / SQLite + PostgreSQL | malformed evidence cannot establish facts | matcher unit + DB suite |
| Governed content cache | explicit enriched refresh | same content reused across postings | different owner/evidence/model misses; <=25 postings and bounded calls; provider failure falls back | verified candidate | native pinned transaction; rollback | Node / SQLite + PostgreSQL | malformed decisions/invalid quotes rejected | cache unit + DB suite |
| Private learning | refresh/evaluation | regularized training split by time | no heldout leakage; no global training; insufficient data uses coverage | candidate only | owned labels/model | Node / SQL scoped stores | missing/unknown decisions excluded | reranker unit |
| Rank currentness | board sorting/private matches | matching source/profile contract | stale source/profile and foreign tuple hidden; failed transaction rolls back | verified candidate | pinned native transaction | SQLite + PostgreSQL | N/A provider | rank integration suite |
| Private HTTP boundary | GET me/matches | authenticated current subject | anonymous/invalid subject deny; no-store on all outcomes | request identity | server authority, no body IDs | SvelteKit | invalid limit rejected | route unit |
| Aggregate evaluator | operator CLI | only aggregate numeric metrics | no row/evidence/owner identifiers exported; absent owner data explicit | explicit owner workspace | scoped read only | Node | N/A no provider | evaluator unit |

Architecture context: SMRT tools are not exposed in this worker; repository `knowledge:architecture-context` fallback is recorded under `/tmp/agent-first-release/match-evidence/architecture.log`. Coordinator owns final repository validation, independent review and ship. Per-slice executable results are appended after implementation.

## Implementation and limits

- Private matching reads live source visibility and current analysis pointers, then scores the bounded catalog before retaining 300 candidates. The catalog bound is 10,000 current postings; exceeding it fails explicitly rather than dropping a first page. Alias resolution preserves C++/C#. Missing facts stay unknown. Related public skills contribute only 0.35 partial coverage; education degree level alone is partial; concurrent employment periods are merged before recency weighting.
- Registered reads refresh ranks with zero provider calls and apply existing requirement/evidence decisions. Explicit enrichment visits at most 25 postings and 75 requirements. Inputs are capped at three evidence items, 4,096 input tokens and 512 output tokens. The pinned extraction route and native governance reserve both private receipt ownership and the existing billed-user spend cap. Model failure preserves deterministic ranking.
- Cache keys include the complete tenant/user/profile tuple, content-hashed requirement, selected evidence, contract and pinned model. An unrelated profile change does not invalidate identical selected evidence. Exact evidence quotes are verified before caching.
- v3 is an additional explicit matching contract. Existing v2 assessment receipt validation is unchanged. Private v3 joins fence owner, all matching material (profile/catalog/model/decisions), live source version/fingerprint, raw skill snapshots, analysis pointer, active posting and source opt-out. Publication revalidates identity/profile and uses a pinned native transaction; PostgreSQL row locks prevent concurrent source updates through commit. An unchanged rank is not rewritten.
- Refresh is lazy at private match reads and board recommendation reads, so profile/source edits invalidate and recompute before returning ranked results. This avoids a cross-user fanout job and leaves nightly paid enrichment opt-in. No private state is written into global skill graphs or public search projections.
- Learned reranking is private and only activates on strict held-out P@10 improvement over baseline; cold start uses deterministic coverage. Returned scores explicitly carry `calibrated: false`. Real-owner NDCG targets, production latency, provider spend, and host behavior are not established by synthetic tests.

## Executed evidence

Local logs: `/tmp/agent-first-release/match-evidence/`.

- `unit-final.log`: 21 passing tests across public/private evidence, cache bounds/reuse/failure, catalog currentness and governance binding. No live provider calls.
- `database-third.log`: native SQLite/PostgreSQL cache/model/rank transactions pass owner isolation, idempotent upsert and atomic rollback; existing query regressions pass (54 passed, 3 environment skips).
- `v3-query-route.log`: 57 passed with the PostgreSQL URL supplied, including native v3 source/profile/analysis/opt-out fences and private endpoint auth/no-store.
- Repository validation and independent final review belong to the release coordinator on the complete integrated tree. Later validation logs supersede these intermediate counts.

Latest matching acceptance run: `ready-suite.log` has **88 passing tests in 11 files**, zero skips, on Node 26.10.0 with both disposable SQL dialects and `MATCH_BENCHMARK=1`. The synthetic 2,700-posting pure matching threshold (<500ms) passed. `governance-native.log` adds **77 passing governance/billing tests**, including native SQLite spend caps and Stage-3 reservation boundary coverage. No production-owner dataset or live provider was used. Package typecheck reports no matching-path diagnostics; unrelated in-flight OAuth integration diagnostics remain for coordinator validation.

Final slice evidence (supersedes intermediate counts): `matching-final.log` — **96 passed, 13 files, zero skips**, including the corrected metric regressions, CLI authority/aggregate-output tests, native SQLite and PostgreSQL store/query checks, and the enabled <500ms synthetic deterministic benchmark. `cli-help.log` confirms the actual `tsx scripts/match-evaluate.ts --help` entry point runs. `cli-types.log` confirms a dedicated TypeScript check of the CLI and its test/import closure passes. `typecheck-ready.log` has no matching diagnostics; remaining errors are the release's pending OAuth package closure. Full real-owner CLI evaluation has not been run because no authorized owner fixture/dataset was supplied; synthetic results are not substituted for the requested owner quality targets.

Operator invocation, using the application's configured database:

```sh
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/match-evaluate.ts \
  --tenant-id TENANT_ID --user-id USER_ID --profile-id PROFILE_ID
```

Selectors do not grant access: the script revalidates live user, tenant, membership/invitation and selected-profile ownership before reading. It emits only aggregate JSON, makes no provider calls, and does not update ranks or models. Cached Stage-3 hit/lookup counts describe this evaluation's cache reads; token spend is zero for this run, not a claim about historical provider spending. Legacy comparison is null when no comparable v2 rows remain.
