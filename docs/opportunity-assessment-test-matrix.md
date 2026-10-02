# Opportunity assessment test matrix

Issue [#137](https://github.com/willgriffin/iolaus/issues/137) adds a typed,
evidence-backed assessment contract. This matrix records the first executable
slice. Persistence and the governed provider invocation will add their own
database and transport evidence before they are enabled.

The contract separates reusable, source-attributed posting facts (sponsorship,
existing-authorization language, work arrangement, employment type, timezone,
and travel) from subject-scoped conclusions. Target-country availability,
domain and experience fit require both a posting passage and private candidate
evidence. Countries use an ISO alpha-2 code and display label; citizenship is
stored as context but never proves work authorization. A verified,
country-wide authorization can support a match. Employer-limited or conditional
authorization, undocumented residency, and any immigration pathway remain
unknown.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A posting claim has an exact source attribution | Typed result is resolved | High-confidence value and selected posting excerpt become a claim | Unknown source key, low confidence, missing provenance, or malformed answer is rejected | Posting assessment | Pure resolver; no write | Node | JEV predicate and choice result | Unit | `vitest ... opportunity-assessment.spec.ts` |
| Missing or truncated evidence does not invent a gap | Assessment preparation and resolution | Complete candidate evidence can support a role/experience claim | Truncated or absent candidate evidence resolves to `unknown` / `uncertain`, never a confirmed gap | Candidate profile | Pure resolver; no write | Node | Bounded JEV state | Unit | same |
| Each requirement keeps its own evidence pair | Typed requirement decisions | A required skill stores its posting clause and its supporting candidate passage | A gap is withheld if candidate evidence was trimmed or no explicit contradicting candidate source is attributed | Candidate profile | Pure resolver; no write | Node | Typed JEV per-citation predicates | Unit | same |
| Location is assessed for the intended work country, not citizenship | Personal compatibility projection | An explicitly allowed target location plus verified country-wide authorization is eligible | Citizenship, residence, a missing posting authorization statement, or unknown sponsorship never establish authorization; an authorization requirement with no proof remains unknown | Candidate profile | Pure resolver; no write | Node | No immigration-pathway inference | Unit | same |
| Sponsorship remains independent from location | Personal compatibility projection | Required authorization plus offered sponsorship is sponsorship-possible | Denied sponsorship only excludes a candidate who states sponsorship is required | Candidate profile | Pure resolver; no write | Node | Posting source assertions | Unit | same |
| Conflicting posting claims fail closed | Assessment resolution | A consistent answer is usable | An attributed `conflicting` decision or a conflicting persisted projection becomes an explicit conflicting outcome | Posting assessment | Pure resolver; no write | Node | Typed JEV choice / current-source validator | Unit | same |
| Cache material follows source/profile/contract/model, not preferences | Preparation and cache key | Changing candidate evidence or source changes request fingerprint; model changes cache key | Changing preference weights leaves prepared request and provider cache key unchanged | Candidate profile | Pure resolver; no write | Node | Provider idempotency key | Unit | same |
| Ranking is local and explainable | Ranking projection | Location bucket, domain and experience adjust score with active preference weights | Hard incompatible preference excludes without provider work | Candidate profile preferences | Pure resolver; no write | Node | `PreferenceRule.ruleJson` is malformed or unknown | Unit | same |
| User isolation | Persistence integration (pending #135 ownership audit) | A verified user can read only its own assessment/profile facts | Foreign profile or assessment id is denied | Authenticated user / tenant | Request-scoped DB transaction | SQLite + PostgreSQL | MCP/API identity switching | Integration | Pending #135 contract |
| Stale-safe persistence | Assessment refresh integration | Current source/profile identity commits once | CAS miss or concurrent profile/source change writes nothing | Refresh worker | Governed request then conditional update | SQLite + PostgreSQL | Retry/idempotence | DB integration | Pending provider/persistence slice |
| Native governed call | Five-posting bounded canary | One governed JEV request carries actual usage/provenance | Circuit, accounting, malformed provider result, or timeout produces no invented result | Owner-controlled run | Existing governance reservation | Production-like native runner | JEV `decide()` | Integration / operator | Pending root approval |

## Integrated-path additions

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Candidate-owned assessment mode | A queued workspace job requests `assessment` | Reads only the global posting plus subject-scoped candidate evidence and writes a private assessment/score | `all`, extraction, research, status updates, applications, and tasks are denied for a member-bound job | Verified tenant/user/profile | Job wrapper then processor | SQLite + PostgreSQL | TaskRunner runtime subject envelope | Integration | Job + intelligence spec |
| Subject material is queue-idempotent | Candidate enqueue derives the material fingerprint | Identical retries for one profile reuse a job/result | Equal resume/posting bytes for a different user/profile produce a different fingerprint and cannot dedupe | Verified workspace | Queue dedupe then private conflict key | SQLite + PostgreSQL | No caller-controlled ownership envelope | Unit + integration | input/job specs |
| Eligibility facts fail closed | Onboarding or direct private profile record supplies country data | Valid ISO code and label persist; verified country-wide authorization is usable | Free text, `CA` ambiguity, malformed JSON, missing labels, or conditional/employer-limited authorization cannot prove compatibility | Candidate profile | Scoped profile save | Node | Country code/display label contract | Unit + route | eligibility/onboarding specs |
| Provider preflight is bounded | JEV assessment is prepared | Request fits 64 KiB and reservation derives from typed response criteria | Oversized request or response reservation fails before a billable provider call | Governed AgentRun | Existing reservation/control history | Native JEV | `decide()` has no max-output option | Unit + operator | provider spec/canary |
| Current private projection parity | List API or triage action loads a bounded opportunity set | Both attach the same source-current private `assessmentProjection` for the session-hook-verified tenant/user/profile tuple | A supplied URL/form value never selects a profile; foreign, stale, malformed, or missing rows map to unknown and never leak raw assessment JSON | Verified workspace | Scoped batch projection lookup | SQLite + PostgreSQL | Admin + MCP view models | Route + integration | `admin-resource-route.spec.ts`, `opportunity-triage.spec.ts`, and admin route specs |
| Readiness fails closed before fit display | Projection from a current private assessment | Structured requirements plus complete posting/candidate evidence yields `assessable` | Zero requirements yields `needs_extraction`; a clipped or omitted candidate source, posting source, or requirement yields `needs_evidence`; UI keeps eligibility but suppresses fit authority | Verified tenant/user/profile | Token-free scoped projection refresh | SQLite + PostgreSQL | Safe projection only: readiness plus four coverage scalars | Unit + route/UI | assessment store/input and admin projection specs |
| Complete candidate evidence retains matching facts | Candidate input preparation | All roles, tenure, skills and narratives retain original IDs and full content | Invalid or explicitly partial sources record coverage loss; scoped skill choices never erase facts or prove an absence-based gap | Verified tenant/user/profile | Pure complete input preparation | Node | Exact UTF-8 request and output reservation ceilings | Unit | `opportunity-assessment-input.spec.ts` |
| Requirement-aware rank is local and cautious | Projection refresh after a stored decision | Supported required and preferred requirements contribute fixed normalized shares (30 and 10 points) regardless of list length | Gaps subtract only when candidate, posting, and requirements coverage are complete; uncertain requirements are neutral; final local preference-adjusted score stays within 0–100 and readiness keeps incomplete scores out of score filtering/sorting | Verified tenant/user/profile | Token-free preference/projection refresh | SQLite + PostgreSQL | No JEV call on rank or preference change | Unit + SQL | assessment and query specs |

## Complete structured input pack (daily-use #137)

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Complete evidence survives preparation | Workspace assessment preparation | All atomic skills, role/tenure, duties and narratives retain source IDs and full text, including beyond 30 sources / 360 characters / eight requirements | Missing raw posting explicitly marks partial coverage; no hash substitutes for semantic content | Verified workspace | Pure preparation; existing scoped loader | Node | Typed JEV state | Unit | assessment/input specs via exclusive snapshot lane |
| Requirement citation predicates remain attributable | Requirement decision | Attributed posting requirements and affirmative narrative / matching skill predicates resolve to original IDs | A source outside the offered predicate scope cannot emit support; absent evidence alone never proves a gap | Verified workspace | Pure resolver | Node | Typed binary citation predicates | Unit | assessment specs via exclusive snapshot lane |
| Exact complete-request preflight precedes billing | Assessment provider | UTF-8 bytes and typed response reservation both fit | Either ceiling exceeded rejects before governance/provider; incomplete coverage remains nonauthoritative | Governed AgentRun | Existing governance unchanged; N/A new transaction | Node / native JEV | 64 KiB request, 20,000 reserved output tokens | Unit + native operator | provider specs + native owner pure preflight |

Base regression evidence: old builders explicitly sliced 30 sources, 360-character text and eight requirements; new tests assert 201 complete sources, long narrative and more than eight requirements. Snapshot executor owns executable validation. No database schema, tenancy or persistence protocol changes are introduced.

The complete pack also includes every stored qualification statement (tenure,
scale, communication and other non-taxonomy requirements) and responsibility.
Short wire citations map to the private durable `sourceCatalog`; record/section identity never needs
to be billed as opaque prose. A `citationScopes` record preserves offered keys
and whether the scope is exhaustive. Full candidate facts stay in state even
when a question offers fewer citations; evidence outside that scope is uncertain
and cannot become a gap or negative fit contribution. `requirements_complete`
checks the full raw posting before a saved result can claim full role coverage.
Its private audit retains the exact probability and whether input rows were
complete; uncertain extraction is described as potentially incomplete rather
than claiming that request text was truncated. Pack/contract v4 includes duties
and independent binary citation support under a new identity and preserves previously accounted decisions.
Zero extracted requirements stop before any governance reservation or provider.
Education retains distinct native record IDs even for identical title/body rows,
and the private loader reads an overflow row to reject silent collection loss.

Focused regressions cover compact citation reconstruction/parent links, a real
supporting narrative outside offered criteria (uncertain with no penalty), full
qualification statements, thirty requirements with 150 retained sources,
incomplete raw requirement extraction, duplicate education identities and the
no-reservation extraction prerequisite. Native pure preflight uses the current
rich candidate and complete role requirements; no paid request is allowed until
its exact bytes and typed output reservation both fit existing ceilings.

Binary support protocol: every offered citation gets an independent direct-support
predicate. Only probabilities at least 0.85 yield that exact canonical source;
there is no selected-citation multiclass confidence requirement. Mandatory and
preferred classification require independently verified explicit source labels;
an extraction proposal alone cannot fix their classification. Audited rows never
fall back to a private inferred importance label. Explicit contradiction
predicates are offered only for exhaustive scopes, and a support/contradiction
conflict stays uncertain. Exact UTF-8 request bytes and the same typed output
reservation determine the largest fitting citation scope; no semantic catalog
content or role clause is removed.

Native v4 pure preflight for the current imported role retained 24 requirements
(including all seven duties), 150 candidate sources and 32 posting sources. It
measured 65,529 UTF-8 bytes and 12,288 reserved output tokens: 120 support
predicates, five per requirement, no contradiction predicates for partial scopes.
All 19 matching atomic skill citations remained offered alongside 101 narrative
citations; no matching skills were excluded. The private receipt preserves the
per-requirement scope counters without exposing candidate text. Paid-result
validation remains a separate checkpoint.

The accounted v4 canary returned every expected answer but remained
`needs_evidence`: no support predicate reached 0.85, and the completeness audit
was uncertain. A separately governed, self-contained positive/negative literal
calibration crossed the existing threshold only for the supported pair. The v5
follow-up changes the shared support rule to explicitly bind each rN requirement
and cN citation to its full state text and parent context. Confidence thresholds,
semantic catalogs, offered-scope policy and decoder safeguards remain unchanged;
v5 uses a new material identity and preserves the accounted v4 result.

A fitting byte count alone is insufficient: a zero-offer requirement scope
now rejects before governance/provider invocation. Useful-scope regressions
assert explicit matching skill IDs and relevant profile/narrative source IDs for
every requirement rather than imposing an arbitrary universal citation count.

## Lossless source coverage contract (v6)

The v5 forensic audit found nine partially retained clauses among eighteen headed
role clauses. The source extraction now proposes lossless statements against an
exhaustive manifest of exact native raw posting spans, including About-role/team
context. Spans use JavaScript UTF-16 offsets; IDs, hashes and reciprocal mappings
are checked against the unchanged native source. Required/preferred importance
must be independently verified as explicit; otherwise it remains unknown. The
current direct audit offers no importance classification questions: every proposed
required/preferred label therefore remains unknown, and private classification
cannot promote it. The earlier v5 audit used a bounded optional scope; its
accounted results remain historical evidence rather than current authority.
Unknown or malformed coverage
stops before an audit or private matching call.

The v5 source audit distinguishes applicant criteria from descriptive source
context. Candidate qualifications, duties and applicant authorization, residence
or selection restrictions must be retained in mapped rows, and every mapped row
must itself be a candidate criterion. Company/team facts and employment or
benefit program terms, with their scope and exceptions, remain exact source
context. A current, separately recorded repair may explicitly retire a context
row while preserving its original paid proposal receipt.

The current `requirement-coverage-audit/v6-direct-literal` request asks a
self-contained entailment predicate for every mapped row and a separate
complete-list predicate for every mapped body clause. Both must reach 0.85;
entailing one row does not establish complete coverage. Source/context bodies
instead receive the positive applicant-criterion classifier: only a raw result
at or below 0.15 certifies context, with `1 - p` recorded as its coverage
confidence. The raw answer remains recorded. A context label alone proves
nothing.

Every exact question key and raw probability is retained in `answerProbabilities`.
Per-clause coverage is the conservative minimum of all row entailments and its
complete-list result, so a high recall result cannot overwrite low entailment,
or vice versa. Missing, extra, malformed or nonfinite answers reject the result;
request and canonical binding fingerprints cover the entire layout. Exact
canonical headings with native span/hash/grammar and unmapped heading
dispositions use deterministic proof, with no synthetic confidence value.

Every body literal and mapped row text occurs directly in its question; heading
literals, ordered clause metadata and row-to-clause references stay in state.
Redundant raw source is omitted only when native spans exhaust all non-whitespace
source content; any non-whitespace gap retains full raw text. Private matching
uses only verified candidate rows and preserves context clause attribution on
its full posting source without duplicating their text.

The cache lives in existing prepared posting JSON, contains no candidate
material, and binds source, preparation, extraction, repair, ledger and actual
governed request identities. Private readiness requires the completed global
provider output matching that exact audit; injected JSON cannot unlock it.
Fresh extraction uses the current V5 source semantics. The explicit paid V4
context is recomputed from current captured raw source, version and canonical
preparation; it is never selected merely because a JSON leaf names its
fingerprint. The async effective-cache reader additionally reconstructs the
completed GLOBAL base, feedback and repair ancestry and compares the merged
ledger before authorizing that historical context. Private preparation and its
final source/profile fence consume this same verified context. Changed raw
source, version, receipt ancestry or merged material invalidates it.

The pre-extraction reservation serializes conservative direct-question
skeletons, including the maximum legal reciprocal references to the longest
literal source and both escaped-text occurrences. This can honestly reject an
unknown future layout even when a particular completed ledger would fit. An
audit-only replay of an already recorded completed repair instead preflights its
exact reconstructed request and retains both historical stage reservations;
it cannot regenerate extraction or repair. The real 42-clause, 46-row direct
preflight contains 84 predicates (46 entailments, 20 complete-list checks and
18 context classifiers), measures 55,413 request bytes and reserves 2,774 output
tokens. Including the two recorded 10,096-token stages gives 78,379 of the
unchanged 80,000-token lifecycle ceiling. A fitting request is not proof that
its semantic audit passed.

The existing source extraction/audit lifecycle admits its aggregate request,
token and spend reservations before its first provider call. Each Luna stage
counts its governed input ceiling plus its output reservation, rather than its
smaller observed input count. Private matching also checks the total input-plus-
output reservation against the configured run limit before billing. Private matching
uses the separately recorded, current verified source cache. Combined modes that
exceed their aggregate budget decline; they cannot silently split work across
AgentRuns. Missing coverage returns a machine-readable source prerequisite and
dedupe key. Automatic dependency scheduling is verified separately from an
operator executing the recorded source prerequisite followed by a fresh private
job. A changed coverage audit fingerprint changes the private material identity.
An unchanged source with an independently recorded semantic negative or paid
failed provider identity cannot re-bill. A revoked actor who never reached the
provider does not establish a shared negative cache entry.

| Behavior | Positive evidence | Failure evidence | Validation |
| --- | --- | --- | --- |
| Exact source coverage | Full literal clause and qualifiers, reciprocal native spans/IDs | Missing/duplicate/changed clause or summary-only source | coverage module/provider specs |
| Independent semantic audit | Every mapped-row entailment and whole-clause coverage at least 0.85; context raw positive classifier at most 0.15; exact native heading proof | High recall with low entailment or inverse, context 0.151, omitted/extra/malformed answer, unsupported exclusion | coverage provider specs |
| Audit authority | Current completed global provider output matches the cache | Forged JSON, foreign/private receipt, stale extraction/source | provider receipt and input specs |
| Prebilling private prerequisite | Verified cache fingerprint enters private request/job identity | Missing receipt rejects before governance/provider | assessment provider and dependency specs |
| Aggregate source admission | Every extraction chunk and audit reserve counted within limits | Over-budget tokens/calls/spend reject before first provider | source extraction/provider lifecycle specs |

Executable validation and native exact preflight remain external snapshot/operator
checkpoints; this matrix does not claim an unexecuted paid canary succeeded.


## Opt-in partial evidence contract

The separate `requirement-evidence-audit/v1-decomposed` source path preserves the
existing full v6 protocol. Its empty shared state and literal source/nearest
literal headings bind independent row-support, mapped-list precision,
mapped-list recall and positive context predicates. Every expected answer is
retained, with exact key cardinality; one low result cannot overwrite another.
A statement is an accepted excerpt only when its literal support and every
linked clause precision are at least 0.85. Low recall or unresolved context
retains the full native clause, UTF-16 span and hash and prevents full coverage.
Context is certified only at raw probability at most 0.15; headings use native
proof, never invented model probabilities. Importance remains unknown.

`partialAssessmentEvidence` is an explicit server opt-in. The partial reader
requires the new canonical feature/schema's completed GLOBAL request/result,
actual positive accounted usage and current source identity; diagnostic TEMP
responses cannot authorize it. A historical source context additionally needs
joined completed native base/feedback/repair ancestry matching the ledger.
Private matching sends accepted excerpts only and retains the complete candidate
fact catalog. Each question includes the literal accepted criterion, exact candidate
citation and only its linked parent. All exact named atomic skill matches and at
least one attributed narrative remain offered for every criterion; generic skill
proficiency wording cannot manufacture a named match. Unoffered facts remain in
the catalog and cannot establish absence. Scoped citation answers yield supported or uncertain, never gaps,
eligibility, stars, scores or a strong-fit conclusion. A missing accepted row or
native receipt declines before a private reservation. Source, audit, candidate
and freshly resolved principal changes prevent stale writes after accounting.

Private results use `opportunity-assessment-partial/v1`, `status=partial` and
`matchReadiness=needs_evidence`, with unknown eligibility and neutral priority.
The full assessment parser and ranked SQL require their full contract and
current status, so a partial record cannot enter score filtering or ordering.
The native evaluator attaches its PRIVATE request ID and input fingerprint;
rendering must verify the joined actual governed receipt for the current subject
and material before re-resolving its answers. No EvaluationScore or application
recommendation is written. This documents
an implementation boundary; it does not claim an actual semantic canary passed.

| Partial behavior | Required regression |
| --- | --- |
| Accepted excerpt boundary | High support with low precision excluded; low recall retains excerpt but denies complete coverage |
| Independent probabilities | Missing, extra, malformed answers and changed binding fingerprint rejected |
| Native authority | Orphan, foreign, conservative, zero-usage or diagnostic result refused; source changes invalidate |
| Private evidence only | Full candidate catalog retained; supported/uncertain only; exact canonical citation provenance |
| Safe persistence | Distinct partial contract/status, neutral unknown eligibility, no ranking projection or EvaluationScore |
