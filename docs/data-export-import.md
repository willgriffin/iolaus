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
asset-migration phase. This logical importer preserves the database records but
does not copy asset bytes. Expanded relationship repair and rejected-record
reporting likewise run through the reconciliation phase; this importer fails
closed rather than dropping an incompatible row.

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
and belongs solely in the scoped deployment secret. The importer verifies every
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
