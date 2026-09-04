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
or missing persisted SMRT `_meta_type` values are quarantined instead of being silently
nulled or dropped. The sole automatic relationship repair converts an empty
nullable reference sentinel to `null`; every such repair has the stable reason
code `EMPTY_REFERENCE_TO_NULL`.

Uniqueness and junction cardinality come from the exact pinned manifest unique
indexes, including tenant, STI, relationship-role, and empty-string dimensions;
the checked-in overrides cover only predecessor semantic relationships that
the manifest cannot express.

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

Fresh-target admission verifies both the exact count and canonical semantic
checksum of every pinned bootstrap table. The checksum ignores generated row
identifiers and `created_at`/`updated_at` audit clocks; the control row's
deployment-time `window_started_at` is normalized only to initialized/uninitialized.
All other business timestamps and stable field content are bound, and foreign
keys resolve to the referenced row's stable semantic identity, so
random UUID regeneration cannot mask a changed role/permission relationship.
Source catalog rows that match those verified target rows by their manifest
natural key (or the role-permission semantic edge) retain the fresh target ID;
all imported references are deterministically remapped and the source-ID
collision is recorded by hash.
Import processes serialize through a PostgreSQL session advisory lock. The
operator-visible lease row is replaced only after that lock is acquired, so a
process crash releases authoritative ownership with its database session and
the same checkpointed run can resume without manual lease deletion. Completion runs in one
transaction that locks every migrated table against writers, re-reads and
rechecks every target checksum, persists the reconciliation report, and marks
the run complete.

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
target SHA-256 values without exposing paths or identifiers. Any quarantine
changes its status to `complete-with-rejections`, and the operator summary
includes verified and quarantined asset counts. A row-only report is not
cutover evidence for assets.

Intentional exclusions are always reported: sessions and authentication
tokens, API/CLI credentials, deployment secrets, live worker/delivery leases,
framework migration/change telemetry, transient DataSurface preview and
idempotency rows, and unreferenced temporary artifacts. `approvedOmissions` is
empty unless an owner-approved rehearsal decision explicitly changes it; never
edit a report after generation to hide an omission.

## willgriffin.dev referenced asset migration

After the logical bundle is exported from the verified isolated database
restore, make a **read-only local copy** of the predecessor asset backup. Do
not pass a deployment checkout, a database dump directory, a credentials
directory, or a live storage mount as `--source-assets`. The asset planner
never scans that directory: it follows only persisted `ResumeAsset`,
`ResumeVariant`, and `Attachment` file references in the validated logical
bundle. It deliberately excludes source/provenance fields, crawler raw output,
credentials, database dumps, source checkouts, dependencies, and every
unreferenced temporary or legacy file.

The private manifest contains stable record IDs, logical asset paths, sizes,
and SHA-256 digests. Keep it outside Git with the database bundle. Planning
records deterministic quarantine reason codes for missing, corrupt, ambiguous,
unsafe, or over-limit paths; a quarantined plan is not eligible for import.
It caps the referenced set at the shared 256 MiB portability limit rather than
walking or copying an arbitrary storage tree.

```bash
pnpm migration:willgriffin:assets:plan -- \
  --bundle /absolute/private/path/migration.json \
  --source-assets /absolute/private/path/restored-assets \
  --manifest /absolute/private/path/assets-manifest.json
```

Import only after the logical import has completed against the isolated target.
It requires maintenance mode and the target's real self-hosted
`RESUME_FILES_CONFIG_JSON`; that provider configuration may be S3-compatible
and belongs solely in the scoped deployment secret. The migration currently
fails closed for non-local providers because the released generic provider API
does not offer atomic create-without-overwrite; configure local external
storage for rehearsal or add a provider-level atomic-create capability first.
The importer verifies every
target metadata reference by stable ID before and after copying. It preserves
safe relative paths, skips only checksum-identical existing objects, refuses to
overwrite mismatched target objects, and persists a private, `0600` resumable
journal with deterministic quarantine codes.

```bash
export SMRT_RUNTIME_PROFILE=self-hosted
export SMRT_MAINTENANCE_MODE=true
pnpm migration:willgriffin:assets:import -- \
  --source-assets /absolute/private/path/restored-assets \
  --manifest /absolute/private/path/assets-manifest.json
```

For the selected non-application published resume, the importer copies the
same verified immutable PDF to `published/resume.pdf` and requires its target
metadata selection to match. If a legacy source alias exists, it must already
match that selected PDF. A missing legacy alias is repaired from the selected
PDF; an ambiguous selection, checksum mismatch, missing file, unsafe path, or
preexisting mismatched target alias is quarantined and returns a nonzero exit.
Run the import again after a process restart: it verifies the same manifest,
makes no writes for checksum-identical assets, rechecks metadata and the alias,
and emits the same reconciliation digest.

## Synthetic rehearsal

Before requesting access to any production backup, run the repository-owned
synthetic rehearsal. It provisions a disposable loopback PostgreSQL cluster,
creates isolated local asset roots, and tears both down after the run:

```bash
pnpm migration:willgriffin:rehearse:synthetic
```

The runner prefers an installed PostgreSQL server. When only the `libpq`
clients are present, it uses an already-present `postgres:16-alpine` image and
does not pull or publish images.

The runner exercises a logical dry-run, an injected interruption after the
first committed database batch, checkpoint resume, an idempotent rerun,
deterministic reconciliation with one synthetic rejected relationship, asset
journal recovery after a failed write, asset checksum verification, and a
second zero-copy asset rerun. It then runs the deployed parity contract in its
network-denied synthetic environment. To exercise an already-built candidate,
pass exactly one immutable candidate selector:

```bash
pnpm migration:willgriffin:rehearse:synthetic -- \
  --image-ref ghcr.io/willgriffin/iolaus/site@sha256:<released-digest>
```

`--local-image-id sha256:<docker-image-id>` is available for a local candidate.
`--skip-parity` exists only for narrow development of the migration portion;
evidence from such a run records the explicit skip and is not rehearsal exit
evidence. The runner writes secret-free JSON under `.omo/evidence/issue-32/`.
It never reads a production endpoint, accepts an external database URL, scans
unreferenced assets, publishes an image, or changes infrastructure.

This synthetic run does not satisfy the production-backup rehearsal checkpoint.
That later operation still requires explicit owner approval, verified restorable
database and asset backups, an isolated restore, and separate evidence from the
real logical bundle.
