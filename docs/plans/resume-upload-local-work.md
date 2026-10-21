# Resume upload local implementation

Status: implemented locally; live text-PDF import verified, October 13, 2026.
Owner: Codex, session agent-first-release/resume-upload, branch
`codex/agent-first-release`. Parent: `unified-intake-launch.md`.

The owner explicitly requests local implementation and QA before pushing. This
local work record replaces remote issue/claim/PR mutations for this phase. Do not
push or publish until requested. Preserve existing preview data and unrelated work.

## First milestone

Authenticated PDF upload from Resume and onboarding, durable private ingestion,
bounded PDF extraction, editable evidence-backed proposals, selective application
to the user's experience/education/skills, and safe resume of failed work. This
milestone must leave a usable local QA flow, not only a mocked upload form.

## Test design

| Behavior | Trigger and positive case | Negative case | Actor and executor | Runtime and edge | Evidence |
| --- | --- | --- | --- | --- | --- |
| Private receipt | Owned PDF accepted durably | Invalid PDF, size limit, cross-owner access, revoked grants | Authenticated tenant/user/profile; native ingestion persistence | Node 26; SQLite/PostgreSQL; storage failures | Unit, native DB and route tests |
| Extraction | Text and supported scanned PDF produce bounded page evidence | Encrypted, corrupt, unsupported OCR, provider timeout, malformed model result | Scoped worker/host, source treated as untrusted | Public PDF/AI adapters; explicit budgets | Adapter and fixture tests, real local PDF |
| Review | User edits/excludes proposed entries | Unknown fields, invalid dates, stale proposal | Authenticated owner; exact revision binding | Browser and server DTO boundary | Validation tests and browser QA |
| Apply | Reviewed entries populate owned resume | Foreign IDs, permission revocation, concurrent edits | Same transaction executor for locks, domain writes and durable completion | SQLite/PostgreSQL | Rollback, affinity, ownership matrix integration tests |
| Retry and duplicates | Retry/lost reply returns prior result | Re-upload or simultaneous apply cannot duplicate entries | Stable business/import identity within owned profile | Native transaction and uniqueness/fencing | Concurrent/repeated application tests |
| Deletion | Delete upload/account revokes source and derived content | Late worker cannot restore deleted input | Fresh authorization, ingestion cleanup and host purge | Private assets and jobs | Retention/deletion integration tests |
| UI | Upload, inspect, correct and apply then return to Resume | Pending/error/partial state remains actionable | Signed-in desktop/mobile, light/dark, keyboard | Existing header/back/navigation | Browser component tests and served local QA |

This is new behavior, so base failure comparison is N/A; new acceptance tests
exercise the previously absent workflow. No employer submission or public profile
publication is introduced. Recorded evidence must distinguish mocked providers
from actual PDF/OCR/AI integration and document any remaining launch limitation.

## Validation

The local browser and DTO suite covers explicit AI-processing consent, bounded
upload, busy/error behavior, revision refresh, selective review, and stale
apply-draft preservation. It does not establish PDF/OCR/provider quality.
Before a release claim, run focused transport, host, domain, and extraction
tests; the configured browser suite; repository checks; database migration and
status; and a private-storage flow using a configured AI profile. Record whether
each PDF/OCR/AI path was real or mocked, plus results for text, scanned, invalid,
oversized, revoked, stale, repeated-retry, and deletion cases. The compatible
local ingestion bundle has passed native SQLite and PostgreSQL integration; its
provenance and runtime requirements are in `docs/resume-upload.md`.

### Local evidence checkpoint

Evidence is retained outside the repository in
`/tmp/agent-first-release/resume-upload/` (no personal resume fixture).

- `native-complete.log`: 15 passed; one PostgreSQL-specific concurrency case
  intentionally skipped on SQLite. Real native ingestion, asset storage,
  registered operations, roles, transactions and databases; deterministic
  extraction isolates persistence testing from the external model.
- `native-production-final.log`: nine additional real database cases cover
  queued execution, export, account cleanup, retention and captured owner
  provenance. `native-production-ownership-final.log` rechecks the four affected
  cases after the final ownership repair.
- `extraction-fixture.log`: the isolated Docker worker extracted the fictional
  text PDF. OCR tooling is installed, but scanned/encrypted fixture quality and
  a real AI interpretation are not yet verified.
- `db-migrate-clone.log`: upgrade exercised on a restored copy of the preview
  database, then all 12 ingestion tables verified before upgrading the preview.
- `db-migrate-preview.log`: local preview upgrade succeeded after backup.

Live AI QA is awaiting a configured Bifrost base URL. The existing preview's
AI kill switch remains enabled; no user resume has been sent to a model. The
independent release review and publication remain pending the completed live QA.

### Final local verification

- `site-tests-bounded.log`: 383 test files passed, 20 skipped; 4,425 tests
  passed and 171 skipped using four workers. Unbounded root test attempts hit
  existing five-second timeouts under load; do not report canonical `pnpm test`
  as green. Root script tests and the resume package passed in those attempts.
- `browser-final.log`: nine browser files, 31 tests passed. The separate MCP
  component suite also passed (`mcp-apps-final.log`).
- `format-green.log`, `lint-final.log`, `check-final.log`: formatting and lint
  exited successfully; Svelte check reported zero errors and warnings.
- `build-complete.log`: root production build passed. Preview restarted with
  the new build and upload request-size limit.
- `db-status-final.log`: zero pending schema statements; all 12 private intake
  tables and existing integrity guards present.
- `http-preview.json`: actual served build returned 200 for the authenticated
  page and upload receipt, 400 for missing consent, 403 for foreign origin,
  401 for unauthenticated receipt access, 204 for deletion, and 409 for reusing
  deleted input. With AI disabled, the receipt reports a safe configuration
  error. This is a negative-path test, not evidence of live model extraction.
- Native browser QA verified the served upload page, file selection, consent
  gating, shared navigation and back link. The browser was reset to the clean
  upload page. No fictional entries were applied to the user's resume.
- `deploy-final.log`: self-hosted check is blocked because the locally adapted
  ingestion archive is not part of the recorded release closure. Reconcile and
  qualify that dependency before shipping; do not weaken the closure check.
  Production PDF-worker execution integration is also still required as
  documented in `docs/resume-upload.md`.

Everything remains uncommitted and local. URL intake implementation follows this
resume milestone. Live model QA, scanned/encrypted PDF fixtures and independent
release review remain outstanding; this is not a launch-readiness declaration.

### Bifrost connection attempt

The user supplied `https://bifrost.happyvertical.com` for local testing. The
configured cheap-model adapter could not obtain a completion. A direct request
to `/v1/chat/completions` with the existing Bifrost API key and redirects disabled
returned HTTP 302 to `https://oauth2.happyvertical.com/oauth2/start`. The host's
default `/openai` adapter path also failed to yield a completion. No live model
interpretation completed. The fictional upload remains a failed receipt; no
resume entries were applied. Local AI processing was disabled again while
retaining the supplied gateway URL. Next step: provide an API endpoint or
approved service authentication that can pass the gateway's sign-in layer.

### Live Luna verification — gateway access resolved

After the gateway permission update, `openai/gpt-6-luna` returned HTTP 200
through `https://llm.happyvertical.com/openai/chat/completions`. Local preview
configuration now selects that model for extraction. The served upload route
processed the fictional PDF through the actual isolated PDF worker and Bifrost
model, producing five reviewable entries: one experience, one education and
three skills. Fields were checked against the fictional source before applying
only to the dedicated fixture account. Apply, repeated apply and refresh all
returned the durable applied state. Evidence: `live-proposal.json` and
`live-applied.json` in the existing external QA evidence directory. No real user
resume was changed. This resolves the provider blocker; scanned/encrypted PDF
QA and release/deployment prerequisites above remain outstanding.

### Local QA correction: disabled upload cursor

The selected-file state with unchecked consent incorrectly showed a wait cursor
on the disabled upload button. Acceptance: idle disabled controls use a normal
disabled cursor; wait cursor is reserved for `aria-busy=true`; selected PDFs
without consent show an explicit instruction. Verify through the existing
consent-gating browser case and a production build. No backend or schema change.

Cursor fix validation: six existing browser tests, formatting and production
build passed. Preview restarted. The user's selected file and unchecked consent
were left intact in the browser; no upload was submitted on their behalf.

### Browser QA, October 14

Used the actual built UI with CUA and live Luna, through an ephemeral loopback
proxy authenticating only a dedicated fictional account. The user's browser
session and stored resume profile were not modified. Passed: file picker, consent gating,
loading state, extraction into review, review recovery after refresh, source
evidence, editing a title, skipping education, applying selected changes, return
to Resume, persisted title and skills, skipped education absent, repeat upload
reusing the applied receipt, private-upload removal, explicit re-import after
removal, default Skip for matched entries, and merge into an existing experience.
Non-PDF and >10 MiB files were rejected before submission; a corrupt PDF produced
a failure with retry/removal controls. Browser console had no errors at the
applied-state checkpoint. Fixed education's misleading Job title label to Degree
or qualification. Six component browser tests passed after that label fix.

The user's existing upload was observed in failed state with malformed AI output.
Its raw provider response was not retained, so exact cause cannot be proven.
Extraction fixes and the actual browser retry result are recorded below.

The browser exposed a retry transport mismatch: the UI sent `revision` alongside
`requestId`, while the endpoint accepts only `requestId`. Removed the extra field
and added a browser regression asserting the exact payload. Seven component
browser tests, site typecheck (zero errors/warnings), and production build passed.
The served preview includes the fix. A browser retry created analysis revision 2
for the user's receipt but still failed validation; no proposed changes were
applied to the user's profile. Further diagnosis is in progress.

Extraction now requests JSON explicitly, uses the permitted 4096-token output
budget, detects truncated responses, and omits null optional dates. Eight focused
extraction tests passed, including a longer fictional resume. These safeguards
alone have not yet resolved the real upload's failure.

The next revision (3) completed successfully through the browser and the review
form's Apply button is enabled. The extractor now omits null for all optional
fields (dates, summary, bullets, education detail, profile), retaining strict
validation of asserted values. Added content-free operational diagnostics for
future malformed JSON, schema rejection, bad citations, and truncated output.
Eighteen extraction/host tests and site typecheck passed. The exact rejected
field in earlier attempts was not retained, so the original cause remains
unproven. No changes were applied to the real resume; its completed review is
left open for the user. The fictional-account proxy was stopped and its browser
tab closed.

Final visual QA found long candidate-option labels expanding the CSS grid beyond
the viewport. Constrained the review's grid tracks and form controls to available
width; production rebuild and browser width verification recorded below.

Final build passed. Browser reload restored the real completed review, with Apply
visible. DOM width checks confirmed no horizontal overflow: main 1098/1098,
section 780/780, article 733/733 client/scroll pixels. Local preview is ready.
Scanned/encrypted PDFs and mobile layouts were not covered in this browser pass.

### PaddleOCR migration scope and test contract — October 14

This local-only migration upgrades the extraction worker to `@happyvertical/pdf`
`0.66.0`. The networkless Docker worker remains responsible only for embedded
text extraction. It must never gain network access or send a PDF to OCR. When
the worker identifies a scanned or mixed-text page, the application host
reauthorizes immediately before sending the retained bytes to the configured
PaddleOCR-VL service. The service response supplies ordered, page-numbered
markdown evidence; the existing Luna interpretation remains the only proposal
writer. The first implementation serializes host OCR calls and does not add a
durable queue or retries.

The app keeps its 10 MiB, 20-page, and 120,000-character limits. PaddleOCR
accepts up to 50 MiB, but that broader service limit does not expand the upload
contract. The app timeout accommodates a 64-second cold wake and must remain
within the native ingestion analysis lease; deployment is deferred. No real
user resume is sent to PaddleOCR during this local migration.

| Case | Required assertion |
| --- | --- |
| Embedded-text PDF | Docker fast path succeeds and no PaddleOCR client is created or called. |
| Scanned/mixed PDF | Reauthorization precedes the host call; ordered page markdown becomes page evidence and carries an OCR warning. |
| OCR result boundary | Missing/duplicate/out-of-range pages, absent markdown, over-limit pages/text, and malformed result fail closed with no fabricated evidence. |
| Provider boundary | Unconfigured client, timeout, provider rejection, and caller abort surface bounded extraction errors without retries. |
| Proposal evidence | A model citation for a page without source text is rejected; page order cannot silently attach evidence to another page. |
| Lease and concurrency | The analysis lease exceeds the maximum app extraction deadline; one in-process OCR call runs at a time and is released after success, failure, or abort. |

### PaddleOCR local validation outcome

- Installed app `@happyvertical/pdf@0.66.0` from the configured private registry.
- Focused extraction/host tests: 25 passed; site check: zero errors/warnings;
  format-check and diff check passed. Site production build and extraction Docker
  image build passed. SMRT MCP strict freshness: zero errors/warnings.
- A real image-only fictional resume exposed unpdf's internal OCR fallback despite
  reader-level `enableOCR:false`; explicit `skipOCRFallback:true` on each
  extraction call fixed it. Rebuilt Docker fixture returned one empty text page
  and `needsOcr:true` without invoking built-in OCR.
- Served text-PDF upload reached review in 5.489 seconds with experience, education,
  three skills, and no OCR warning. Served scanned-PDF upload failed safely after
  121.579 seconds with a retryable processing-timeout message and no entries.
- Successful live scanned extraction is BLOCKED upstream: direct SDK request also
  timed out at 180 seconds; the PaddleOCR VLM pod was CrashLoopBackOff. Its startup
  required 7.05 GiB free GPU memory while only 6.65 GiB was available. The waker's
  successful health response did not imply model readiness. No cluster mutations
  were made. Prior rollout success does not substitute for this current test.
- Local launcher uses `HAVE_PDF_PADDLEOCR_URL=http://paddleocr-vl`. User's real
  resume was neither sent to the new service nor modified. No commit or push.
- Evidence: `/tmp/agent-first-release/resume-upload/paddle-*` (client failure,
  image builds, scan detection, text/scan HTTP outcomes, site build and knowledge).
  After service capacity is restored, retry the fictional scan receipt and verify
  review/page evidence before claiming live scan support.

### PaddleOCR retry succeeded

After the user's request to retry, the live local upload pipeline completed the
image-only fictional resume in 18.527 seconds. The service pod was 2/2 ready.
The durable receipt reached review with an OCR warning, expected Platform
Engineer/Northwind Labs experience, Example University education, TypeScript,
Svelte and PostgreSQL skills, and nonempty page-1 evidence on every entry.
Assertions passed against the persisted review endpoint. No changes were applied
and no real resume was sent. This resolves the live scanned-fixture blocker; it
does not establish broad scan-corpus or cold-start reliability. Evidence:
`/tmp/agent-first-release/resume-upload/paddle-http-scan.json`.

### Local follow-up: preserve experience bullets

User requested separate achievement bullets and a fresh PaddleOCR review of their
retained resume. Codex owns this local-only follow-up; no push or apply authorized.

| Behavior | Trigger / positive / negative | Context / executor / runtime | Edge / validation |
| --- | --- | --- | --- |
| Preserve role structure | OCR list becomes bullets; prose stays summary; bullet-only roles have no invented summary | Existing owner-scoped analysis; unchanged native receipt transaction; Node | AI JSON optional summary/bullets; extraction tests and real OCR review |
| Edit individual bullets | Review edits/adds/removes a bullet; unchanged summary; empty list supported | Owner review UI; existing apply payload/transaction; Svelte browser | Newlines serialize to existing bullet contract; browser regression test |

No auth, schema, renderer, or transaction changes: existing apply creates ordered
Duty records. Base UI regression is independent fields absent before fix.

Validation so far: individual bullet editor regression passed (8 browser tests);
site typecheck reported zero errors/warnings; production build passed. SMRT
review routing flagged package-wide relationships/MCP concerns, inspected and
unchanged by these edits; strict knowledge freshness passed. Live rerun exposed
the 30-bullet per-role ceiling and a missing required institution. Raised the
bounded list to 100 with a 50,000-character total cap and clarified required
education fields. Added positive 40-bullet and negative count/text-limit tests;
the 40-bullet regression fails under the previous max(30) schema.

Final local result: revision 6 reached review in 77.751 seconds with 16 experience
entries and 66 individually editable bullets, plus 2 education, 43 skills, and
1 profile entry. Five roles correctly have no summary. Browser verified 16
achievement groups and 66 bullet editors with Apply available. Nothing applied.
23 extraction/domain tests and 8 editor tests passed; site check/build and root
format-check passed. Preview restarted and returned HTTP 200. No push/commit.

### Local follow-up: projects alongside experience bullets

User authorized extracting projects to owned Project records while retaining
project achievements in parent experience bullets. Codex coordinates the existing
domain worker (apply/matching/tests); coordinator owns extraction, DTO, review UI.
All work remains local and no real resume changes will be applied.

| Behavior/invariant | Trigger / positive / negative | Actor/executor/runtime | Edge/test/command |
| --- | --- | --- | --- |
| Projects aren't jobs | Nested named project produces separate project proposal plus prefixed parent bullets; missing project list stays compatible | Owner analysis, native receipt, Node | AI JSON schema, extraction vitest + live OCR review |
| Owned project apply | Create/merge selected project, resolve selected parent, skipped parent stays unlinked; foreign/tampered/stale targets denied | Verified owner, same native apply transaction, SQLite/Postgres existing adapter | Domain tests and native integration fixtures |
| Independent review | Edit project details, preserve server parent reference, create/merge/skip independently | Owner browser, existing API | DTO/browser tests, site check/build |

No model/table migration required. Existing Project ownership, account export and
resume assembly are reused. No publication or external application submission.

Project validation: 31 extraction/domain/DTO tests, 9 browser tests, and six
native project cases across SQLite/Postgres passed. Native tests cover owner
tuple, parent-first linking even with reverse input order, retained Duty bullets,
repeat-apply deduplication, parent merge/skip behavior, ignored forged linkage,
SQL-trigger rollback/retry, and foreign merge denial. Typecheck: zero errors and
warnings. Live PaddleOCR rerun reached revision 7 review in 62.747 seconds with
11 experiences and six project proposals; unapplied. Review found ASCII project
keys reject non-Latin names and collide across employers; fixing to UUID keys
before final build. Evidence: /tmp/agent-first-release/resume-upload/native-projects-final.log.

### Local follow-up: project bullet sections

User authorized project headings with bullets stored once, then rerun/open review.
Domain worker owns apply/fingerprints; native QA worker owns transactional tests;
coordinator owns extraction/DTO/nested review. No push or real-user apply.

| Invariant | Trigger / positive / negative | Context / runtime / executor | Validation |
| --- | --- | --- | --- |
| Grouped extraction | Nested project has unprefixed bullets, parent general bullets stay separate; absent project bullets compatible | Owner AI analysis, native receipt, Node | Extraction tests + real Paddle review |
| Single storage | Apply creates Duty with both project/experience links, one copy; merge preserves other project duties; stale and foreign denied | Owner native apply transaction, SQLite/Postgres | Native fixture rollback/retry, repeat, create/merge tests |
| Grouped UI | Project appears once under parent heading, editable bullets remain independent; skip explained | Svelte review, existing apply API | Browser tests, check/build |
| Rendering | Existing resume assembly groups Duty by projectId and excludes project duties from general role bullets | Existing normalized renderer, no schema changes | Existing assembly/PDF rendering tests + source inspection |

Section validation: 33 extraction/domain/DTO tests, nine browser tests, and
20 resume rendering tests passed. Native SQLite/Postgres checks: eight cases
plus two grouped assembly checks passed (real scoped rows; repeat apply, merge
preservation, replacement rollback/retry, foreign-duty preservation). Typecheck
zero errors/warnings; site build, root format-check, strict knowledge freshness
passed. Existing renderer excludes project-linked duties from role bullets and
renders them under project headings. Evidence: /tmp/agent-first-release/resume-upload/native-project-sections*.log.

### Deployment readiness: extraction and production runtime

October 19: user requested extraction consistency first, then production integration
and dependency closure. Local QA only; no publication or real-user apply.

| Invariant | Positive / negative cases | Validation |
| --- | --- | --- |
| Section coverage | Experience size cannot consume education/skills output budget; incomplete/truncated section fails entire analysis | Fictional section fixtures; controlled same-source live reruns with content-free count/coverage report |
| Authorization and spend | Each external call freshly authorizes and meters; denied/budget-exhausted calls fail | Adapter tests; total duration bounded within native lease |
| Production parsing | Private bounded extraction service works without Docker socket; oversized, timed out and disconnected requests cleaned up | Local hardened container tests; production client tests |
| Reproducible dependencies | Cold install/build has every immutable input; no reliance on developer sibling links | Registry/provenance audit; frozen install and candidate image rehearsal |
| Review and apply | Upload, poll, review, edit, selective apply and retry work with production transport | Fictional browser/native DB QA; owner review remains unapplied |

Architecture context: SMRT reflect-domain-knowledge and smrt-architecture retrieved;
existing native ingestion owns durable receipts, authorization and atomic apply.
PDF parsing remains in @happyvertical/pdf behind an isolated execution boundary.
A model-declared completeness flag is only a guard, not proof of source coverage.

Readiness evidence: corrected same-source live extraction passed three times with
12 roles,24 projects,2 education,20 skills and expected identities, dates,
bullets and parent links. Initial new prompt failed schema validation; corrected
explicit valid exemplars before accepting any proposal. Thirty adapter tests pass.
Native SQLite/PostgreSQL suites pass55 tests (two dialect-specific skips).
Actual isolated browser upload via HTTP PDF service and native task worker reached
58-entry review, then saved only an edited role and selected project; skipped
education stayed absent. No owner data was applied. Original preview database and
retained upload are unavailable; re-upload is required for owner-PDF comparison.
Evidence: /tmp/agent-first-release/resume-readiness/ .

October 20 review follow-up: both independent reviewers identified blank-page
OCR rejection. Accepted fix preserves ordered page indexes and accepts individual
empty OCR pages only when the document contains readable text. OCR outages still
fail explicitly; embedded-text fallback could silently omit scanned content.
The production templates now wire the established private PaddleOCR Service and
client namespace label; the Service itself remains an infrastructure prerequisite.
Also accepted: valid skills prompt exemplar plus all-section parser regressions,
and provenance documentation reconciled against the audited sidecar. Targeted
round-2 review and affected checks are required before declaring this slice ready.
No publication, deployment, or owner-resume apply is authorized in this local QA.

Final October20 local result: blank-page OCR handling and production optional-null
normalization are fixed. Three frozen-source consistency runs preserved the
expected12roles/24projects/2education/20skills. Latest image-only fictional
PDF run completed in11.913s through HTTP parsing, PaddleOCR and three metered
Luna calls:1role/1project/1education/2skills, both role and project bullets,
correct parent, no invented profile, no apply. Initial failed/partial-layout
probes are retained as evidence rather than counted as passes.

Current validation:47focused extraction/client tests,6HTTP service tests,
root typecheck, formatting, lint, production site build, manifest validation
and strict knowledge freshness pass. Previous full repository suite, native
SQLite/PostgreSQL authority/rollback tests and browser review/edit/selective
apply remain green for unchanged behavior. Two independent full reviewers
plus targeted follow-ups closed F1–F5 over four local rounds; exact file hashes,
dispositions and spend are recorded outside the worktree. Codex review CLI was
unavailable, so the documented fallback used independent Claude Opus sessions.

Latest build app/worker and extractor health return200. Isolated fictional
preview is http://127.0.0.1:5800/admin/career/import/ . Original preview database
is unavailable; no owner data was reconstructed or applied. Owner-PDF QA needs
a fresh upload. Production still requires the existing PaddleOCR Service/policy
and release reconciliation of the documented compatibility supplement.
No commit, push, PR or deployment was performed.

### Local follow-up: long upload feedback and owner output truncation

User reported retained owner receipt a9c92737-81c9-4b66-9442-59e317e0fdab
failed after showing Uploading. Safe diagnostic confirmed provider_length, not
a PDF page limit. Keep source private; owner authorized retry, not apply.

| Behavior/invariant | Trigger and positive/negative cases | Context/executor/runtime/edge | Validation |
| --- | --- | --- | --- |
| Prompt capacity | Long supported resume can exceed4096 output tokens; scoped bounded output and matching meter/client limit; defaultotherAI unchanged | Owner AI extraction, same native receipt; Node/Bifrost; no schema migration | Adapter/profile unit regressions and retained owner retry |
| Real progress | Upload returns receipt before extraction; queued/reading/OCR/AI/matching stages from native job events; no fabricated timer progress; denied/foreign/stale excluded | Verified workspace subject, native jobs progress writer; scoped SQL read SQLite/Postgres | Host/runtime/API/native DB cases |
| Browser lifecycle | Receipt persists in URL, polls to review/failure, handles interrupted polls and stops on terminal/unmount; no repeated upload or apply | Svelte browser, existing authenticated API; polling is read-only | Browser regressions + actual owner retry and review |
| Error specificity | Model response truncation reports AI output limit, actual PDF limits remain distinct | Native allowlisted failure plus scoped job stage, no raw provider error/content | Error mapping tests and owner review |

No pushes, deployment, owner apply, or remote tracking changes.

Live retry exposed two genuine gaps and preserved failure receipts: retry analysis
was queued without immediate dispatch (fixed by native repair before response),
then provider JSON mode returned an invalid required education institution.
The oversized-output error was fixed; the second failure was malformed_output,
not a PDF limit. Moving resume interpretation to provider-enforced JSON schema
keeps required fields typed while nullable optional fields normalize to absence.
No unsupported record is silently dropped, no missing fact is fabricated, and
server validation remains authoritative. Test the actual Bifrost schema contract
with fictional data before a further owner retry.


Retained-owner diagnostics checkpoint: the strict-schema provider returned125
validated entries (13experience,29project,1education,81skill,1profile). A separate
host100-entry guard rejected the otherwise valid proposal. No owner changes were
applied. Both proposal and apply count checks must use the same bounded200-entry
limit; existing512KiB output/request/combined-execution budgets remain independent.
Safe diagnostics record fixed rejection reasons and counts only; domain validation
maps to malformed_output. No resume fields, provider error text or stack are logged.
Actual retry history and stage/count-only evidence remain outside the repository.

The controlled owner retry after count alignment reached REVIEW (142 entries:
13experience,23project,2education,103skill,1profile). This is an operational
receipt, not a claim that every proposed fact is exact or complete. Review remains
open at the retained receipt URL; no owner Apply, additional retry, push or deploy.
Native host32tests pass acrossSQLite/PostgreSQL with2dialect-specific skips.

Round5 independent delta review accepted two blockers: conflicting optional-profile
prompt instructions and endless polling of permanent4xx status errors. Localized
fixes align absent profile with required nullable wire schema, stop permanent4xx
polling with recovery (408/429 and temporary/network errors still retry), and
preserve manual refresh. Targeted46unit/SSR+16browser cases pass. A single fresh
fictional strict-provider extraction preserved all12roles/24projects/2education/
20skills, dates/parents/bullets, with wireprofile:null and no invented profile.
Current build/type/format/lint pass; final targeted recall is round6. Owner review
remains untouched and unapplied. No subsequent owner extraction was performed.

Round6 targeted recalls both CLEAN; accepted blockersF6/F7closed. Current15-file
snapshot verified against inherited round5 coverage plus round6 repairs. Fullsuite
4489site tests+36browser passed before the localized repairs; post-repair46unit/
SSR+16browser and rootcheck/build/format/lint pass. Native32SQLite/PostgreSQL passed.
All changes staylocal. Owner review is preserved; no ownerapply/push/deploy. Production
still needs existing PaddleOCR Service/policy and release reconciliation of the
compatibility supplement; local success does not establish deployed TLS/email login.
