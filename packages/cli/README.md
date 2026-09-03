# @willgriffin/iolaus-cli

Authenticated CLI and MCP bridge for the iolaus.localhost SMRT app.

## Local Checkout

These examples run package scripts from the monorepo. `data` is the pnpm script
name for the data CLI entrypoint; installed users run `iolaus` directly.

```bash
pnpm --filter @willgriffin/iolaus-cli data auth login --server http://localhost:5173
pnpm --filter @willgriffin/iolaus-cli data opportunities list
pnpm --filter @willgriffin/iolaus-cli smoke
pnpm --filter @willgriffin/iolaus-cli mcp
```

## Bounded provider and crawl reads

The authenticated CLI exposes the same two bounded operational reads as the
app's job-search WebMCP surface. They are available through the generated MCP
bridge; neither command activates sources nor queues crawls.

```bash
pnpm --filter @willgriffin/iolaus-cli data mcp tools
pnpm --filter @willgriffin/iolaus-cli data mcp call job_search_list_source_health '{"query":"greenhouse","limit":25,"historyLimit":20}'
pnpm --filter @willgriffin/iolaus-cli data mcp call job_search_source_crawl_status '{"sourceId":"11111111-1111-4111-8111-111111111111","limit":20}'
```

`job_search_list_source_health` caps results at 25 sources/providers and
terminal history at 20 crawls per source. `job_search_source_crawl_status`
requires `crawlId` or `sourceId`, caps returned crawls at 20, and returns at
most five sanitized error samples per crawl. Both require the caller's normal
`sources.read` and `sourcecrawls.read` permissions in the active tenant.

Example source-crawl status text content:

```json
{
  "items": [
    {
      "id": "crawl-1",
      "sourceId": "source-1",
      "status": "completed_with_errors",
      "counts": { "candidates": 12, "created": 3, "errors": 1 },
      "errors": ["authorization=[redacted]"]
    }
  ],
  "limit": 20
}
```

## Packaged Install

```bash
pnpm --filter @willgriffin/iolaus-cli build
pnpm --filter @willgriffin/iolaus-cli pack
pnpm add -g ./packages/cli/iolaus-cli-0.0.0.tgz
iolaus auth login --server https://your-app-host
iolaus opportunities list
iolaus-mcp
```

The CLI stores its bearer session in `~/.config/iolaus.localhost/config.json`.
Agents can override configuration with `IOLAUS_SERVER_URL`,
`IOLAUS_TOKEN`, or `IOLAUS_CLI_CONFIG`.

`pnpm --filter @willgriffin/iolaus-cli smoke` runs a deterministic contract check
against a fake local SMRT API. It verifies auth status, resource discovery,
list/get/create/update/delete for `PreferenceRule`, and MCP tool list/call
wiring through the same CLI entrypoint agents use. To run it against a live app,
load `IOLAUS_TOKEN` from an approved local secret source and pass only the
server URL:

```bash
pnpm --filter @willgriffin/iolaus-cli smoke -- --server http://localhost:5173
```

## Agent Payload Shape

The app normalizes agent-written list fields and JSON-string fields on admin,
REST, and MCP writes. List fields use newline-delimited storage, but CLI/API/MCP
callers may send arrays. JSON-string fields use canonical JSON text, but callers
may send JSON objects or arrays.

Example payloads:

```json
{
  "title": "Platform Engineer",
  "requiredSkills": ["TypeScript", "Svelte"],
  "domainTags": ["developer tooling", "platform"],
  "sourceId": "source-smrt-careers"
}
```

```json
{
  "name": "Compensation floor",
  "ruleJson": {
    "annualConsiderMin": 130000,
    "currency": "USD"
  }
}
```

The full contract is documented in
[`docs/employment-workflows.md`](../../docs/employment-workflows.md).

## Resource Exposure

Which classes and actions the REST API (`/api/[resource]`), the CLI resource
discovery (`/api/_resources`), and the server MCP bridge (`/api/mcp`) expose is
driven entirely by each class's `@smrt({ api, cli, mcp })` includes in
`apps/site/src/lib/objects`. A class with `api: { include: [] }` is reachable
on no surface; a class that lists an action on `api` and `mcp` is reachable on
REST, the CLI, and MCP with the same action set. REST accepts both the CLI's
canonical slug (`resumeprofiles`, `agentruns`) and the snake_case table name
(`resume_profiles`, `agent_runs`); generated MCP tools are named
`<classname>_<action>` (`resumeprofile_list`). Actions a decorator leaves out
return `405` on REST and are absent from the CLI and MCP catalogs.

## Resume Variants

Agents create, update, and read tailored resume workflow records through the
discovered `resumevariants` resource:

```bash
pnpm --filter @willgriffin/iolaus-cli data resumevariants list
pnpm --filter @willgriffin/iolaus-cli data resumevariants create '{"opportunityId":"opp-123","companyId":"company-123","name":"Example variant","emphasizeTags":["agentic","platform"],"includePositionIds":["anytown","happy-vertical"]}'
```

The MCP bridge exposes the same record as `resumevariant_list`,
`resumevariant_get`, `resumevariant_create`, and `resumevariant_update`.
Generated variants remain preparation artifacts; application submission still
requires explicit Will approval on the `Application`.
