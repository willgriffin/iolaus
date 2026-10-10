# OAuth account linking

The application hosts the SDK authorization server at the configured HTTPS public origin under `/oauth`. SMRT stores client registrations, hashed one-use codes, session-bound consent grants, refresh families and revocations in the trusted application database. Apply the users OAuth migrations before enabling it.

Set `IOLAUS_MCP_LOCAL_OAUTH_ENABLED=true`, `IOLAUS_MCP_OAUTH_KEY_ID` and secret-injected `IOLAUS_MCP_OAUTH_PRIVATE_JWK` (private ES256 JWK with `kty=EC`, `crv=P-256`, `x`, `y`, `d`). `IOLAUS_PUBLIC_URL` must be the public HTTPS origin. Never commit the JWK, include it in a manifest, or log it. All replicas must share the same stable key and database. Startup validates signing configuration; invalid enabled configuration fails closed. For SQLite file deployments, OAuth storage owns a separate reconnectable database connection and reapplies foreign-key enforcement after poisoned-connection recovery. Injected opaque database instances fail closed when they cannot be reopened safely. The public `/oauth/jwks` response contains only public coordinates. Key replacement invalidates old access signatures; coordinate rotation with operators.

Discovery is `/.well-known/oauth-authorization-server/oauth` and `/.well-known/oauth-protected-resource/api/mcp`. The exact resource audience is `<origin>/api/mcp`. `/oauth/register` accepts public clients with HTTPS callbacks only. `/oauth/token` and `/oauth/revoke` delegate protocol processing to the SDK. No development HTTP callback exception is enabled by this application. External OIDC verification, native cookie sessions and opaque CLI bearer sessions retain separate verification paths. An explicit invalid credential is never treated as an anonymous public caller.

`/oauth/authorize` requires the current browser session and redirects through `/login?next=...` if absent. Existing signed-in and magic-link login use the validated same-origin `next` cookie; the original authorize query survives login. GET only displays the client identifier, registered callback and requested scopes. Consent POST requires the current session, exact Origin and a short-lived HttpOnly double-submit nonce. The selected scopes are intersected with the validated request and current permissions; SMRT rechecks the live session at approval and every token use. Denial issues no code.

Scopes are `opportunities:read`, `profile:read` and `applications:prepare`. Preparation grants inspect and prepare workflow permissions only. Read authority can resolve the dedicated human-review navigation URL; that resolution only inspects existing state. It does not authorize human approval or final submission. MCP checks the narrowed permission set before reentering the fresh owner context. Native live membership checks cannot expand a linked grant's permission ceiling. Public catalog tools remain an exact anonymous allowlist; generated CRUD and private resources require a principal.

The account menu links to `/account/connections`. It lists only the current user's grants and provides same-origin POST revocation. Foreign grant IDs return 404; revocation stops associated refresh families and makes live access-token checks fail. Consent, account pages and private authentication errors use `private, no-store`.

## Verification matrix

| Boundary | Current test |
| --- | --- |
| Native app factory → session consent → code/PKCE exchange → live narrowed token → foreign revoke denial → owned revoke/refresh denial on SQLite | `src/lib/server/local-oauth.integration.spec.ts` |
| Session login return, scope display, explicit selection/intersection, CSRF, foreign grant and revoke origin | `src/routes/oauth/authorize/oauth-consent.spec.ts` |
| Chromium rendering of consent controls, disabled scopes and owned revoke form, mobile viewport | `src/routes/oauth/authorize/oauth-ui.spec.ts` (real browser with SSR fixture; not an authenticated deployed flow) |
| Local JWT verification, exact resource, live grant rejection and permission re-intersection; external OIDC and opaque CLI compatibility | `src/routes/api/mcp/mcp-oauth-route.spec.ts` |
| Malformed/invalid explicit bearer and cookie precedence; private auth no-store | `src/hooks.server.spec.ts` |
| Public exact allowlist and private ownership/workflow fences | `src/lib/server/mcp-app-server.spec.ts` |
| External signature/audience/scope and live membership mapping | `src/lib/server/mcp-oauth.spec.ts`, `mcp-oauth-principal.spec.ts` |

Run the Chromium fixture explicitly after installing Playwright Chromium: `IOLAUS_OAUTH_BROWSER_TEST=1 pnpm --filter @willgriffin/iolaus-site exec vitest run src/routes/oauth/authorize/oauth-ui.spec.ts`. It is skipped in the ordinary unit suite.

Local command evidence is recorded under `/tmp/agent-first-release/app-evidence` for this release session. Protocol replay/refresh and SQLite/PostgreSQL persistence are upstream SDK/SMRT suites. Final closure installation, repository validation and migration checks remain release gates; the tests above must run against the installed coherent closure. Real ChatGPT connection/login/embedded-resource and human review acceptance remain pending an actual host run. Browser SSR fixtures do not establish those outcomes.
