# Normalized opportunity matching

Opportunities, Home discovery, and triage show current **Qualified** matches
and **Screened · evidence gaps**. Qualified means every required condition is
established. A screened posting has a verified role and compatible location
and work arrangement, all its mandatory source requirements are understood,
and candidate evidence directly supports at least one required capability.
Exact evidence for a named tool or required capability can count as partial
support when the remaining experience, scope, or context is unproven. This
never establishes the whole requirement. An explicit upper bound below the requirement, a contrary
context, a related capability, or an employer’s technology list cannot
provide that support. A documented duration below the minimum is still
relevant evidence when it is a lower bound. It has no known conflict or unresolved must-have screening question. The app
names the remaining candidate evidence gaps, which can include an explicit,
cited qualitative requirement that the current evidence cannot establish.
Those requirements retain their mandatory status; a qualifier, technical
prerequisite, or unknown source condition cannot be discarded as qualitative.
A missing source interpretation, unsupported hard source condition, or lack of relevant proof stays out of
discovery.

Best ranks qualified matches first; Newest orders the same set by date.
Saved reviews and applications stay in their history views. Explicit manual
bulk dispositions can record screened rows for follow-up or rejection. Bulk
Apply and bulk paid processing still require a qualified row in discovery.
An explicit deep review can use additional analysis, but it cannot admit a
posting into discovery.

Set roles, locations, and work arrangements under **System → Preferences →
Matching preferences**. The fields are shared with onboarding. A current or
past job title is evidence about a career, not a search target. Role titles
and supported disciplines can be saved as separate choices. Explicit
specialty and seniority narrow that choice; an unrecognized choice is shown
separately from missing résumé evidence. The original preferences stay intact.

Current résumé skills, positions, achievements, and a verified skill experience
note can supply evidence; inferred or cached AI skill suggestions are excluded.
Candidate facts, preferences, and matching projections are private to the
verified tenant, user, and selected profile.

## Evidence and limits

The source parser uses the captured posting when a version and fingerprint
verify it. Legacy rows without a capture use their raw posting fields.
Invalid or incomplete captures leave requirements unresolved. Evidence
includes the original field, text and offset in the normalized snapshots;
pair decisions keep reason codes and citation locators. The current policy
recognizes:

- Governed skill aliases, explicit narrower capabilities, and related
  capabilities. A narrower capability can prove its parent, but the
  relationship cannot be reversed. Related skills may affect optional rank;
  they do not prove a required skill. Recognized dated résumé positions can
  establish conservative professional experience in the role's own capability.
  Overlaps count once; incomplete dates use the latest possible start and
  earliest possible end. An ongoing position is counted only through the time
  its matching snapshot was computed. Crossing a duration threshold does not
  refresh that snapshot by itself; it is recalculated with the next profile or
  policy revision. Dates do not transfer to standalone skills or establish
  production use. An explicit maximum duration can establish a conflict;
  a recorded lower bound below the posting's minimum remains missing proof. In a verified OR group, one proven
  alternative can satisfy the group even if a different alternative remains
  unknown. An unknown required conjunct still blocks.
- Explicit English requirement and preference sections, including AND
  combinations and alternatives, named experience durations and supported
  qualifications. A missing statement is uncertainty, not evidence against
  a candidate. A preference can remain uncertain without blocking the match.
- Recognized role families, separate specialty and seniority, named work
  arrangements, and explicit remote jurisdictions. A missing remote region
  is uncertain. Explicit preferences can contain more than one role or
  location.
- Exact supported screening questions about work arrangement or country.
  Unsupported enabled must-have questions remain unresolved. Subjective,
  legal, visa, degree, schedule, and other unrecognized hard clauses do not
  become unconstrained. Preferred and informational questions do not gate.

This is a conservative first policy. Ambiguous prose, unusual titles,
localities without recognized geography, and unsupported requirement grammar
can suppress real matches. Offline ranking evaluation in
[matching-evaluation.md](matching-evaluation.md) does not
measure this raw extraction path. The matching loop makes no provider calls.
The optional source interpretation pass handles more prose once per verified
posting revision, within an operator-set shared budget. The application
assigns IDs and source offsets to the captured title, location, and description
units. A first request proposes canonical roles, geography, and capability
predicates for those units, with source section hints and defined capability
scopes. A separately governed verification request reads the raw units
without the section hints and binds its result to both digests. Disagreement
about the details of an independently established preference stays optional;
disagreement about whether a condition is optional remains unresolved. A missing unit, unverified interpretation, known contradiction, or
unsupported condition cannot grant a match. Where they establish a hard
condition independently, deterministic source facts still apply. The second
request is an additional quality check; it cannot guarantee perfect extraction.

Both requests receive only the public posting and fixed matching vocabulary,
never candidate preferences or evidence. Candidate evidence and per-profile
comparisons stay in the application.
Production rollout and changes in extraction policy require separate
verification.

## Updates and operation

Raw table triggers advance the relevant source, listing, profile, or
vocabulary revision in the same transaction as the change. Discovery checks
the live ownership and source lifecycle plus each revision and the policy
version. It stops returning stale rows before background recomputation.
Listings are reconciled by durable ID cursor and recent posting changes by
revision cursor. Each valid shared posting snapshot publishes a position on a
normalization feed. Each profile resumes that feed from its own cursor; a
changed profile starts again from current source snapshots. There is no
catalog-size cutoff or pre-enqueued candidate-by-posting job set.

One pinned transaction processes a bounded page of source work and one
profile's bounded page of results. It rechecks and locks captured generations
before publication. Its cursor advances with the writes, so an interrupted
batch can be retried without losing work. Posting edits get a revision fast
path; periodic reconciliation also covers listing toggles, vocabulary
corrections, and changes that commit out of revision order. Reactivation may
take a sweep before matches return. Role/location conflicts, unresolved
source facts, and failed or pending computations are excluded. The empty discovery
view distinguishes missing source interpretation, unsupported wording or
capabilities, unresolved source details, unconfirmed candidate evidence, and
known conflicts. These counts describe all current available postings before
filters and can overlap. Discovery reads do not run the matcher.

Schema installation is part of the regular database migration and release
schema preparation. The ordinary jobs worker runs reconciliation after
startup. For an isolated local PostgreSQL clone where outbound jobs must stay
off, run only the matching worker:

```sh
pnpm --filter @willgriffin/iolaus-site matching:worker --database-name=your_qa --watch
```

Omit `--watch` for one bounded tick.

A normal jobs worker can additionally run governed shared source
interpretation when `IOLAUS_MATCHING_SOURCE_EXTRACTION=1`, a positive
`IOLAUS_MATCHING_SOURCE_EXTRACTION_HOURLY_MICROS` budget is set, and native
opportunity intelligence control, model, call limits and accounting are
configured. A separate leased pass interprets one posting at a time outside
the database transaction. Publication rechecks the exact raw capture and
invalidates that posting's source revision. The matching-only runner
consumes the saved interpretation and never initiates outbound calls.

Private candidate interpretation is a separate opt-in worker. It reads the
verified owner's current resume skills, positions, achievements, explicit
experience note, and career records selected for use on the resume.
Exact evidence citations stay in the owned profile snapshot. Verified project
links allow related records to establish conditions together. Requirements
that ask for independent capabilities can use separate activities. Named
technology and same-system conditions need attributable related evidence. A position's
date range alone cannot establish how long a particular technology was used.
The candidate prompt has no posting input. The public source interpreter
receives no candidate data.

The private queue pins the owner, evidence digest, vocabulary revision,
candidate interpretation policy, and interpretation contract. Deterministic
ranking changes can reuse that queue's verified result. The paid worker checks
the current principal, profile permission, and lease before sending each bounded chunk.
A chunk containing narrative career evidence uses a stronger draft model.
The model choice depends on the evidence type and does not depend on a posting.
A separate verifier checks that the original evidence supports the drafted
claim, including who performed the work, its context, and any duration.
The worker saves each validated draft before verification, so a safe retry
can reuse paid work. Publication advances the matching generation atomically.
When settled usage accompanies a confirmed output-length limit, the worker
can split one draft chunk into two smaller requests. The saved plan retains
earlier verified chunks and gives each half a distinct request ID. Ambiguous
attempts and other provider refusals stay failed. Budget and provider
preflight refusals can retry with backoff. Raw evidence edits or ownership
revocation clear the private snapshot and interpretation in the same
transaction. Search preference and posting edits reuse the interpretation.
Ongoing attributable intervals refresh deterministic comparisons as time
passes.

Previously verified chunks remain usable if a later chunk fails. A posting
can show recognized evidence with an interpretation caution while remaining
outside Qualified. An unresolved source flag does not identify whether
the source contains a missing positive claim or an unclear restriction.
Evidence that states a duration contributes only to the
named activity. Undated durations are never added together, and trusted role
dates count for a technology only when verified evidence connects the
activity to the entire role.

Ongoing duration lower bounds refresh through the bounded comparison worker
as UTC dates advance. Existing current results stay visible during this
refresh. Edits to matching inputs still invalidate affected results immediately.
A membership role change that preserves live ownership keeps the paid cache;
revocation removes it, and current permissions still gate private access.

Enable candidate interpretation with
`IOLAUS_MATCHING_CANDIDATE_INTERPRETATION_ENABLED=true` only on a gateway
route approved for private résumé evidence, with request and response
content logging and raw retention disabled. The provider requests content
logging suppression through the existing owned résumé route. Each request
uses native user usage accounting and requires an effective lifetime or
monthly cap.
The standalone matching-only runner continues to use the same stored results
without calling a provider.

For a bounded live source-only check on an isolated PostgreSQL database,
use `matching:source-enrich` with the isolated `--database-name` and at
most ten explicit `--opportunity=<UUID>` selectors, or use
`--backlog=<scan steps>` for a bounded pass over the durable shared cursor.
The command reports source attempts, outcomes, and the reason it stopped.
Repeat a backlog pass to continue; the normal hourly ledger, leases, and
retry schedule still apply. The command enforces
local-only connection details and native call, token, and spend ceilings
(at most eight paid calls, 100,000 input tokens, and one dollar per hour).
An interpreted source can use two calls; a retry can reuse a previously
accepted draft without paying to extract it again. At that limit a run of
four uncached sources can take the entire hour. At that rate, a catalog of
11,221 live listings would take at least 2,806 hourly windows (about 117 days)
if every source needed both requests. Use bounded diagnostics rather than a
blind paid sweep. A successful sample does not establish catalog readiness.
Leave the ordinary worker and
all crawlers off in
that clone; use the existing intelligence control for the scope of the
test and restore it afterwards. Do not include candidate information in
source probes.

The provider-free worker command requires an explicit
loopback PostgreSQL `DATABASE_URL` for the named isolated clone. Keep all
other job workers off during isolated QA. For evidence of authorization,
publication, retries, and reader behavior, see
[normalized-matching-test-matrix.md](normalized-matching-test-matrix.md).

## Local verification

A PostgreSQL clone held 31,325 opportunities: the original public-source
cohort, 61 authored cases, and 20,000 realistic-format fictional scale
listings. The fixed fictional backend candidate produced 56 authored
matches, two conflicts, and three unresolved cases. The scale cohort
produced 4,000 matches, 10,000 conflicts, and 6,000 unresolved cases.
The distinct original cohort had 11,221 live, listed source snapshots.
The system recognized roles on 872 and geography on 7,633; the fixed
backend candidate had 5,231 conflicts, 5,990 unresolved postings, and no
confirmed matches in that cohort. The most frequent unresolved reasons
were unsupported posting requirements, unrecognized roles, and unspecified
geography. This is a coverage limitation, not an estimate of production recall.

A deliberately selected original Observability posting had one clear
required group: production experience with Go, Rust, or Scala. Governed
source interpretation preserved all three alternatives and their shared
qualification. A separate fictional profile with an explicit Palo Alto
target and verified production Go evidence qualified through the ordinary
worker. The browser showed the original description and why Go met the
requirement. This verifies the real-source path; it does not estimate recall.
The other three successfully interpreted postings stayed partial. Their
unresolved evidence included remote jurisdiction restrictions, technical
qualifications such as production backend or database work, and qualitative
requirements such as independent delivery. Across the bounded development
experiment, four provider responses were accepted and four rejected, at
$0.007195 total. The isolated provider control was then disabled.

| Built app first page | Shell p50 / p95 | All 100 cards p50 / p95 |
| --- | ---: | ---: |
| Cold browser context, 15 trials | 16 / 17 ms | 215 / 244 ms |
| Warm browser context, 15 trials | 17 / 28 ms | 206 / 221 ms |

Chromium ran against the same local PostgreSQL clone. Cold here means
a fresh browser context; the built process and database were already
running. Each navigation executed 159 database statements across all
requests, including native session, membership, permission, and shell
requests. The opportunity payload used one count, one page ID query,
one bounded record batch, and one currentness recheck plus batch review
and application reads. Database logs showed no per-card queries.

On the same fixture, five cold and five warm Home navigations finished
rendering all six discovery cards in 129 / 135 ms (cold p50 / p95)
and 97 / 211 ms (warm p50 / p95). The Home shell streamed before its
overview data, and the Opportunities shell remained usable while its
separate list payload was delayed.
