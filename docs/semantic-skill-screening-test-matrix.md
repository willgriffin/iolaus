# Semantic skill screening (local daily use)

Refs #159. This work is scoped to the authorized local daily-use application;
no commit, push, deployment, or pull request is requested. The coordinator owns
the four-opportunity live sample and approval of any broader reranking.

V5 combines up to three attributable candidate facts per fit question, accepts
semantic capability equivalents, and preserves technology/depth/tenure limits.
V6 adds individual skill evidence in the same governed JEV request and receipt.
V1–V5 remain explicitly supported historical versions. No source or candidate
catalog is truncated. No automatic skill additions are made.

Individual skills use immutable captured skill fields or current extracted
labels that occur literally in the captured body. Body-derived labels retain
the full containing captured body witness and remain marked as extracted
labels; the model must retain surrounding/linked qualifiers and disregard
incidental or negated skill mentions. Required labels precede preferred labels.
At most eight skills are assessed, reduced deterministically until the complete
request fits existing native context/output bounds. Remaining labels are
explicitly unassessed, never missing. Empty extracted/captured skill lists do
not trigger an additional extraction call.

| Behavior / invariant | Reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime | External edge | Level / validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Semantic matching and depth limits | V5/V6 fit preparation | Aliases/equivalent capabilities count; complementary exact facts selected | Adjacent tech and introductory exposure cannot establish requested expertise; skill labels cannot establish years | Owned current profile and captured posting | Pure memory; transaction N/A | Node 26 | Versioned JEV prompt/rubric contract | Engine unit suite; actual semantics require coordinator live sample |
| Combined candidate attribution | Typed fit response | Catalog-order citations retained/deduplicated, selected confidence combined | No witnesses => unknown; invented choice rejected | Exact owned evidence catalog | Pure memory; transaction N/A | Node 26 | Full legal choice distributions | Engine unit suite |
| Verified skill-depth note | Owned CandidateProfile factsJson | Exact user_verified skillExperience string, whitespace preserved | Derived/generated/nonstring/blank excluded; foreign profile denied | Tenant/user/profile tuple validated before catalog use | Existing native profile read; no storage change here | Node 26 | Version1 factsJson, V5/V6 only | Service unit suite |
| Currentness and replay | Prepare/read current receipt | Note and grounded labels alter exact prepared identity; native receipt revalidated | Stale material cannot replay; V1–V5 omit V6 skill questions | Fresh owner and native run/request/result receipts | Existing native executor and owner context | Node 26 / SQLite test stand-in | Fixed version/model/payload identity | Service/engine unit suites |
| Body-grounded advisory labels | Native extracted skill labels with empty captured fields | Exact literal body span anchored to complete original containing group | Unanchored labels omitted; incomplete group containment rejected | Current native opportunity plus immutable captured source | Pure preparation; transaction N/A | Node 26 | Original captured text/offsets retained | Service unit suite plus reviewed contract |
| Individual status authority | V6 independent skill result | Supported/partial requires specific citations and confidence/probability threshold | No witness, low confidence, ambiguity => unknown; no hard gap status | Same exact receipt as full screening | Existing governed single request and receipt; no additional calls | Node 26 | Score + three candidate witness primitives | Engine/client projection unit suites |
| Optional request bound | Full catalog and optional skill questions | Required-first assessments trimmed to native input+full legal output ceilings | Overflow stays held if base itself cannot fit; omitted labels remain unassessed | Pure captured preparation | Pure memory; transaction N/A | Node 26 | 64K total input, 32K state+longest, 80K reservation | Adaptive engine regression |
| UI independent skill evidence | Current V6 projection in triage | Individual supported labels and accessible source/candidate evidence shown | Aggregate rating or static keyword overlap cannot turn unmatched labels green; unassessed neutral | Current server-validated projection | SSR/browser display; transaction N/A | Svelte 5 | Optional validated skillMatches output | Projection + TriageCard + QuestionScreening unit suites |
| Fixed-model allowlist | Governed feature/profile/model/version identity | V1–V6 retain exact JEV bucket | Unknown or mismatched identity falls outside bucket | Governed request identity | Pure memory; transaction N/A | Node 26 | Registered typesafe contract | Config unit suite |

## Executed evidence

All generated validation artifacts were produced in the isolated snapshot,
not in the daily-use app. Direct Node tool entrypoints avoided pnpm refreshing
symlinked dependencies.

- Six targeted suites: 119 tests passed; `/tmp/iolaus-v6-final-tests.log`.
- Added adaptive regression and final engine rerun: 20 tests passed;
  `/tmp/iolaus-v6-adaptive-tests.log` (one more test than the six-suite run).
- Final Svelte check: zero errors and warnings;
  `/tmp/iolaus-v6-final-check.log`.
- Biome format applied to owned TypeScript files. Scoped lint still reports
  ten pre-existing deliberate control-character-regex errors in the question
  validator/service; `/tmp/iolaus-v6-lint.log`.
- Independent read-only review accepted source-qualifier and complete-span
  corrections and reported no remaining blockers. Mocked tests establish
  attribution and contract consistency; they do not prove JEV interpretation.
- Historical material branches were inspected and replay tested. An exact
  pre-task full V4 hash comparison is unavailable because the original files
  are untracked and no pre-task backup was supplied.

Coordinator preview: all four sample requests fit. The populated-skill sample
assesses TypeScript individually and leaves other labels unassessed; three
samples have no captured or extracted skill labels. Their full semantic user
questions still evaluate the complete posting and candidate facts. The first
request preview reserves 74,237 tokens (56,978 estimated input plus 17,259 full
legal output). Live sample results are recorded by the coordinator separately.

## V7 correction after actual semantic QA

The four-row V6 sample completed but did not demonstrate satisfactory semantic
matching. Inspection of native saved decision distributions found two distinct
problems: independent ordered witness questions did not produce a coherent
shared witness set, and fit-source questions attempted to ground a personal
candidate-fit proposition from posting-only evidence. Candidate/source choices
were diffuse; the TypeScript individual semantic score itself favored partial
support (0.64) over complete support (0.23), so lowering the support threshold
would not be justified.

V7 preserves executed V6 material and receipts. It replaces fit and individual
candidate witness choices with at most twelve deterministic lossless bundles,
and fit-source witness choices with at most eight lossless bundles. Complete candidate bundle membership is encoded once as inclusive first/last C
row ID ranges in CB state, with an explicit layout; source SB lists exact row
IDs. Native prepared bundle maps retain every full member ID. Choice values
reference that catalog and at most two original endpoint titles or source
paths/offsets; expansion restores each original supplied citation. These are context bundles,
not synthetic capability claims. Independent slots ask for capability,
qualifiers and limitations instead of assuming cross-question coordination.
Fit source slots explicitly ask what the posting demands.

For V7, semantic confidence remains the native score confidence; witness
selection ambiguity is separately recorded as attributionConfidence. Both
remain uncalibrated native values. The 0.85 individual supported threshold is
unchanged; absent attribution still prevents a rated fit. No percentage tuning
or automatic skill additions occurred.

Additional deterministic evidence:

- Engine suite: 21 tests passed, including lossless bundle coverage, bounded
  catalogs, original citation expansion, semantic/attribution confidence
  separation, and explicit V6 material guards;
  `/tmp/iolaus-v7-engine-tests.log`.
- Other five targeted suites: 102 tests passed in the six-suite run; the one
  initial engine fixture mismatch was corrected by explicitly pinning its
  historical V6 version, then the complete engine suite was rerun;
  `/tmp/iolaus-v7-tests.log`.
- Final Svelte check: zero errors and warnings; `/tmp/iolaus-v7-check.log`.
- Independent read-only V7 review reported no blockers and confirmed explicit
  V6 guards preserve historical preparation paths.
- Frozen engine/service/config source hashes:
  `/tmp/iolaus-v7-source-signature.txt`.

The coordinator owns the subsequent real V7 sample. Mocked test success alone
is not evidence of improved model matching.

V7 preflight verification after compact choice/range encoding: all four actual
sample requests fit existing limits. The populated-skill sample assesses
TypeScript and Python individually; the other three still have no skill-label
inputs and remain unassessed individually. The coordinator also reconstructed
all four actual V6 prepared payloads with the new code and verified their saved
prepared fingerprints remain identical. No native limits or thresholds were
increased.

## V8 named-capability scope

The completed V7 sample improved fit attribution: previously unestablished fit
answers now had posting and candidate citations. The individual TypeScript
score still favored partial whole-job support (0.59) over complete support
(0.23), despite direct TypeScript work in the candidate catalog. That failure
was a product-scope mismatch: the chip was evaluating surrounding/full job
qualifications instead of experience with the named capability.

V8 preserves executed V7/V6 preparation and changes only individual capability
questions. Direct means documented hands-on or explicit primary use; related
or introductory includes transferable technology or explicit dabbling. Only
qualifiers written inside the skill label are part of that individual test.
The overall fit question continues to evaluate all posting qualifications.
A label alone does not establish hands-on use, explicit candidate limitations
must be retained, and no support threshold is lowered.

V8 skill rows carry meaning=named_capability. The UI uses Direct experience /
Related or introductory for those rows; unmarked historical rows retain their
prior Supported / Partial wording. Tooltips summarize at most three source
titles and point to the disclosure containing every complete citation.

- Six targeted suites: 126 tests passed; `/tmp/iolaus-v8-tests.log`.
- Final Svelte check: zero errors and warnings; `/tmp/iolaus-v8-check.log`.
- Independent read-only V8 review found no blockers in scope, historical guards,
  direct-support threshold, witness expansion or UI semantics.
- Frozen source hashes: `/tmp/iolaus-v8-source-signature.txt`.
- The coordinator owns actual V8 semantic QA; mocks alone do not demonstrate
  TypeScript-versus-Python discrimination.

## Actual V8 semantic QA and handoff

The coordinator's four-opportunity V8 sample completed successfully through
native governed requests. TypeScript now returned Direct experience with
0.88 native semantic confidence and exact TypeScript project evidence, passing
the unchanged support threshold. Python remained unestablished at 0.79, below
the strict threshold; introductory exposure was not promoted to direct
experience.

The JavaScript-oriented agentic role reached fit alignment 3/4; the
TypeScript-oriented role retained partial fit 2/4 despite direct TypeScript
experience; both Python-oriented roles retained partial fit 1/4. These are
individual sample observations, not hiring probabilities or proof of a broad
accuracy rate. The distinction between named capability evidence and complete
job fit worked in this bounded sample.

The four V8 requests cost 4,259 actual spend micros. The coordinator verified
all four executed V6 and all four executed V7 prepared fingerprints still
match exactly under the new code. No skill facts were added automatically,
no thresholds were reduced, and no provider calls were made by this worker.

Implementation is frozen and handed off for local daily use. The coordinator
is running a separate 25-opportunity bounded sample with native title
pre-screening before any broad reranking decision. This is an explicit local
scope exception: no commit, push, release or pull request ceremony is requested.
