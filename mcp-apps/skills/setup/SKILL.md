# Iolaus setup

The bundled endpoint is the public Iolaus catalog at
`https://jobgeni.us/api/mcp`. It supports anonymous opportunity discovery and
asks the host to link an account before a tool needs private workspace data.

For local development, copy this package and change only `mcp.json` to
`http://127.0.0.1:5173/api/mcp`. For a self-hosted Iolaus service, instead use
that deployment's HTTPS `/api/mcp` URL. Do not put credentials in this package.

Private installs use their configured administrative workspace. Shared hosted
deployments require the signed-in account's active tenant membership, role, and
server-verified profile; this package cannot select or access another account's
workspace.

Open the opportunity board to browse the signed-in workspace. Inspect an
opportunity before preparing its application workspace. Final approval and
submission are available only on Iolaus's dedicated authenticated review page.

Secure MCP Tunnel testing is an operator-controlled developer-mode step. It is
pending until its control-plane key, workspace association, and host login are
available; no directory publication or production deployment is part of this
package setup.
