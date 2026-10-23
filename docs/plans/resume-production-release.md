# Private resume production qualification and release

Owner request: qualify and release the merged resume slice, starting with #219.
Epic: https://github.com/willgriffin/iolaus/issues/221
Starting source: `c60a46751a79731a692ad7c17b2f1ec3a6542965` (merged #210/#218).

## Session train declaration

- Repository: `willgriffin/iolaus`; release line: next compatible feature release
  after v0.5.1 (choose the version using repository release conventions).
- One branch: `codex/resume-production`; one ready pull request; one attributed
  commit per item with `Refs #N`. Close completed member issues from that PR using a separate closing keyword
  for each issue. Keep #221 open until deployed qualification and release finish.
- Ordered items: #219 lifecycle capacity, #223 released dependency closure,
  #222 private hosted storage, #224 extractor image/release, #225 durable
  source-write admission, #226 retention disclosure, #227 Garage recovery, then integrated
  qualification. Dependency inventory may run alongside #219; workers must
  never share file ownership at the same time.
- Siblings: `/Users/will/Work/_trees/resume-production/{iolaus,iac,sdk,smrt}`.
  Create other repositories' worktrees only when needed. Preserve existing
  previews, user resumes, unrelated worktrees, changes and service stacks.
- IaC companion train: https://github.com/happyvertical/iac/issues/1688 (additive
  private S3 staging), then https://github.com/happyvertical/iac/issues/2326
  (qualified rollout); one sibling branch/PR, one attributed commit per issue
  and required safety checks. Upstream defects similarly
  get their own issue, sibling worktree, reviewed release and downstream bump.
- Use an explicitly selected balanced-tier foreman/implementation model, fastest
  watchers/bookkeeping, advanced only for ambiguous reasoning. Current Codex map:
  balanced `gpt-6.1-sol`, fastest `gpt-5.6-luna`, advanced `gpt-6-astra`.

## Scope and authorization

Deliver private PDF upload -> durable receipt -> worker extraction -> cited,
editable review -> explicit selective import. Retain owner/tenant authorization,
deletion fencing, retention/recovery, no automatic application/submission and no
public resume publication. Public-search/OAuth enablement, company/directory
intake, legacy data migration and destructive cutover are outside this slice.

The user requested qualification and release. Build reviewable changes and
release artifacts, enforce repository merge gates, and deploy only through
declared GitOps. Never apply manifests imperatively, disclose secrets or mutate
real candidate data for tests. A separate explicit authorization is required if
an actual remaining repository rule calls for approval of a concrete destructive
or credential operation; prepare its reviewable result before asking.

## Item acceptance and implementation boundaries

### 1. Lifecycle capacity (#219) — high risk: account lifecycle/deletion fence

`resume-import-account-fence.ts` pins one PostgreSQL client while native ingestion
uses another connection from the same bounded pool. Default hosted main max5 and
probe max1 across two web replicas, surge, task and schedule processes already
consume the documented runtime role budget30. Do not add another pool or raise
ceilings to hide starvation.

Use nonqueued, pool-budget-derived domain admission before pinned acquisition;
pending acquisition, same-account lock waiting, execution and cleanup count
against admission. At max5, two fence operations can coexist with their two
domain transactions and remaining query capacity. Smaller pools must refuse
safely when they cannot support this budget. Preserve independent-account
parallelism and the cross-process account advisory lock; a semaphore is not a
substitute for deletion fencing. Use native `connectionTimeoutMillis` consistently
on the shared pool, not a leaking Promise.race around an uncancellable acquire.
Map capacity/acquire/lock refusals to typed actionable retry results without
misreporting a partially committed action failure as a harmless busy refusal.

Qualify actual nested transaction demand, role limits and progress under bursts.
Do not assert a loss-safe fence based solely on `isActive()`. The earlier
advisory-session-loss fault-injection proposal was rejected by automatic review
and was not executed. Do not retry it through another workflow. #225 adds a
nonexpiring durable source-write ledger and atomic admission/deletion gate,
qualified through ordinary PostgreSQL and SQLite transactions. Unresolved writes
keep deletion pending until documented operator reconciliation; elapsed time or
session disappearance never proves a write finished.

### 2. Released dependency closure (#223)

Inventory published compatible versions before editing. The existing
smrt-ingestion0.55.17 repack rebinds SMRT0.55.9/SDK0.103.1 and explicitly lacks
published-release qualification. Select the smallest coherent supported set
containing required behavior. Verify actual installed imports, peers, native
adapters and frozen lockfile; avoid an unrelated whole-stack upgrade. Preserve
or replace provenance truthfully; never relabel a local repack as upstream proof.

### 3. Durable private hosted assets (#222) — high risk: private data lifecycle

`resume-import-runtime.ts:createResumeImportAssets` currently forces local
storage. Hosted replicas/workers have read-only roots and ephemeral writable
mounts; the deployment contract requires durable external S3-compatible storage.
Resolve the configured private provider through released AssetRuntime primitives.
Keep local defaults for local installations and refuse missing hosted storage;
do not silently fall back locally or add a replica-specific volume workaround.
Prove cross-process read/processing, restart durability, scoped export/deletion,
retention, revoked access and recoverable provider errors. Inspect IaC#1688 and
current storage metadata before provisioning a duplicate target. Do not touch
legacy resume assets or plaintext credentials.

### 4. Extractor release (#224) — high risk: image/release/deployment lifecycle

The existing workflow publishes only the site. Add same-source extractor
candidate/publication, immutable digest, revision/lock provenance, SBOM and
security/resource qualification. Test its actual non-root/read-only/drop-caps,
bounded temp/output/time/memory, cancellation/cleanup and zero-egress envelope.
IaC consumes a real qualified digest; no placeholder or floating production tag.

### 5. Integrated GitOps qualification (IaC#2326)

Reconcile the latest IaC main and live site digest first; the old local checkout
is behind live. Preserve the separate public-search PR#2228 and feature flags.
Declare extractor resources, selected private ingress, narrow web/worker egress,
endpoint variables/body limits and Paddle namespace label. Existing PaddleOCR
waker is ready with a sleeping backend; health alone is not parsing proof.
Qualify a synthetic cold scanned PDF within Iolaus's120s bound, no automatic paid
retries. Use current governed AI profile/pricing and fictional input only.

## Behavior-to-test matrix

| Invariant / trigger | Positive | Failure / negative | Actor / executor / runtime | Edge / level / command |
|---|---|---|---|---|
| Peak lifecycle work | Two distinct owners progress at max5; nested native work and unrelated CRUD/worker reads complete | Excess admission is immediate bounded refusal; max1/2 safe; failed acquire/lock/action/cleanup reclaims permits | Owner scopes; actual native PostgreSQL pool/role + SQLite regression | Native acquisition queue timeout, no leaked late client; focused fence/native host specs |
| Upload vs deletion | Same-account deletion waits before enumerating receipts | Different owners independent; deletion-started refuses new bytes; advisory-session loss cannot silently violate cleanup | Two native handles/processes, real transactions/authority, PostgreSQL; SQLite keyed fence | Ordinary transaction, admission, rollback/retry and pending-marker cases; native host/account tests; rejected session-loss fault injection not executed |
| Private source assets | Another web/worker process reads original and evidence after restart | Wrong owner/context, missing config, unavailable store, interrupted write/deletion fail safely | Two owners/tenants; native AssetRuntime + private object store; SQLite/PostgreSQL metadata | Real provider allow/deny, retention/export/delete/retry; focused + integrated provider tests |
| Account deletion disclosure (#226): open enabled account page before confirming | Immediate access removal, uploaded-original-only private 30-day post-deletion recovery and asynchronous lifecycle removal are visible | Disabled mode has no deletion affordance; acknowledgement/email/phrase and verified-session refusals remain enforced; no generated-PDF migration promise | Account owner; rendered Svelte page + existing server-action tests; database executor/dialect N/A (copy only, no mutation changes) | Private version lifecycle policy is an operator qualification gate; SSR regression + action unit tests: `pnpm --filter @willgriffin/iolaus-site exec vitest run src/routes/admin/account/account-page.spec.ts` |
| Dependency consumption | Frozen install and actual runtime imports/peers work | Missing/malformed/native failure and incompatible copies detectable | Installed released SDK/SMRT + Node26.10/pnpm11.25 | Native adapters, package/source provenance; archive checks and host/extraction specs |
| Extraction envelope | Text and cold scanned fixtures yield editable cited proposals | Invalid/oversize/timeout/output/disconnect, denied network, revoked receipt do not apply data | Synthetic private assets, actual candidate image/OCR, authenticated scopes | Process tests + rendered/security checks + browser upload/review/apply |
| Durable operation | Restart/retry and selective import preserve complete evidence | Stale revision, repeated receive/apply, failed cleanup, account deletion remain bounded and safe | Native ingestion, two users, worker, actual storage and PostgreSQL | Existing lifecycle suites and one final end-to-end rehearsal |
| Release and rollout | Site/extractor same revision; immutable digests and exact config deployed | Missing prerequisite blocks rollout; flag rollback preserves private data; no public exposure | Reviewed images, GitHub/Flux ownership, production role/proxy/network | Candidate parity, migration/status, IaC contracts, dated rollout/rollback evidence |

Workers add the narrow regression tests and self-review; never run containers or
full repository suites per item. The integration coordinator alone runs the one
branch-named compose project (`codex-resume-production`) and tears it down before
handoff/ship. If a native service is required, provide it at that integration
stage; mocks are not evidence for PostgreSQL pool or actual object-store behavior.

## Integrated validation and release exit

Use Node26.10.0 and pnpm11.25.0; frozen install. Run narrow checks first, then once
on the integrated tree: `pnpm format-check`, `pnpm lint`, `pnpm check`, `pnpm test`,
`pnpm build`, strict `pnpm knowledge:check`; native migration/status for the
isolated selected database; full E2E/typecheck and the declared live service
rehearsals. Full logs outside source; transcript only status/failure excerpts.
No `cluster-test` command is currently available; recheck before heavy runs.

Run one integrated high-risk review-cycle at the current policy's advanced tier
on the exact committed branch; batch accepted blockers before one recall and
respect its token cap. Fresh SMRT domain checks/context precede model review.
Publish a ready PR, hand off claims and watch required CI/approvals. Release only
the accepted commit, pin both digests in the reviewed IaC change, then let normal
GitHub/Flux reconciliation perform delivery. Record deployed revisions, service
health plus actual PDF workflow results, capacity/storage/OCR qualification and
rollback checks. Do not mark #221 complete merely because app code is merged.

## Qualification checkpoint (2026-10-22)

- #219 implementation commit `acc54a6fee724a5f7f0f42659dcbcc36f80fa225`.
  Focused unit/SQLite regressions pass; six admission cases fail on the starting
  main revision and pass after the fix. Coordinator executed all three actual
  PostgreSQL18 capacity/timeout/cross-handle scenarios successfully, evidence
  `/tmp/iolaus-resume-production/219-native-capacity.log`. Requalify under the
  published dependency candidate. The later #225 durable ledger replaces the
  unsupported session-only safety claim; rejected fault injection was not run.
- Smallest published dependency candidate: SMRT0.55.19 and SDK0.103.5, PDF0.66.0,
  OCR0.61.6 and Sharp0.35.5. Earlier family releases omit required OAuth or server
  exports. Registry presence/source inventory is not runtime compatibility proof.
- IaC current main and live Flux agree at `cd163f27`. Active runtime selects the
  terminal `score-refresh-116-promote` overlay and `iolaus-final-runtime-1810-v2`
  Secret, not the historical base runtime Secret. Add a new terminal overlay;
  preserve historical cutover gates and the single Flux runtime owner.
- No qualified native S3 target was found. IaC#1688 is resumed additively; preserve
  Garage and all legacy objects. Use a separate ingestion provider configuration
  and namespace-scoped SOPS Secret, rather than changing legacy asset endpoints.
  Cloud apply uses the existing reviewed workflow; sensitive outputs must stream
  directly to SOPS custody without appearing in logs.

### Account deletion disclosure (#226)

The owner approved a 30-day recovery period for noncurrent **uploaded original
PDF** versions after deletion, plus asynchronous lifecycle processing. Generated
PDFs retain their existing storage and are not migrated. Ingestion's current
30-day source-evidence expiry starts at upload and remains a separate rule;
active-original lifetime is unchanged. UI, storage, deployment and account-data
docs disclose these boundaries. Actual provider versioning/lifecycle enforcement
remains part of #222/IaC qualification, not evidence supplied by copy tests.

Regression evidence: the enabled-page disclosure test fails against the prior
copy (1 failed, 14 passed), saved outside source at
`/tmp/iolaus-resume-production/226-base.log`. The existing action cases cover
unchecked acknowledgement, wrong email/phrase, unverified and terminal sessions,
private mode and safe deletion failures. No schema, dependency or mutation change.

Head validation: account-page spec passes all 15 cases, including both rendered
copy cases; targeted Biome check and `git diff --check` pass. Head log:
`/tmp/iolaus-resume-production/226-head-node26.log`. Full branch validation, browser
layout and provider lifecycle qualification remain integration responsibilities.


### Current integration checkpoint and Garage selection (2026-10-23 UTC)

- The owner selected the existing cluster Garage instead of provisioning AWS.
  IaC PR2340 is merged as inactive preparation only; no AWS apply or credentials
  retrieval occurred. Its automatic plan also contained unrelated mail DNS
  drift, which was not applied. Stop AWS provisioning and keep all legacy
  objects, generated PDF storage and existing Flux ownership intact.
- Read-only cluster inventory confirms the Garage gateways still run 1.0.1.
  Garage does not expose S3 bucket versioning; the user-approved 30-day recovery
  behavior needs an explicitly qualified application-managed mechanism, rather
  than claims about unsupported noncurrent versions. Private access, native
  write semantics, transport and retention remain release gates.
- Current integrated checks: format/lint/check/build and strict SMRT knowledge
  checks passed; server tests 4590 passed/195 skipped, browser components48
  passed, resume21 passed. Native PostgreSQL18 lifecycle suite66 passed/2 skipped.
  Full E2E88 passed/155 opt-in skipped with one geometry regression; that test
  was repaired and its focused rerun passed. Reconcile these results with every
  later changed behavior; do not report opt-in skips as executed qualification.
- Disposable PostgreSQL maintenance migration, status and idempotent rerun pass.
  Production still requires the declared offline migration and permission gates.
- Actual extractor read-only/no-network envelope and text/scanned fixtures pass.
  Cold Paddle OCR fictional scanned input succeeded in69.3 seconds; this is not
  namespace CNI proof. Site image builds. Final image source labels, immutable
  registry pair, attestations, supply-chain disposition and namespace policy
  proof remain release gates.
- Dependency audit findings are being assessed by actual execution path and
  patched narrowly under #223; neither audit counts nor SBOM generation alone
  prove the release safe. Full logs and scanner results remain outside source in
  `/tmp/iolaus-resume-production`; review the exact final tree before publication.


### Garage recovery implementation and provider evidence

#227 adds app-managed original-PDF quarantine and minimal durable tombstones,
not Garage versioning. Revoked original bytes immediately become unavailable
through normal app reads/writes; operator recovery requires explicit actor, tenant,
ledger and destination authority, a durable audit and checksum verification.
The first durable revocation/expiry deadline never extends on retry. Independent
purge retains tombstones and refuses to claim physical finality while source
write markers remain unresolved. Generated PDFs and derived extraction deletion
retain their existing behavior. Local SQLite defaults remain supported.

Cluster Garage transport is an explicit deployment choice: only the exact
`http://garage.garage.svc.cluster.local:3900` endpoint, region `garage` and path
style accept `IOLAUS_RESUME_IMPORT_CLUSTER_GARAGE=1`. Other hosted endpoints
remain HTTPS. Cluster-private traffic is plaintext and relies on namespace/pod
NetworkPolicy boundaries; no transport encryption is claimed for this path.

A disposable pinned Garage1.0.1 instance in this branch's compose project passed
normal fresh provisioning and existing-resource refusal. The actual released
AssetRuntime/provider passed private upload, metadata reopen, separate-process
read, anonymous denial, foreign-locator denial, invalid credentials, original
quarantine, audited checksum recovery and physical timed purge. Evidence:
`227-garage-provider.log` and `garage-setup-receipt.json` under the external
evidence directory. This is not yet in-cluster CNI or production credential proof.
Native PostgreSQL quarantine checks passed before the final three cases were
added; rerun the final shared contract and full integrated checks before review.

Compatible dependency patches reduced the npm audit from one critical/55high
to zero critical/16high; residual advisories are explicitly assessed in
`docs/releases/resume-published-dependencies.md`. Runtime images now remove unused
npm and update the available perl-base security package. Actual hardened
extractor envelope passes; final exact-source images/scans and registry evidence
still gate release. Scanner findings are not silently suppressed.
