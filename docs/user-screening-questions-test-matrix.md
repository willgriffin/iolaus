# User Screening Questions — issue 153

User-owned questions drive JEV-only screening and recommendation alignment. Sol remains optional and is never a prerequisite or automatic continuation. The local daily-use implementation preserves other work and human Apply/Reject decisions.

## Scoring contract

Source questions have yes, no or unknown answers. Fit questions can also have partial answers, but only with attributable posting and owned candidate evidence. Desired answers are explicitly yes or no. Alignment is an anchored ordinal value from 0 to 4; desired-no polarity reverses alignment, while a partial midpoint stays neutral.

The recommendation score is `100 × sum(weight × alignment / 4) / sum(all enabled scoring weights)`. Must-have and preference questions contribute; disabled and informational questions do not. Unknown ratings earn zero points without becoming mismatches. If all scoring answers are unknown, the score is null, not zero. Evidence coverage separately reports the weight of attributable rated answers over all enabled scoring weight. This is alignment with the user’s questions, not hiring probability or model confidence.

A must-have conflict requires a clear attributable answer opposite the desired answer. Low confidence, missing evidence and partial fit are unresolved must-haves, never automatic conflicts. These states do not write human verdicts. Defaults are suggestions explicitly saved by the user; they are initially preferences and derive relevant confirmed profile settings rather than hardcoded countries.

## Behavior-to-test matrix

| Behavior / reachable trigger | Positive case | Negative / failure case | Actor / ownership / active context | Executor / runtime / external edge | Test and validation |
| --- | --- | --- | --- | --- | --- |
| Owned question list and CRUD | Active member manages own tenant/user/profile rules | Foreign tenant/user/profile, inactive profile, missing membership or revoked capability denied | Verified workspace; profile.manage at fresh write fence | Native existing PreferenceRule; actual SQLite and disposable PostgreSQL where raw CAS applies | Store unit and real persistence isolation specs; route tests |
| Atomic question revision | Exact expected content revision saves once | Concurrent/stale revision, cross-owner CAS or failed write does not overwrite | Live owner tuple inside scoped executor | Native table owner/category/old JSON CAS; rollback evidence | Persistence conflict and atomicity tests |
| Generic edit invalidation | Current normalized name/description/active/category/ruleJSON produces new revision | Generic Preferences edits, disable/delete or malformed JSON cannot reuse old answer | Current owned reads, no editor-only counter authority | Native snapshot every read; content fingerprint | Set/revision/currentness tests; invalid rows visible, no default fallback |
| Question bounds and defaults | Stable unique IDs, bounded freeform text/count and weight; explicit save suggestions | Unknown enums, zero/negative/excessive weights, duplicate IDs, invalid polarity rejected | Own profile; no save on load | Shared pure domain; Node; external input edge | Adversarial domain/store/route tests |
| Recommendation and coverage | Weighted ordinal points over all scoring weights; attributed partial counts coverage | Sparse known high answer never becomes 100%; unknown does not become no; all unknown score null | Current normalized questions and answers | Pure Node aggregate; N/A transaction: no mutation | Polarity, disabled/info, unknown denominator, partial must-have tests |
| Native JEV evidence | Source answer cites exact captured units; fit answer cites posting plus owned facts | Foreign or invented IDs, generated quotes, malformed/missing answers, upstream failure denied | assessment.execute; fresh source/profile/questions before and after provider | Existing governed PRIVATE request, native AgentRun, registered JEV tuple | Factory/resolver/job or service tests; actual three-role pilot |
| Native current result | Actual PRIVATE receipt and source/candidate/question-set versions match | Stale question/source/candidate, orphan/wrong-model/foreign receipt fail closed | Full tenant/user/profile tuple and current active profile | Existing OpportunityAssessment result persistence | Reader/store currentness tests and native repeat-read proof |
| Run screening and activity | Explicit run executes bounded dedicated/native path despite background false | General queue, Sol continuation, source fetch, duplicate failed identity or human verdict write forbidden | Verified actor; native workflow fencing | Existing native AgentRun/governance; actual usage retained | Run adapter tests; actual activity/browser proof |
| Global list and triage ordering | Current score, coverage and must-have states order before SQL pagination | Stale/disabled/deleted question results and unknown must-have cannot act as conflicts or rank current | Same owned projection as detail | Actual query schema, SQL source guards; SQLite/PostgreSQL relevant cases | Client/SQL parity and pre-pagination tests; authenticated browser |
| Mobile editor | One editing form replaces preview; save/cancel/delete preserve focus and errors | Failed save retains draft; inaccessible foreign fields or load mutations forbidden | Authenticated active owner | Svelte/native design components; N/A external employer writes | Mounted/route tests and real mobile browser QA |

## Execution limits

Sources and the ordinary batch remain stopped. The sole native operator runs the three-role pilot (strong engineering, adjacent PM, clear accounting mismatch). It uses no Sol calls and a maximum additional $0.02 conservative reservation inside the unchanged $0.75 cumulative cap. Provider caching is unverified: the installed TypeSafe adapter sends full state each call and exposes no cache/session handle or cached-token accounting. Same-state independent questions are batched; only a real evidence-retrieval dependency warrants a follow-up. No request is silently cropped to fit a bound.

Validation receipts and remaining limitations are recorded after frozen tests, independent review and actual browser/native proof. No queued job is counted as a completed screen.

### Local tuning checkpoint — 2026-10-04

Saved five user-approved questions in the daily-use workspace: posting role duties
(weight 5), Canada work location (4), documented technical experience (3), remote
work (2), and informational sponsorship. No hard exclusions or human decisions
were changed. The evaluator now uses `v3-source-classification`: occupational
classification can cite clearly different stated duties for a No answer; sparse
or ambiguous duties remain unknown. V1/V2 request replay remains supported with
unchanged historical prompts and distinct current identity.

Real JEV validation after the prompt change:

- ClickHouse engineering: recommendation 60.7%, coverage 71.4%, role Yes,
  experience partial 2/4, remote Yes, Canada unknown, sponsorship unknown.
- Casper AI PM: recommendation 42.9%, coverage 78.6%, role No with cited delivery
  responsibilities, Canada/remote Yes, experience/sponsorship unknown.
- Procurify Junior Accountant: recommendation 42.9%, coverage 78.6%, role No with
  cited invoicing/receivables/reconciliation duties, Canada/remote Yes,
  experience/sponsorship unknown.
- US-restricted Support Engineer control did not reach the provider: no request
  or run row. A read-only size reproduction using the previous candidate catalog
  required 80,999 reserved tokens under the conservative byte-based estimate,
  exceeding the unchanged 80,000 native ceiling. This control remains unverified;
  no retry, truncation, limit increase, or broad batch was performed.

Focused evaluator/service validation: 31 tests passed, including historical V2
replay and new-version identity. Evidence: `/tmp/iolaus-question-tuning-v3-tests.log`,
`/tmp/iolaus-screening-tuning-check.json`, `/tmp/iolaus-tuning-size.log`.
This tuning session used $0.004971 actual additional provider spend; experiment
cumulative $0.007817; overall accounting basis $0.621098 of unchanged $0.75 cap.
No active or unsettled provider requests remain.

Title-first screening is not implemented: the current pass supplies title and
full captured posting together. Wider evaluation still needs a bounded-input
strategy for larger postings and further checks of location interpretation.
