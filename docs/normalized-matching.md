# Normalized opportunity matching

Opportunities, Home discovery, and triage show postings that meet the current
candidate profile's target roles, work locations, required posting criteria,
and enabled must-have screening questions. Best orders that set by match
score; Newest orders the same set by date. Saved reviews and applications are
available through their respective history views. An explicit deep review
can use additional analysis, but it cannot admit a posting into discovery.

Set roles, locations, and work arrangements under **System → Preferences →
Matching preferences**. The fields are shared with onboarding. A current or
past job title is evidence about a career, not a search target. Add current
résumé skills, positions, achievements, or a verified skill experience note
to supply evidence; inferred or cached AI skill suggestions are excluded.
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
  they do not prove a required skill. In a verified OR group, one proven
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
The optional source interpretation pass can handle more prose once per
verified posting revision, within an operator-set shared budget. It sends
only the posting title, description, and location to the configured model.
Candidate evidence and per-profile comparisons stay in the application.
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
evidence, and failed or pending computations are excluded. Discovery reads do
not run the matcher.

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

For a bounded live source-only check on an isolated PostgreSQL database,
use `matching:source-enrich` with the isolated `--database-name` and at
most ten explicit `--opportunity=<UUID>` selectors. The command enforces
local-only connection details and native call, token, and spend ceilings
(maximum one dollar). Leave the ordinary worker and all crawlers off in
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
