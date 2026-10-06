# Issue 155: displayed recommendation sorting

| Behavior | Trigger | Positive | Negative | Actor / executor / runtime | Edge / test | Command |
|---|---|---|---|---|---|---|---|
| Explicit match/recommendation sort | Header or selector, asc/desc | Current badge percentage orders before pagination | Stale, unassessed and title-only remain last; legacy fit cannot override | Verified workspace, native SQL, SQLite fixture + daily PostgreSQL | Native query and in-memory tests | targeted Vitest |
| Legacy and best sorting | Screening disabled or best selected | Existing legacy score and best prioritization retained | No hidden conflict priority in explicit numeric sort | Same contexts; no writes/provider calls | Existing regression suites | targeted Vitest |
| Daily view | Existing score URL | Monotonic visible badge values | No per-page-only reorder | Authenticated daily browser | Live UI QA | Browser sort asc/desc |

No schema or provider contract change. Reuses existing owned current-result projection; no new authority path. User requested immediate daily-use change; no release scope.

Validation (2026-10-04):
- Isolated snapshot: 136 tests passed, 2 existing skips across native query, in-memory filters and OpportunityCardList. New regressions failed against the prior implementation.
- Daily PostgreSQL browser: ascending first 100 badges are 0.0%; descending first 100 are monotonically ordered from 94.6% through 78.6%, with no alert. Sorting occurs before native pagination.
- Corrected a transient PostgreSQL unused-parameter error during live QA by binding conflict metrics only for best-fit ordering.
- SMRT review routing inspected; strict knowledge freshness passed with zero findings. git diff --check passed. Independent worker review unavailable due to worker quota.
- Local daily-use change only; no deployment or provider calls. Screenshot: /tmp/iolaus-recommendation-sort.png.
