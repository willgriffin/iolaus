# Iolaus configuration

Iolaus keeps personal records, assets, credentials, and deployment values out
of source control. Copy `.env.example` to a private environment file or use
your platform's secret manager; never commit it.

## Local installation

The default profile is deliberately local and loopback-only:

```sh
SMRT_RUNTIME_PROFILE=local
SMRT_APP_ID=iolaus
IOLAUS_APP_NAME=Iolaus
```

Local Iolaus does not need an OIDC provider. Browser sign-in is available only
from `localhost`, `127.0.0.1`, or `::1`; a remote host cannot turn the local
owner path into a public login endpoint.

Do not place a reverse proxy, tunnel, or public ingress in front of the local
profile. Local owner sign-in rejects forwarded requests, and a proxy that hides
its forwarding metadata cannot safely provide public authentication. Use the
`self-hosted` or `cloud` profile with OIDC for any remotely reachable install.

`SMRT_APP_ID` is a lowercase, hyphenated identifier. It namespaces the local
tenant, cookies, terminal authorization code prefix, audit agent class, and
CLI configuration directory. The `iolaus` default is reserved for the local
profile; every public deployment must choose a unique non-default identifier.

## Public installation

Set `SMRT_RUNTIME_PROFILE=self-hosted` (or `cloud` for a managed deployment)
and provide every non-secret setting below through private configuration:

```sh
SMRT_RUNTIME_PROFILE=self-hosted
SMRT_APP_ID=career-hub
IOLAUS_APP_NAME="My Career Hub"
IOLAUS_PUBLIC_URL=https://jobs.example.com
IOLAUS_OIDC_SERVER_URL=https://identity.example.com
IOLAUS_OIDC_REALM=career
IOLAUS_OIDC_CLIENT_ID=career-hub
IOLAUS_OIDC_ADMIN_EMAILS=owner@example.com,backup-admin@example.com
DATABASE_URL=postgresql://career_hub:private-password@localhost:5432/career_hub
```

Use a dedicated PostgreSQL user and database name for every public deployment.
The legacy/default `iolaus` and `iolaus_dev` database names are refused so a
new installation cannot silently attach to predecessor or example data.

`IOLAUS_OIDC_CLIENT_SECRET` is optional for a public OIDC client. When your
provider issues a confidential client, set it only in the deployment secret
store. Iolaus rejects incomplete or malformed public authentication with a
generic recovery message; it never falls back to local sign-in on a hosted
deployment and never includes hostnames, emails, or secret values in that
message.

### OIDC cutover and identity rebinding

Before the first self-hosted sign-in, an operator must register the target
redirect URI with the existing identity provider:

```text
https://<the configured IOLAUS_PUBLIC_URL host>/auth/oidc/callback
```

Keep the predecessor callback registered until rollback is retired. Do not
copy its browser cookies, terminal/CLI bearer tokens, client secret, or any
other credential into Iolaus. Create the target client configuration in the
provider's protected control plane and supply only its non-secret client ID in
the deployment configuration.

Iolaus binds an operator by the OIDC issuer and subject first. For the first
binding of an imported, already-owned user, place an exact
issuer/subject/user-ID entry in the protected
`IOLAUS_OIDC_IMPORTED_OWNER_BINDINGS` JSON deployment setting. It is a
one-to-one migration approval, not an email allowlist; the verified canonical
email is only an additional consistency check. The released s-m-r-t
transaction verifies the declared user and canonical Profile atomically. An
unknown, duplicate, unverified, ambiguous, or pre-owned identity fails closed.
Do not commit or log this mapping. Preserve the provider's issuer and subject
when changing the redirect URI or client so existing links remain stable.

After importing a restored logical backup and before enabling public traffic,
run the normal application database migration once more. It is idempotent and
prepares the indexed profile/user email keys required by the OIDC rebinding
path. Record only its aggregate success in the cutover evidence; do not copy
identity rows or sensitive values into a ticket, log, or repository.

Every private administrative request requires an active user, tenant,
membership, role, and resolved permissions. In a hosted profile the user's
email must also still match `IOLAUS_OIDC_ADMIN_EMAILS`, so removing an address
from that allowlist revokes existing browser and CLI sessions at their next
protected request.

Before a production cutover, the identity-provider operator must complete one
synthetic-account authorization-code login against the isolated rehearsal
deployment. Verify that it reaches `/admin`, that a non-allowlisted synthetic
account cannot reach a private UI, REST, MCP, WebMCP, or resume-asset route,
and that the real provider still accepts the configured callback. Record only
pass/fail and aggregate request identifiers. This operator checkpoint cannot
be replaced by a local fake provider and must not put client credentials,
tokens, or candidate data in the evidence.

The CLI stores its token separately for each target server at
`~/.config/<SMRT_APP_ID>-<server-fingerprint>/config.json`. This prevents a
local instance on one port from reusing a token for another one. Do not copy
that file, application data, or generated resumes into the source checkout.

Earlier development snapshots used `~/.config/iolaus.localhost/`. Those
credentials are deliberately not reused: authenticate the CLI again after
upgrading so a generic Iolaus installation cannot inherit an old local token.
Legacy database backups remain restorable when explicitly selected, but new
backups live under the generic application identifier; set `IOLAUS_BACKUP_DIR`
to the former backup directory when recovering an earlier snapshot.
