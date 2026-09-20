# Final cutover preservation preflight

The qualified final cutover is a fresh native source clone into a new isolated
database. Before the application wrapper runs, take a protected snapshot of
the approved target-only owner closure and its independent extra object. Do not
copy sessions, API keys, or other transient authentication state.

Run the public schema sequence exactly: `smrt db:migrate --verbose`, then
`smrt db:migrate-null-equal-indexes`, then `smrt db:migrate`, and only then the
application `db:migrate` wrapper. The preflight resolves tenant, role, and
profile type by semantic `slug`/`context`, rejects missing or ambiguous parents,
and permits only an absent-row insert or byte-identical retry noop. Its bounded
applicator accepts a transaction-scoped database adapter and writes only those
four preflight-approved rows; the protected snapshot reader remains an
operator-only final-window step.

A global profile's null `tenant_id` stays null; its membership still resolves
the tenant semantically. A populated profile tenant must match that membership's
source tenant. Parent IDs may change; the four root IDs and all other values
must survive exactly.

Retry comparison and transfer digests include every supplied root field,
including `created_at` and `updated_at`. Timestamp-only differences are
no-overwrite conflicts, even when the root ID and business fields match.

First compare fresh source assets to the current target bucket. If every source
object is byte-identical there, retain that bucket and preserve the one extra
object; otherwise stop before bucket changes. Keep the protected snapshot and
full receipts mode 0700/0600. Console evidence contains counts, hashes, and
dispositions only.

| Invariant | Positive / negative rehearsal | Command |
| --- | --- | --- |
| Exact four-row owner closure resolves semantic parents | Insert/apply plan; missing/ambiguous parent rejected | `node --test scripts/final-cutover-preservation.test.mjs` |
| Retry cannot overwrite a changed root | Identical root is noop; changed root rejects | `node --test scripts/final-cutover-preservation.test.mjs` |
| Extra asset is independent and no-overwrite | Absent object copies; identical is noop; hash conflict rejects | `node --test scripts/final-cutover-preservation.test.mjs` |
| Sessions remain ephemeral | Source session count is observed but never planned | `node --test scripts/final-cutover-preservation.test.mjs` |

The opt-in integration case in that same test file uses a **local disposable
PostgreSQL 17 database restored from the protected target dump**. Set
`PRESERVATION_PROOF_DATABASE_URL` to its connection URL (database name must end
in `_proof`), and `PRESERVATION_PROOF_PG_MODULE` to the installed `pg` module
entry point if it is not directly resolvable. It selects the exact closure by
foreign-key joins, never by independently selecting the first row of each table.
It temporarily truncates the four roots and their dependents inside an outer
transaction that always rolls back. Never point it at a working database.

| Behavior / trigger | Positive and failure evidence | Context / executor / runtime | Contract / level |
| --- | --- | --- | --- |
| Restore preserved owner closure | Original four IDs and complete row hashes match after semantic parent remap; invalid closure rejected | Local protected snapshot; one PostgreSQL connection; PostgreSQL 17 | Four existing tables; integration |
| Retry apply | Four noops and zero SQL writes; same email with another ID rejected | Same connection and snapshot | No overwrite; integration |
| Timestamp-only retry change on any root | Exact timestamps permit noop; changing either `created_at` or `updated_at` rejects before opening an application transaction | Operator retry; supplied snapshots in Node unit cases and same-connection PostgreSQL 17 reads | Complete supplied row values; unit and integration via the same test command above |
| Ambiguous parent | Duplicate semantic tenant rejected before writes | Operator preflight; PostgreSQL-read snapshot | Slug/context lookup; integration |
| Mid-apply SQL failure | Division by zero on third insert, after two successful writes; all four root tables empty after rollback | Same connection; real SQL savepoint rollback | Atomic adapter; integration |
| Global profile | Null tenant preserved while membership tenant maps | Unit and restored PostgreSQL fixture | Nullable profile tenant; both levels |
| Invalid asset manifest | Empty, duplicate-key, malformed-hash inputs rejected | Pure operator preflight; Node | Manifest validation; unit |

Executed on 2026-09-19 against the restored protected target schema: all eight
tests passed, including the opt-in database case. The pre-fix restored-schema
case failed because the global profile's tenant was rewritten; the focused unit
case covers that regression. The failure test proves actual database rollback,
not merely propagation of an adapter error. It verifies the transaction adapter
used by the rehearsal; the final-window operator must supply the same atomic
connection semantics. This is a local preservation rehearsal, not evidence of
production application or final source-clone freshness.

On 2026-09-20, the eight timestamp-only regression cases (two fields across
four roots) all failed against the previous comparison with missing expected
rejections. After including those fields, all sixteen tests passed with the
restored PostgreSQL case enabled. That case also changes each timestamp in the
actual database, confirms rejection with zero application writes, and rolls
back each change before continuing the existing preservation proof.
