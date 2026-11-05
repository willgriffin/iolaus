# Normalized matching acceptance tests

High-risk changes are the tenant/profile boundary, database revision triggers,
and transaction that publishes an eligibility decision. Only server-verified
workspace identity may select a profile; even a correctly shaped ID does not
grant access. Database operators are trusted to run schema migrations and
raw import. Request input, free-text posting content, and generated analysis
are not trusted to grant matching eligibility.

| Invariant | Trigger | Positive case | Failure case | Actor and context | Executor and runtime | Contract edge | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Source normalization | Ingest raw posting | Cited role, geography and required groups | Unknown geography, malformed capture, ambiguous hard requirements | System | Pure Node parser and capture adapter | Missing or incomplete fields, HTML offsets | `normalized-matching.spec.ts`, `matching-projection-input.spec.ts` |
| Shared source interpretation | Unresolved original posting | Two governed requests interpret and verify the same public source units and canonical predicates | Missing units, wrong digests, omitted qualifiers or changed logic stay unresolved; a delayed result cannot publish after a source edit | Platform worker | Native reservation for each request plus pinned publication; SQLite/PostgreSQL | Exact source-only payload, strict schema, resume a cached draft, lease/budget denial | `matching-source-{semantics,normalization,extraction-provider}.spec.ts`, `matching-source-extraction-worker.integration.spec.ts`, capped local probe |
| Verified qualitative requirements | A fully read source names an unquantified, governed trait | Exact source citation retained as a candidate gap; direct support of a different required capability is still needed for discovery | Unknown or negated scope, technical conjuncts, numerical minimum or eligibility cannot become a qualitative gap | Shared source worker and verified profile | Pure parser and native versioned publication | Full unit and independent verification | `matching-source-semantics.spec.ts`, `matching-screened.spec.ts` |
| Verified optional detail disagreement | Source and verifier agree the unit is preferred, details differ | Optional uncertainty does not block the hard eligibility set | Unknown or contradictory polarity remains blocking | Shared source worker | Pure Node normalization | Independent source cue and verifier agreement | `matching-source-semantics.spec.ts` |
| Independent catalog interpretation | Stratified public diagnostic sample and disjoint holdout | Full required scope, required/preferred separation, clear role and location | Hard requirement, ambiguity, or mismatch never hidden by a model interpretation | Local QA reviewer, no candidate input | Read-only on isolated local catalog; no model writes to private input | Captured real postings with independent raw-text judgments, model vs deterministic | Local 34 diagnostic and 12 holdout labels, recorded separately from candidate-specific QA |
| Candidate normalization | Profile evidence or preference edit | Multiple roles and locations; current cited owned evidence | Missing, negated, malformed or sibling evidence; unresolved must-have | Candidate owner | Scoped native query, Node/SQLite; shared journey on PostgreSQL | Optional, invalid and unknown screening questions | `matching-projection-input.spec.ts`, `normalized-matching.spec.ts`, shared browser journey |
| Private evidence interpretation | New evidence or vocabulary revision | Each source accounted for; verified semantic claims retain exact citations and activity context | Fabricated citation, unsupported agency or inferred duration, invalid schema, preflight refusal, ambiguous submission | Revalidated profile owner | Native ledger and leased source pin, independent paid phases on Node | Full prompt and response envelope bounded; private inputs excluded from posting extraction | `matching-candidate-interpretation.spec.ts`, bounded private canary |
| Private evidence lifecycle | Owner edit, deletion, retry, or posting change | Atomic publication, draft reuse after verifier refusal, stable cache on posting or preference edit | Concurrent ownership change or removal invalidates work, deletion rolls back together, ambiguous paid work cannot repeat | Owner, foreign workspace and denied principal | Same pinned SQLite and PostgreSQL transaction | No provider calls from deterministic pairing | `matching-candidate-worker.integration.spec.ts` |
| Private draft subdivision | Settled output-length response, or explicit local recovery of an observed historical failure | Preserve the verified prefix, give each half a distinct request ID, and resume after preflight refusal | Filtering, ambiguous usage, duplicate recovery, stale evidence, and scope revocation cannot repeat the original call | Fresh owner, racing recovery and denied scope | Pinned SQLite and PostgreSQL transactions | Bounded smaller requests under native accounting | `matching-candidate-{interpretation.spec,worker.integration.spec,recovery.integration.spec}.ts` |
| Attributed and dated composition | Current snapshots paired | Conditions from the same verified project or cited activity, attributed duration union, qualitative action evidence | Disconnected projects, unrelated technology, unknown dates, bare title and explicit upper bound | Candidate owner and background matcher | Pure deterministic Node evaluator and native projection refresh | N/A because pairing consumes stored assertions | `matching-candidate-composition.spec.ts`, `matching-candidate-experience.spec.ts` |
| Role preference lifecycle | Save a raw role discipline, then run worker and open discovery | Governing family matches; unchanged preference bytes | Wrong specialty or seniority, unrelated role, unsupported alternatives, stale result | Verified candidate owner | Native transaction/current gate; Node, SQLite and PostgreSQL | Actual onboarding suggestions, exact unknown literals | `normalized-matching.spec.ts`, `matching-projection-worker.integration.spec.ts` |
| Conservative career duration | Current raw dated positions | Overlapping supported titles establish only a lower bound with all citations | Future/malformed dates, unrelated titles, standalone tools and production context stay unproven | Verified candidate owner | Pure normalization of scoped input; Node | English month dates, partial dates, ongoing positions | `matching-candidate-experience.spec.ts` |
| Coverage explanations | Current discovery query returns no rows | Count missing, unsupported, unresolved and conflict categories | No stale, inactive, other-workspace, or duplicate reason count | Verified candidate owner | Native scoped read; SQLite and PostgreSQL | Current result codes only, no candidate text in response | `admin-opportunity-discovery.integration.spec.ts` |
| App typography | Opportunities list and filters at default browser zoom | Legible title/body/meta, controls usable, visible keyboard focus | No clipping or horizontal overflow at narrow widths | Signed-in member | Browser styles, no database mutation required | Desktop and narrow browser layout | Local Chromium at 1440, 360, and 320 px |
| Eligibility and rank | Compare current snapshots | Alias, directional support, AND/OR, optional unknown | Related-only, role/geography conflict, unknown hard duration | Background worker | Pure Node classifier | No paid provider; deterministic reasons and order | `normalized-matching.spec.ts`, worker integration |
| Raw currentness | Raw posting, listing or vocabulary edit | A current result reappears after supported edit | Old result disappears before recomputation; rollback keeps current result | Source operator/system | Native transactional triggers; SQLite and PostgreSQL | Close, delete, opt-out, reactivation, raw writers | `matching-projection-{schema,worker}.integration.spec.ts` |
| Private currentness | Evidence, preferences, ownership or membership change | Owner can read current result for selected profile | Stale, inactive, other tenant/user or sibling profile denied | Verified workspace, system worker | Pinned mutation plus SQL live gate; SQLite and PostgreSQL | Reparenting, deletion, membership revocation | Schema/worker integration, preference/input tests |
| Publication | Delayed calculation or rollback | Still-current pair commits | Delay past committed source/profile change cannot publish; rollback retains watermark | Worker | Native pinned transaction; SQLite and PostgreSQL | Retry and duplicate invocation | Worker integration |
| Bulk write fence | Match changes after apply resolves preview | A current selected Decision or native job writes on the locked executor | A stale generation refuses that row; competing PostgreSQL revoke waits for write | Verified candidate owner | Same pinned SQLite/PostgreSQL transaction | Per-row action result, no stale enqueue | `opportunity-data-surface-actions.spec.ts`, worker integration |
| Backlog | Startup, new raw rows, interrupted work | Durable forward cursors beyond 10,000 rows | Partial batch rolls back; stale results stay excluded | Matching-only worker | Native PG local clone, SQLite/PG parity on bounded fixture | No catalogue cutoff; bounded batches | Worker integration, local scale journey |
| Screened candidate gaps | Verified complete source, then compare current candidate evidence | Supported role and work location/mode, known requirements and exact direct proof or partial support (including explicit required examples), remaining known candidate gaps | No direct evidence, unresolved source, unknown must-have, disputes or known conflicts stay hidden; an observed duration can support a gap even below the minimum; an explicit upper duration bound below minimum or contrary context cannot anchor partial support | Candidate owner and platform worker | Deterministic Node evaluation, additive flag, native transaction on SQLite/PostgreSQL | Strict qualified decision unchanged; no raw evidence in pair results | `matching-projection-{schema,worker}.integration.spec.ts`, screened decision unit tests |
| Discovery | List, count, page, filters, Home, detail, triage, bulk | Same two discovery tiers; Best qualified first, Newest date order; explicit history reachable | Stale or foreign rows excluded; bulk Apply and paid processing reject screened rows | Verified owner, other workspace | Request-scoped SQL and pinned write fence; SQLite and PostgreSQL | Safe gap reasons, stable ordering, no provider, streaming shell | `admin-opportunity-discovery.integration.spec.ts`, DataSurface action specs, app render tests and browser journey |
| Migration | Bootstrap and release schema preparation | Install and repeat safely | Missing trigger repairs and invalidates old decisions | Local migration operator | SQLite and PostgreSQL native DDL | Existing raw rows, permissions | Schema integration, `db:migrate`, `db:status` |

Run the focused suites with:

```sh
pnpm --filter @willgriffin/iolaus-site exec vitest run \
  src/lib/server/normalized-matching.spec.ts \
  src/lib/server/matching-candidate-experience.spec.ts \
  src/lib/server/matching-screened.spec.ts \
  src/lib/server/matching-source-normalization.spec.ts \
  src/lib/server/matching-source-semantics.spec.ts \
  src/lib/server/matching-source-extraction-provider.spec.ts \
  src/lib/server/matching-projection-input.spec.ts \
  src/lib/server/matching-projection-schema.integration.spec.ts \
  src/lib/server/matching-projection-worker.integration.spec.ts \
  src/lib/server/matching-source-extraction.spec.ts \
  src/lib/server/matching-source-extraction-worker.integration.spec.ts \
  src/lib/server/admin-opportunity-discovery.integration.spec.ts
```

Set `IOLAUS_MATCHING_TEST_DATABASE_URL` to an isolated loopback PostgreSQL
database to exercise the same fixtures in PostgreSQL. They create and remove
randomly named schemas; they do not use the public schema. Run the ordinary
repository checks and the isolated database migration/status checks in
[the repository guide](../AGENTS.md) before shipping.

The shared browser exercise uses fictional member and operator accounts and
raw posting rows. Check the member's first page, page two, filters, Newest
and Best, the triage dialog and Home; confirm the other workspace does not
borrow the member's evidence. Edit the member's target role through Matching
preferences, check that the old match disappears, then restore it and wait
for the matching-only worker to publish. An intentionally disabled external
auth provider means this exercise uses native synthetic sessions; it does not
cover external sign-in.
