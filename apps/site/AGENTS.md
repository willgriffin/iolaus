# @willgriffin/iolaus-site Agent Guide

Follow the repository-level `AGENTS.md` first. This SvelteKit package serves
the public site, administrative UI, and SMRT-backed application workflows.

Keep request-scoped SMRT database and tenant context intact. For read-heavy SSR
paths, preserve cache isolation and use upstream SMRT primitives rather than
application-owned query or pooling substitutes.

Agent-driven mutations (WebMCP `/api/job-search/*`, server-MCP `tools/call`,
the DataSurface bulk actions at
`/api/admin/opportunities/bulk-actions/{preview,apply}`, and the
agent-drivable admin form actions) run only with a verified workspace subject
from `src/lib/server/workspace-subject.ts`. Re-enter the native
`executeAsPrincipal` context at an external-write fence so its fresh role and
permission resolution sees revocation. Assert curated workflow capabilities
through `workspaceWorkflowOperation()` from
`src/lib/server/workspace-workflow-capabilities.ts`, then enforce every target
record's `{ tenantId, userId, profileId }` ownership tuple. Do not recreate
generic private CRUD grants, infer authority from form profile IDs, or use the
former single-owner `AgentRun` read surrogate. `allowedTools` is derived from
`src/lib/server/tool-catalog.ts`, never hand-listed.

Bulk workflows over a list belong on the DataSurface action adapter, not on a
new form action: a bulk mutation must preview before it applies, re-resolve
"all matching" from the server's own query rather than from browser-supplied
ids, bound the selection, pin each write to the revision it resolved, and
report per-row outcomes. See `docs/webmcp-audit.md` for the full bounds. The
durable confirmation and idempotency state is local only until
happyvertical/smrt#2597 ships the upstream store; keep
`src/lib/server/data-surface-action-state-store.ts` shaped to the
`@happyvertical/smrt-agents/server` interface so it can be deleted then. That
store's atomicity is raw SQL, so its unit spec runs against a stand-in and
cannot see the schema; run `pnpm --filter @willgriffin/iolaus-site
test:data-surface-store:db` against a migrated local database after changing
any of its statements.

Run the narrowest relevant package check before broader repository validation.
For database-sensitive changes, run this package's `db:migrate` and `db:status`
scripts as required by the repository guide.
