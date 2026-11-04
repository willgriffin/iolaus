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
| Shared source interpretation | Unresolved original posting | Exact cited typed capability groups feed the same projection | Invalid/omitted clauses stay unresolved, delayed provider result becomes obsolete; no duplicate for same capture | Platform worker | Native governance reservation plus pinned transaction; SQLite/PostgreSQL | Public source only; no candidate data in provider request | `matching-source-extraction.spec.ts`, `matching-source-extraction-worker.integration.spec.ts`, capped local probe |
| Candidate normalization | Profile evidence or preference edit | Multiple roles and locations; current cited owned evidence | Missing, negated, malformed or sibling evidence; unresolved must-have | Candidate owner | Scoped native query, Node/SQLite; shared journey on PostgreSQL | Optional, invalid and unknown screening questions | `matching-projection-input.spec.ts`, `normalized-matching.spec.ts`, shared browser journey |
| Eligibility and rank | Compare current snapshots | Alias, directional support, AND/OR, optional unknown | Related-only, role/geography conflict, unknown hard duration | Background worker | Pure Node classifier | No paid provider; deterministic reasons and order | `normalized-matching.spec.ts`, worker integration |
| Raw currentness | Raw posting, listing or vocabulary edit | A current result reappears after supported edit | Old result disappears before recomputation; rollback keeps current result | Source operator/system | Native transactional triggers; SQLite and PostgreSQL | Close, delete, opt-out, reactivation, raw writers | `matching-projection-{schema,worker}.integration.spec.ts` |
| Private currentness | Evidence, preferences, ownership or membership change | Owner can read current result for selected profile | Stale, inactive, other tenant/user or sibling profile denied | Verified workspace, system worker | Pinned mutation plus SQL live gate; SQLite and PostgreSQL | Reparenting, deletion, membership revocation | Schema/worker integration, preference/input tests |
| Publication | Delayed calculation or rollback | Still-current pair commits | Delay past committed source/profile change cannot publish; rollback retains watermark | Worker | Native pinned transaction; SQLite and PostgreSQL | Retry and duplicate invocation | Worker integration |
| Backlog | Startup, new raw rows, interrupted work | Durable forward cursors beyond 10,000 rows | Partial batch rolls back; stale results stay excluded | Matching-only worker | Native PG local clone, SQLite/PG parity on bounded fixture | No catalogue cutoff; bounded batches | Worker integration, local scale journey |
| Discovery | List, count, page, filters, Home, triage, bulk | Same qualified cohort; explicit history reachable | Pending, conflicts and stale results cannot enter; stale selection refused | Verified owner, other workspace | Request-scoped SQL; SQLite and PostgreSQL | Stable ordering, no provider, streaming shell | `admin-opportunity-discovery.integration.spec.ts`, targeted app tests and browser journey |
| Migration | Bootstrap and release schema preparation | Install and repeat safely | Missing trigger repairs and invalidates old decisions | Local migration operator | SQLite and PostgreSQL native DDL | Existing raw rows, permissions | Schema integration, `db:migrate`, `db:status` |

Run the focused suites with:

```sh
pnpm --filter @willgriffin/iolaus-site exec vitest run \
  src/lib/server/normalized-matching.spec.ts \
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
