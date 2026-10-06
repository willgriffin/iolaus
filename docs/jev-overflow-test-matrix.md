# Evidence-preserving JEV overflow — issue 162

Accepted local daily-use work; no migration, commit, release or PR lifecycle.
The all-listings pass reached every one of 2606 IDs, with 29 full requests
rejected before paid work because their state plus longest independent question
exceeds the existing 32000 estimated-token bound. Ten also exceed the state-alone
bound. None fail the 64000 wire, 80000 native run or reserved-spend bound.

Implementation: retain normal V8 identity and results. A separately registered V9 fallback
uses a lossless compact catalog with implicit ordered IDs, full exact source and
candidate texts, title/kind metadata and exact bundle expansion. Concise equivalent
instructions retain every existing semantic constraint. No source/candidate
slicing, content summaries, hidden truncation, optimistic chunk maximum or limit
increase. Native request sizing remains authoritative. Only requests that do not
fit normal V8 select the fallback; the normal completed results remain current.

Risk class: standard contained model/service adapter change with native authority
and accounting unchanged. Tests explicitly cover the existing private receipt
boundary, staleness and idempotent repair. External typed contract changes are
versioned; normal V8 replay must remain identical.

| Behavior / invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External contract | Test level / command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Lossless full catalogs | Oversized V8 request | Exact decode restores B/F/C IDs/text/metadata and bundle members | Material tampering invalidates the prepared fingerprint | Owned profile/source | Deterministic preparation; no DB write | Node; dialect N/A | V9 compact layout | Engine unit; isolated Vitest |
| Conservative semantics | Source/fit questions | Aliases/full conjunct proof preserved | Opposite, missing qualifier, dabbling remain negative/partial/unknown | Owned candidate | Typed resolver | Node; dialect N/A | Same score/confidence thresholds | Engine fixtures + bounded real JEV sample |
| Native limits unchanged | Fallback sizing | All 29 preserved requests fit | Still oversized fails before invocation | Native governed caller | Existing atomic reservations | SQLite/Postgres existing governance | JEV 32000/64000; run 80000 | Engine sizing + real read-only preview |
| V8 replay/currentness | Existing normal receipt | Prepared fingerprint unchanged; saved normal rows current | Fallback change cannot reinterpret V8 receipt | Owned current context | Existing q/r/run receipt joins | Node/SQLite/Postgres existing service | Exact versions/feature/model | Service historical/current fixtures |
| Fallback proof | V9 saved result | Exact native receipt publishes/readbacks | Missing, foreign, failed, mismatched receipt denied | Actor/resource/active tuple | Fresh native principal + publication fence | Existing native DB | Native actual-accounted receipt | Service tests; live sample |
| Retry and partial failure | Duplicate/failure | Completed native output reused without paid duplication | In-progress or prior failed identity blocks | Owned profile | Existing per-opportunity lifecycle lock | SQLite/Postgres | Native idempotency | Service regression fixtures |
| Mixed-version ranking | Normal and overflow rows | Both current matches sort before pagination | Stale/foreign/unproven rows neutral | Authenticated workspace | Native list projection | Supported dialects per existing query suite | Exact V8/V9 selectors | Query/projection tests (root owned) |
| Budget/preservation | Sample + 29 rerun | Cumulative <= $5.75; human/profile/source hashes identical | Unsettled/unknown accounting stops; no blind retry | Authorized local operator | Native reservations + serial outer cap | Postgres daily-use | Actual pricing/quota/circuit | Bounded operational ledger and read-only audit |

Validation: engine/service/config105/105 tests pass; isolated svelte-check0errors/0warnings. Root mixed-version query55pass/2existing skips. Native read-only preflight29/29 now fits V9 with every original candidate/source record. Explicit V8 title routing is fingerprint-identical when derived from V9. No provider calls occurred during preparation. Evidence is bound to the final frozen source revision. Base regression:
the saved read-only diagnostic demonstrates all 29 fail unchanged V8; the same
complete catalogs must fit V9 without changing limits. App caches are isolated for
SSR. Workers never print private source/provider material or secrets.
