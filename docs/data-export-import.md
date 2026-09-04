# Database export and import

Database maintenance is an advanced PostgreSQL capability, not part of the
first local-install promise. Configure your own database explicitly. Never use
someone else's production database, cluster or credentials.

`pnpm --filter @willgriffin/iolaus-site db:export` creates a backup from the
configured current database. `db:verify-backup` verifies its contents before
`db:import -- --from <backup-directory>` imports it. Read each command's help
and keep backups outside Git. Local-only and explicit-production confirmation
guards remain enforced by the maintenance tooling.

Backups are bound to the local data directory or hosted public origin that
created them. When deliberately moving a verified backup to a replacement
machine, data directory, or public origin, pass `--allow-installation-rebind`
to `db:import` or `db:reset-local`. Without that explicit recovery flag,
cross-installation restores fail closed.

The predecessor application's cluster-specific production pull command is
intentionally not distributed. Restore and backup procedures for a hosted
deployment belong to that deployment's private operational documentation.

## willgriffin.dev logical migration

The predecessor migration is deliberately separate from generic Iolaus
portability. It reads a verified, isolated PostgreSQL restore and writes a
private logical bundle. The exporter requires a loopback PostgreSQL endpoint
whose database name visibly contains `backup`, `issue`, `restore`, `test`, or
`verify`, matching the repository's disposable restore guard. Connection URL
query parameters and fragments are rejected so they cannot override that
validated endpoint. Set the source
URL through the environment so credentials do not enter shell history, then
attest that the endpoint is the isolated restore:

```bash
export WILLGRIFFIN_MIGRATION_SOURCE_DATABASE_URL='<isolated restore URL>'
export WILLGRIFFIN_MIGRATION_SOURCE_ISOLATED_RESTORE=true
pnpm migration:willgriffin:export -- /absolute/private/path/migration.json
```

The export transaction is repeatable-read and read-only. The command verifies
the predecessor migration markers and compatible logical schema before reading
any rows: every table must be migrated or explicitly excluded, and logical
columns, types, and required nullability must match, while database integrity
guards may strengthen nullable manifest fields
or add derived PostgreSQL-generated bridge columns. Its deterministic source
fingerprint and run ID exclude timestamps. The bundle is created atomically
with mode `0600` outside the checkout; it contains private candidate and
application data and must be handled like a database backup. Never commit it,
attach it to an issue or pull request, or paste it into logs.

Build and migrate a fresh PostgreSQL Iolaus target before import. A new run
requires the exact pinned framework bootstrap row counts and refuses any other
pre-existing migrated data; only a ledger-backed resume may continue after
committed batches. Stop web and
both worker processes, enable maintenance mode, and preview the exact bundle:

```bash
export SMRT_RUNTIME_PROFILE=self-hosted
export SMRT_MAINTENANCE_MODE=true
pnpm migration:willgriffin:import -- /absolute/private/path/migration.json --dry-run
pnpm migration:willgriffin:import -- /absolute/private/path/migration.json
```

Import is parent-first and preserves each stable source ID. Each bounded batch
commits its target upserts and `_iolaus_migration_*` checkpoint/row ledger in
one transaction. Restarting the same deterministic run resumes after the last
committed table cursor. A second completed run verifies the imported rows,
makes zero changes, and returns the same reconciliation digest. Output contains
only counts and hashes, never row values or database endpoints.

Before any row write, the importer performs deterministic reconciliation over
the complete logical bundle. Missing or quarantined parents cascade to their
children; duplicate natural keys, duplicate junction cardinality, malformed
UUIDs, cross-tenant references, self-reference cycles, and unqualified
persisted SMRT `_meta_type` values are quarantined instead of being silently
nulled or dropped. The sole automatic relationship repair converts an empty
nullable reference sentinel to `null`; every such repair has the stable reason
code `EMPTY_REFERENCE_TO_NULL`.

The command's `reconciliation` object is the secret-safe machine report. It
contains per-table attempted/imported/updated/skipped/rejected/repaired counts,
source/accepted/target SHA-256 checksums, full target row counts, explicitly
classified retained bootstrap-row counts, hashed selectors for collisions and
quarantine entries, deterministic reason codes, the exact excluded-table
inventory, and an operator summary. Target checksums are recomputed from every
row read back from PostgreSQL; unexplained target rows fail the import. It never
contains source ids, natural keys, field values, file paths, URLs, credentials,
or database details. The same
report and quarantine records are persisted in
`_iolaus_migration_reconciliation` and `_iolaus_migration_quarantine`; a retry
reconstructs stable-ID collision evidence from the row ledger so its report
digest remains deterministic after interruption.

SMRT upgrade hazards are explicit in every report: the predecessor domain
package qualifier rename is handled by table-bound import, persisted framework
STI values remain package-qualified, `sources.id` uses the approved UUID-to-text
adapter, application schedule ids retain their text form, and obsolete
`smrt_classes`/`smrt_objects` registries are excluded. Reconciliation refuses
invalid rows rather than guessing a replacement identifier.

Iolaus-only DataSurface preview and idempotency tables must be empty before and
after import. Historical schedules are imported disabled, and nonterminal job
records are made terminal so rehearsal cannot replay work. It intentionally
excludes sessions, API keys, magic-link and CLI authentication tokens/limits,
transient OIDC email reservations, live worker and Forge delivery leases,
framework migration/change/dispatch/embedding telemetry, local restore
evidence, repair audit state, and obsolete SMRT class/object metadata. OIDC and Nostr identity rows,
including encrypted-at-rest identity fields, are preserved inside the private
bundle; their values never appear in command output or reconciliation reports.

Referenced file discovery, copying, checksums, and quarantine are a separate
asset-migration phase. The reconciliation module exposes the common asset
result contract used by that phase: each referenced asset is verified by
source/target checksum and receives `ASSET_MISSING` or
`ASSET_CHECKSUM_MISMATCH` when it cannot be admitted. This logical importer
preserves database records but does not copy asset bytes. Its report marks the
asset section `pending` rather than presenting an empty asset inventory as a
successful verification. The asset phase replaces that section with a
`complete` inventory and new report digest after it verifies every referenced
object. That inventory binds hashed asset selectors to canonical source and
target SHA-256 values without exposing paths or identifiers; a row-only report
is not cutover evidence for assets.

Intentional exclusions are always reported: sessions and authentication
tokens, API/CLI credentials, deployment secrets, live worker/delivery leases,
framework migration/change telemetry, transient DataSurface preview and
idempotency rows, and unreferenced temporary artifacts. `approvedOmissions` is
empty unless an owner-approved rehearsal decision explicitly changes it; never
edit a report after generation to hide an omission.
