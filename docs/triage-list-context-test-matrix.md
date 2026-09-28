# Triage list-context verification (#112)

Browser triage retains the list's filters and ordering, adding only exclusion
of decided opportunities. The agent tool retains its existing preset.

| Behavior/invariant | Reachable trigger | Positive / negative case | Actor/context | Data executor/transaction | Runtime | External edge | Test level / command |
| --- | --- | --- | --- | --- | --- | --- | --- |
| List state reaches the queue | Open toolbar or deep link | All filter fields and all sort directions retained; agent overrides absent | Authenticated owner | Existing request-scoped query; read only, transaction N/A | PostgreSQL SQL and SQLite bounded collection | Invalid sort handled by existing parser | Action/queue specs; focused command below |
| Selected order is visible and stable | Hydration and queue refill | Server order survives live collection ID order; missing values last and stable ties | Owner browser | Existing list/count/page queries; no new mutation | Both SQL dialects and JS fallback | Live data can reorder its collection independently | SQL fixture matrix (five sorts × two directions), filter unit tests, mobile E2E |
| Active filters constrain the queue | Open a filtered list | Matching row included; skill/search/status/expiry/staleness/decided negatives excluded | Owner | PostgreSQL fixture query; SQLite JS queue filter | PG complete filters; SQLite queue filters | Existing SQLite list SQL restrictions tracked in #114 | SQL and queue fixture specs; browser compensation/status test |
| Decisions and skips preserve sequence | Six cards across three-card windows; reject one; reopen | Later advances through refills; rejected card absent on reopen; old stored deck sort ignored | Owner browser | Existing review action persists decision; atomicity unchanged | Android portrait, landscape, narrow; desktop | Redirected action response and asynchronous refill | `mobile.spec.ts` inheritance test |
| Legacy links remain usable | `triageSort=newest` or explicit list sort | Legacy converted; explicit list sort takes precedence | Owner browser | N/A: navigation only | Four browser projects | Old query parameter and localStorage | `mobile.spec.ts` legacy-link test |
| Agent behavior is preserved | Next-candidate tool | Score-desc/reject-depriority and newest supported; browser gets numeric score order | Existing owner-principal tool | Existing read permissions; no new authorization | Both SQL dialects | Tool contract unchanged | Triage and WebMCP specs |

No schema, dependency, public API, or authorization change. Queue reads are
read-only; retry/undo persistence is unchanged and covered by the existing
triage session and review-action tests. No paid model or external employer
requests are used by these tests.

Focused command:

```bash
TRIAGE_TEST_POSTGRES_URL=<disposable-postgres-url> pnpm --filter @willgriffin/iolaus-site exec vitest run \
  src/lib/server/opportunity-triage.spec.ts \
  src/lib/server/admin-opportunity-triage-ranking.db.spec.ts \
  src/lib/server/admin-resource-route.spec.ts \
  src/lib/opportunity-filters.spec.ts \
  src/lib/admin/triage-session.spec.ts \
  src/lib/components/admin/OpportunityTriageModal.spec.ts \
  src/lib/components/admin/AdminHydratedResourcePage.spec.ts
pnpm --filter @willgriffin/iolaus-site exec playwright test mobile.spec.ts
```

Regression evidence: the new queue/filter tests executed against base
`4785f2c` fail on inherited filters/order and missing-value/tie handling. The
new browser inheritance test also fails on that base because the visible list
loses server ordering. The same browser scenario passes with the fix across
all four viewport projects (64 total E2E scenarios). Evidence logs and the
exact reviewed revision are recorded with the pull request.

The documented legacy `db:migrate`/`db:status` wrappers have an existing SQLite
adapter limitation (issue #104). E2E setup executes canonical SMRT migration
and status checks on an isolated SQLite database successfully. The PostgreSQL
SQL fixture suite runs against isolated temporary tables. Pre-existing
PostgreSQL-only expressions in some SQLite list filters are tracked in #114;
those unsupported list paths are not claimed as passing SQLite coverage.
