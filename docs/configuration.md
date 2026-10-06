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
# Set only to the exact immediate MCP Apps host origin for the interactive
# embedded workspace. It may be HTTPS, or loopback HTTP for local development.
IOLAUS_MCP_HOST_ORIGIN=https://trusted-host.example.com
# Optional OAuth 2.1 validation for non-browser MCP clients. Configure every
# value together; leave all unset to retain only the normal cookie/CLI session path.
IOLAUS_MCP_OAUTH_JWKS_URI=https://identity.example.com/realms/career/protocol/openid-connect/certs
IOLAUS_MCP_OAUTH_SCOPES=iolaus.mcp
IOLAUS_MCP_OAUTH_ALGORITHMS=RS256
# Use JWT only when the issuer documents that access-token type.
IOLAUS_MCP_OAUTH_TOKEN_TYPE=at+jwt
IOLAUS_OIDC_SERVER_URL=https://identity.example.com
# `realm` is the default OIDC issuer mode.
IOLAUS_OIDC_ISSUER_MODE=realm
IOLAUS_OIDC_REALM=career
IOLAUS_OIDC_CLIENT_ID=career-hub
# `private` is the backwards-compatible default. Set `shared` only when this
# is a public multi-user installation: each verified account receives a
# separate tenant and private workspace.
IOLAUS_WORKSPACE_MODE=private
IOLAUS_OIDC_ADMIN_EMAILS=owner@example.com,backup-admin@example.com
# Shared mode only: where an uninvited user is told to request an invite. An
# email address or an https URL; omit for generic "contact the operator" copy.
IOLAUS_INVITE_REQUEST_CONTACT=invites@example.com
# Shared mode only: public landing and legal links (https; support may be an
# email). Omit any to hide it.
IOLAUS_PUBLIC_LANDING_URL=https://www.example.com/
IOLAUS_TERMS_URL=https://www.example.com/terms
IOLAUS_PRIVACY_URL=https://www.example.com/privacy
IOLAUS_SUPPORT_URL=https://www.example.com/support
DATABASE_URL=postgresql://career_hub:private-password@localhost:5432/career_hub
```

### Shared-workspace invitations

A `shared` installation is invite-only. A verified OIDC identity is admitted
only while its normalized (trimmed, case-insensitive) email holds an active
invitation in the operator-managed `hosted_invites` table. The check runs at
login, before any user, tenant, or session is created, and again on every
protected request (browser, CLI bearer, MCP OAuth, and job-owner revalidation),
so revoking an invitation ends existing sessions at their next use. This is the
shared-mode counterpart of `IOLAUS_OIDC_ADMIN_EMAILS`, which still governs
`private` mode unchanged; `shared` mode no longer admits every verified email.

Manage invitations with the site package scripts (run after `db:migrate`, which
creates the table). Invites are stored, not deleted: `revoke` stamps the row and
`add` reinstates a revoked address.

```bash
pnpm --filter @willgriffin/iolaus-site invite:add -- friend@example.com
pnpm --filter @willgriffin/iolaus-site invite:revoke -- friend@example.com
pnpm --filter @willgriffin/iolaus-site invite:list
```

An uninvited or revoked account is sent to `/not-invited` ("You're not invited
yet"), a uniform page that does not disclose whether the address was ever
invited. It shows `IOLAUS_INVITE_REQUEST_CONTACT` (an email address, rendered as
a `mailto:` link, or an `https:` URL) as the place to request an invite. No
contact is built into the application. A fresh shared deployment starts with no
invitations, so invite the operator's own address before the first login. Existing
sessions for users who were never invited are rejected on their next request
once this version is deployed.

### Public landing and legal links

In `shared` mode the root route never renders an owner's resume. If
`IOLAUS_PUBLIC_LANDING_URL` is set (an `https:` URL) the root answers `302` to
it; otherwise it shows a neutral landing page titled with `IOLAUS_APP_NAME`
and a sign-in button (or "Open your workspace" when already signed in).
`IOLAUS_TERMS_URL`, `IOLAUS_PRIVACY_URL` and `IOLAUS_SUPPORT_URL` add Terms,
Privacy and Support links to the landing page, the login page, `/not-invited`
and the admin sidebar footer. Terms and privacy must be `https:` URLs; support
may also be an email address (rendered as `mailto:`). Unset or invalid values
are ignored and the link is hidden. Nothing product-specific is built in. These
variables have no effect in private or local mode, where the root continues to
render the published resume.

Use a dedicated PostgreSQL user and database name for every public deployment.
The legacy/default `iolaus` and `iolaus_dev` database names are refused so a
new installation cannot silently attach to predecessor or example data.

### MCP Apps

The portable package lives in `mcp-apps/` and connects through the authenticated
Streamable HTTP endpoint at `/api/mcp`. Set `IOLAUS_MCP_HOST_ORIGIN` only to the
known, exact origin of the immediate embedding MCP Apps host. The embedded
workspace refuses to negotiate with an unspecified, wildcard, opaque, or
untrusted origin; when that setting is absent it leaves structured MCP results
available and tells the user to use Iolaus's authenticated review page.

For local development, `mcp-apps/mcp.json` uses the loopback endpoint. Copy the
package for a hosted deployment and replace only its URL with that deployment's
HTTPS `/api/mcp` endpoint. Do not put users, tenants, profile identifiers, or
credentials in the manifest. The server resolves the verified session and
workspace on every tool and resource request.

For an independent private installation, retain `IOLAUS_WORKSPACE_MODE=private`:
the configured administrative membership remains the workspace authority. For
the public shared-hosted app, set `IOLAUS_WORKSPACE_MODE=shared` and provision
each account into its own active tenant, membership, role, and server-verified
candidate profile. The same package URL is used in both modes; it never carries
or selects another account's tenant, profile, records, or credentials.

When an OpenAI-hosted MCP client needs account access, configure the optional
OAuth values together. Iolaus then publishes RFC 9728 protected-resource
metadata at `/.well-known/oauth-protected-resource/api/mcp` and validates a
signed, audience-bound access token against the configured JWKS. A token is
mapped only through an existing Iolaus OIDC identity and one live active
membership; it cannot select a user, tenant, or candidate profile. Cookie and
terminal CLI sessions keep their existing authentication path.

Private developer-mode host testing may use a Secure MCP Tunnel that forwards
only `/api/mcp`. It remains pending until the operator has the required tunnel
control-plane key, workspace association, and host login; the local HTTP and
simulated-DOM checks do not establish ChatGPT-host acceptance. This work does
not publish a directory listing or deploy a public endpoint.

`IOLAUS_OIDC_CLIENT_SECRET` is optional for a public OIDC client. When your
provider issues a confidential client, set it only in the deployment secret
store. Iolaus rejects incomplete or malformed public authentication with a
generic recovery message; it never falls back to local sign-in on a hosted
deployment and never includes hostnames, emails, or secret values in that
message.

For an identity provider whose discovery issuer is exactly its HTTPS origin,
set `IOLAUS_OIDC_ISSUER_MODE=root`, keep `IOLAUS_OIDC_SERVER_URL` to that
origin, and leave `IOLAUS_OIDC_REALM` unset. Iolaus uses the released
Keycloak client's root adapter internally, then requires discovery's `issuer`
to exactly equal the configured origin before starting a login or accepting a
token. Root mode refuses paths, queries, fragments, encoded traversal, an
unknown mode, and any realm value. Do not configure `..` as a realm.

The self-hosted runtime ships bounded readiness callbacks for its standard
providers: Keycloak discovery for OIDC, an authenticated read-only S3
`HeadBucket` for `RESUME_FILES_CONFIG_JSON`, and deployment environment shape
for secrets. `RESUME_FILES_CONFIG_JSON` must be a protected `s3` configuration
with region, bucket, endpoint, access key, secret key, and any required
path-style setting. An `SMRT_AUTH_READINESS_MODULE`,
`SMRT_ASSETS_READINESS_MODULE`, or `SMRT_SECRETS_READINESS_MODULE` is optional
and replaces only the matching shipped callback.

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
empty binding list leaves normal first OIDC login to SMRT's verified-email and
existing-identity path. An unmatched binding also leaves that secure default in
place; a matching binding that is unverified, ambiguous, or cannot prove the
declared owner fails closed. Do not commit or log this mapping. Preserve the
provider's issuer and subject when changing the redirect URI or client so
existing links remain stable.

After importing a restored logical backup and before enabling public traffic,
run the normal application database migration once more. It is idempotent and
prepares the indexed profile/user email keys required by the OIDC rebinding
path. Record only its aggregate success in the cutover evidence; do not copy
identity rows or sensitive values into a ticket, log, or repository.

Every private administrative request requires an active user, tenant,
membership, role, and resolved permissions. `IOLAUS_WORKSPACE_MODE=private`
also requires the user's email to still match `IOLAUS_OIDC_ADMIN_EMAILS`, so
removing an address from that allowlist revokes existing browser and CLI
sessions at their next protected request. `shared` accepts verified OIDC
identities holding an active operator invitation (see Shared-workspace
invitations) and creates a separate tenant per user; it must not be enabled for
an operator's existing single-workspace installation.

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

## Hosted AI usage: per-user caps and kill switch

A hosted `shared` deployment can pay for AI while capping each user. These
controls sit in front of every model call; shared-catalog crawl and source
intelligence stay platform costs under their existing
`OPPORTUNITY_INTELLIGENCE_*_LIMIT` ceilings and are never billed to a user.

```sh
# Refuse every model call (any workspace mode). Anything except an explicit
# false/0/no/off engages it, so a typo fails closed.
IOLAUS_AI_DISABLED=false
# Per-user caps in micro-dollars (1000000 = $1). 0 (default) means no cap.
IOLAUS_AI_USER_LIFETIME_CAP_MICROS=0
IOLAUS_AI_USER_MONTHLY_CAP_MICROS=0
# Explicit prices for the cover-letter writing model (see below).
IOLAUS_AI_WRITING_INPUT_COST_MICROS_PER_MILLION=
IOLAUS_AI_WRITING_OUTPUT_COST_MICROS_PER_MILLION=
```

- **Who is billed.** Spend is attributed to the verified tenant and owner user.
  Candidate-owned calls are billed: the admin assistant, screening and
  job-evaluation assessments, resume-fit review, strength verification,
  question screening, skill discovery and cover-letter generation. Calls with
  no workspace subject (crawl, source extraction, source coverage) are not.
- **Enforcement.** Before each provider call the worst-case cost is reserved
  atomically against the user's ledger (`ai_user_spend_entries`) under a
  per-user lock (a PostgreSQL advisory lock, or the keyed file lock on
  SQLite), then settled to the actual cost, or released when no provider call
  was made (cached result, block or refusal). Concurrent requests cannot jointly
  exceed a cap. A call that fails after reaching the provider keeps its full
  reservation. If the ledger cannot be reached the call is refused.
- **Refusal.** A spent budget returns a clear message (HTTP 429 for requests)
  and no provider call is made. The kill switch returns HTTP 503. Background
  jobs fail with the same message. Raising the cap or the next calendar month
  (UTC) restores service; the kill switch needs no operator reset.
- **Modes.** `shared` mode always records usage so a cap set later sees
  history. `private` installs record and enforce nothing unless a cap variable
  is set explicitly. The indicator in the admin header ("$X AI budget left")
  appears only when a cap applies.
- **Pricing.** Governed assessment calls use the existing pinned model prices.
  Cover-letter writing and application planning have no pinned price:
  once a deployment-wide cap is set, set the two `IOLAUS_AI_WRITING_*` prices
  or those calls are refused rather than spending unmetered. With no cap set
  they run unmetered, and a per-user override only applies to priced calls. The assistant keeps its own per-session and per-turn
  limits in addition to the per-user cap.

Inspect or adjust a user from the operator shell (user is `--tenant-id` plus
`--user-id`, or `--email`):

```sh
pnpm --filter @willgriffin/iolaus-site ai:budget status
pnpm --filter @willgriffin/iolaus-site ai:budget status --email user@example.com
pnpm --filter @willgriffin/iolaus-site ai:budget set --email user@example.com --lifetime 5000000 --monthly 2000000
pnpm --filter @willgriffin/iolaus-site ai:budget set --email user@example.com --monthly default   # inherit the env default
pnpm --filter @willgriffin/iolaus-site ai:budget adjust --email user@example.com --micros -1000000 --note "goodwill credit"
pnpm --filter @willgriffin/iolaus-site ai:budget release-stale --email user@example.com --minutes 30
```

`set` overrides a user's caps (`none` removes a cap for that user, `default`
inherits the environment). `adjust` credits or debits recorded usage.
`release-stale` returns reservations stranded by a crashed process. Run
`pnpm --filter @willgriffin/iolaus-site db:migrate` after upgrading to create
the `ai_user_spend_entries` and `ai_user_budgets` tables.
