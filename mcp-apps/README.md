# Iolaus MCP App package

This is the portable package for Iolaus's Streamable HTTP MCP endpoint. It is
configured for a local development server at `http://127.0.0.1:5173/api/mcp`.

For a private self-hosted installation or a shared hosted deployment, copy the
package and set `mcp.json` to the deployment's HTTPS `/api/mcp` URL. The server
binds the verified session and workspace on each request; do not add a user,
tenant, profile, or credential to the manifest.

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

For an account-bound remote host, configure Iolaus's optional OAuth MCP
settings on the deployment. The authenticated endpoint then advertises RFC 9728
protected-resource metadata and maps a validated token only to an existing,
active Iolaus workspace. Browser cookies and terminal CLI Bearers remain
separate compatibility paths.

The app can browse and inspect the authenticated workspace, and create or reopen
a local application workspace. Its human-review link opens Iolaus's dedicated
review page; it never approves or submits an application.
