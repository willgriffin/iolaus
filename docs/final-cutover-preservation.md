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
