# PostgreSQL deployment permissions

Iolaus can use SMRT's PostgreSQL permission contract after a deployment has
been qualified with distinct database identities. It is separate from Iolaus
application authorization, tenant permissions, and row-level security.

The contract is disabled for the local SQLite profile and for normal hosted
deployments. Enable it only in an approved offline migration operation by
setting `IOLAUS_POSTGRES_PERMISSION_CONTRACT=true`. The setting contains no
secret; database URLs and credentials stay in the existing scoped deployment
configuration.

## Required database identities

Infrastructure creates the roles and the dedicated database. SMRT does not
create roles, change passwords, alter memberships, or transfer ownership.

| Purpose | PostgreSQL role |
| --- | --- |
| Database | `DBiolaus_willgriffin` |
| Schema and migration owner | `iolaus_willgriffin_migration` |
| Application runtime | `iolaus_willgriffin_runtime` |
| Read-only monitor | `iolaus_willgriffin_monitor` |

The migration owner exclusively owns the `public` schema. The runtime role
receives application data access without schema or DDL authority. The monitor
can read only `_smrt_jobs(queue, status)` and
`source_crawls(status, started_at, finished_at)`.

Iolaus declares `_smrt_agent_schedules` as its application-managed table. SMRT
discovers the model tables from the generated site manifest and the framework
tables from the PostgreSQL catalog. The contract also declares the two
Iolaus-owned source-provenance trigger functions; SMRT verifies their supported
trigger shape and removes direct execution access from the restricted roles.
`data_repair_runs` and `data_repair_audit` are retained operator-owned audit
tables: the application migration creates them before reconciliation, and the
native plan revokes all runtime and monitor access. Two existing physical
collection-wrapper artifacts are retained for the same reason:
`fact_content_collections` and `asset_association_collections` are unused
physical artifacts of wrapper classes whose backing tables are respectively
`fact_contents` and `asset_associations`. They are not runtime backing tables,
so they receive no runtime or monitor privileges. Do not add manifest-only
`*_collections` names that are absent from the catalog:
the schema-exclusive contract deliberately rejects missing retained tables.

## Offline qualification

Use the exact released Iolaus image and released SMRT dependencies. The image
build generates the site SMRT manifest required by the framework CLI. Do not run
the permission commands from an unbuilt source checkout, because its application
model registry is not discoverable by the generic CLI.

Stop web, worker, and monitor database sessions before the entire sequence.
The normal self-hosted topology runs `db:migrate` in per-pod init containers,
including the recurring monitor job; it cannot remain enabled after restricted
roles are active. Use the separately approved private overlay's offline
migration/permission operation instead. The generic repository topology does
not enable this contract.

Run the application-specific migration entry point as the migration owner,
then use SMRT's supported permission commands from the built site directory:

```sh
pnpm --filter @willgriffin/iolaus-site db:migrate
pnpm --filter @willgriffin/iolaus-site exec smrt db:permissions --dry-run
pnpm --filter @willgriffin/iolaus-site exec smrt db:permissions --apply --expected-fingerprint <reviewed-fingerprint>
pnpm --filter @willgriffin/iolaus-site exec smrt db:validate
pnpm --filter @willgriffin/iolaus-site exec smrt doctor --db
```

Review the dry-run SQL, diagnostics, and fingerprint before applying. Applying
requires the exact reviewed fingerprint. `db:validate` and `doctor --db` are
read-only and never repair privileges. Any refusal requires its documented
infrastructure remediation, followed by a fresh plan; do not apply custom ACL
SQL or reactivate workload sessions until all checks pass.

## Verification matrix

| Behavior | Evidence |
| --- | --- |
| Local SQLite remains outside this contract | `pnpm --filter @willgriffin/iolaus-site exec vitest run scripts/postgres-permissions-config.spec.ts` covers the local profile and an unopted-in deployment. |
| The deployment declaration has the expected schema, roles, managed tables, trigger functions, and monitor columns | The same focused configuration spec asserts the complete contract object. |
| Framework command support is present | `pnpm --filter @willgriffin/iolaus-site exec smrt db:permissions --help`, `db:validate --help`, and `doctor --help` expose the native commands. |
| A qualified catalog converges without custom application ACL code | In a disposable PostgreSQL database only, run the offline sequence above, then repeat `db:permissions --dry-run`; it must report zero permission diagnostics and the same fingerprint. |
| Runtime and monitor access remain bounded | In that disposable database, verify runtime has no `CREATE` privilege on `public` or access to `data_repair_runs`/`data_repair_audit`/`fact_content_collections`/`asset_association_collections`, and verify the monitor has `SELECT` only for `_smrt_jobs(queue, status)` and `source_crawls(status, started_at, finished_at)`. |

`doctor --db` includes the permission diagnostic and a separate live-schema
parity diagnostic. Both must be clean before activating the restricted roles;
zero permission findings alone are not permission to cut over a deployment.

Run the same offline sequence after every schema migration or restore. Repeated
application against an unchanged qualified catalog is a no-op. Production
cutover remains governed by the separate deployment approval process.
