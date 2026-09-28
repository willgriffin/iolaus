# Saved evaluation freshness: validation contract

Saved automated scores are selected only when both posting content and the current
scoring-material target match. Source-current human evaluations remain authoritative.
A scheduled scan visits at most 25 previously scored, non-archived opportunities per
minute; freshness after candidate edits is eventual, bounded by a full scan. It uses
the existing governed score queue and does not enable model spending itself.

| Behavior | Positive and negative evidence | Runtime / boundary |
| --- | --- | --- |
| Material fingerprint | Stable untrimmed input; candidate evidence edits change the fingerprint; final evidence failure rejects persistence | Scoring unit specs; candidate collections and configured scoring policy |
| Current score selection | Source and material match accepted; legacy/mismatched automated scores excluded; current human score retained | Query and hydration specs plus SQLite/PostgreSQL ranking fixtures |
| Bounded reconciliation | Cursor advances/reset, current scores skipped, changed targets reset retries, failures back off and cap at three | Reconciler specs with live SQLite/PostgreSQL SQL; queue boundary injected |
| Concurrent refresh | Overlapping scans reserve one attempt; changed posting prevents reservation; cursor write preserves governance fields | Live SQLite/PostgreSQL adapter tests; logical overlap on one test connection |
| Persistence race | New candidate material/target prevents old score job from replacing current target or changing recommendation state | Intelligence unit specs with interleaved target mutation and guarded-write assertions |
| Migration and dispatch | Upgrade from production revision preserves opportunity/score rows; new columns present; rerun retains one schedule; real ScheduleRunner creates a TaskRunner job that invokes the control method | Disposable PostgreSQL 18; production migration/status scripts and native worker bootstrap |
| List and triage integration | Inherited list filters/order and refreshed score visibility continue together | Shared list/triage DB fixtures and mobile browser suite |

Run the relevant `opportunity-scoring`, `opportunity-intelligence`,
`opportunity-score-refresh`, job, query, route, and WebMCP specs first, then the
repository's format, lint, check, test, build, and knowledge checks. Set
`TRIAGE_TEST_POSTGRES_URL` for both live PostgreSQL ranking and reconciler
fixtures (see each spec).
Run `db:migrate` and `db:status` against a disposable PostgreSQL database, not
production, for migration evidence. A new database needs canonical SMRT bootstrap
before the application's legacy migration wrapper.

The native dispatch smoke uses a legacy score without prepared posting material:
it proves the persisted schedule resolves its method and completes a bounded scan;
it does not call an external model. Paid-model quality and production scan duration
are operational follow-up checks, not claims made by this test suite.
