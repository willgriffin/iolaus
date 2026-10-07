# Iolaus MCP App package

This is the portable package for Iolaus's public Streamable HTTP MCP endpoint
at `https://jobgeni.us/api/mcp`. Anonymous clients can search the shared
opportunity catalog; account-linked tools always require an Iolaus grant.

For local development, copy the package and replace the endpoint with
`http://127.0.0.1:5173/api/mcp`. For a private self-hosted installation, copy
the package and use that deployment's HTTPS `/api/mcp` URL. Do not add a user,
tenant, profile, or credential to a manifest: the server binds the verified
session and workspace on each request.

Private installs retain their configured administrative workspace boundary.
Shared hosted deployments use `IOLAUS_WORKSPACE_MODE=shared`: each account
must already have an active tenant membership, role, and server-verified
profile, and every workflow is bound to that tuple. Installing this package
does not grant a shared member access to another member's workspace.

Set `IOLAUS_MCP_HOST_ORIGIN` on the deployment to the exact, trusted immediate
MCP Apps host origin before interactive controls are enabled. Without it, the
resource deliberately leaves the normal structured-result and authenticated
review-page fallback available.

Follow OpenAI's [plugin connection and testing guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
to install the package in developer mode and test the endpoint. A public tunnel,
ChatGPT-host acceptance, and directory submission are intentionally outside this
local development package. A private developer-mode acceptance run may instead
use OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
to forward only this MCP endpoint; it needs a separately configured tunnel,
runtime control-plane key, workspace association, and supported user
authentication. This package never stores those values.
Host acceptance remains pending until an operator can complete that controlled
tunnel and login flow; the package's HTTP and simulated-DOM checks are not a
claim of external-host acceptance.

For an account-bound remote host, configure Iolaus's OAuth authorization
service on the deployment. The authenticated endpoint advertises protected
resource metadata and maps a validated grant only to an existing, active
Iolaus workspace. Browser cookies and terminal CLI Bearers remain separate
compatibility paths.

The app can browse and inspect the authenticated workspace, and create or reopen
a local application workspace. Its human-review link opens Iolaus's dedicated
review page; it never approves or submits an application.
