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
data: the importer rejects that mismatch to protect tenant identity. Use the
canonical target URL `https://mac.tail8e7e73.ts.net:8443` and register its
callback `https://mac.tail8e7e73.ts.net:8443/auth/oidc/callback` before remote
login. The root operator owns that callback and proxy configuration.

Start durable dependencies with `pnpm daily:up`, apply migrations with
`pnpm daily:migrate`, then start the editable server with `pnpm daily:dev`.
Run `pnpm daily:doctor` before use. `pnpm daily:down` stops containers without
deleting named volumes. Keep background jobs disabled until provider limits and
human approval settings have been reviewed.
