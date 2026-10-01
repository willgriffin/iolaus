# Daily-use local development

This workflow runs editable Iolaus source with a durable, local PostgreSQL and
S3-compatible asset store. The application listens only on `127.0.0.1`; a
separate operator-owned Tailscale HTTPS proxy may publish that loopback port.

Keep the private environment file outside Git at
`/Users/will/Work/willgriffin/local-ops/iolaus/daily.env` with mode `600`.
Required values are `SMRT_RUNTIME_PROFILE=self-hosted`, `SMRT_APP_ID`,
`IOLAUS_PUBLIC_URL`, `DATABASE_URL`, `RESUME_FILES_CONFIG_JSON`,
`IOLAUS_OIDC_SERVER_URL`, `IOLAUS_OIDC_CLIENT_ID`,
`IOLAUS_OIDC_ADMIN_EMAILS`, `IOLAUS_POSTGRES_DATABASE`,
`IOLAUS_POSTGRES_USER`, `IOLAUS_POSTGRES_PASSWORD`,
`IOLAUS_MINIO_ROOT_USER`, and `IOLAUS_MINIO_ROOT_PASSWORD`.

`SMRT_APP_ID` must equal the `application` field in the supported export bundle
that will be imported. Do not choose a new app ID and then import production
data: the importer rejects that mismatch to protect tenant identity. Its
PostgreSQL database must use the corresponding underscore namespace:
`iolaus_willgriffin` or `iolaus_willgriffin_<operator-suffix>`; this daily
instance uses `iolaus_willgriffin_daily`. Use the canonical target URL
`https://mac.tail8e7e73.ts.net:8443` and register its
callback `https://mac.tail8e7e73.ts.net:8443/auth/oidc/callback` before remote
login. The root operator owns that callback and proxy configuration.

For daily use, start durable dependencies with `pnpm daily:up`, apply
migrations with `pnpm daily:migrate`, run `pnpm daily:doctor`, then use the
managed server lifecycle:

```sh
pnpm daily:start
pnpm daily:status
pnpm daily:stop
pnpm daily:backup
```

`daily:start` is idempotent and waits for loopback health. `daily:status` and
`daily:stop` operate only on the recorded process with its original start time
and configuration fingerprint; they refuse a mismatched record instead of
stopping another process. `daily:backup` writes a timestamped PostgreSQL dump
and S3 object snapshot under the private backup root. Restore only into an
isolated PostgreSQL target, restore the matching object snapshot, verify counts
and hashes, then make an explicit cutover decision. `pnpm daily:down` stops
containers without deleting named volumes. Use `pnpm daily:dev` only for a
foreground edit session, not as the daily-use service contract.

The launcher starts no background jobs. Keep them disabled until provider
limits and human approval settings have been reviewed. The service runs while
this Mac is awake and logged in; after a reboot or sleep, resume it with
`pnpm daily:up` and `pnpm daily:start` after checking `pnpm daily:status`.

Keep end-to-end QA isolated from the daily database, private state directory,
and MinIO bucket. `pnpm test:e2e` creates its own synthetic local fixture; it
must never use the daily environment file or mutate restored job-search data.

To restore a completed backup, create an isolated PostgreSQL database and
empty isolated asset bucket first. Load `database.sql` with that target's
`psql`, sync `assets/` into the isolated bucket using its private S3
credentials, and compare database/object counts and hashes with
`complete.json` and the source receipt. Do not restore directly into the
daily-use database or bucket.

`pnpm daily:start` derives Vite's only additional allowed host from
`IOLAUS_PUBLIC_URL`; it does not allow arbitrary proxy host headers. It keeps
the Vite backend on loopback while admitting the canonical Tailscale hostname.

The supported logical portability command currently carries filesystem assets
only. Do not use `pnpm app:export` for an S3-backed source. A one-time S3 to
S3 handover needs a separately reviewed read-only database dump, object mirror,
and hash/count verification receipt before the canonical target is started.
