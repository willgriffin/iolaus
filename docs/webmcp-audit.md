# WebMCP Discovery Audit

This is the M1 registration and safety baseline for the private job-seeker
command center. It covers the generated read surface from M0 and fifteen
bounded, task-oriented job-search operations, including the preflight,
application-review, and resume reads added for the epic's agent workflow
(#413, #414, #415) and the triage candidate read and dig-deeper mutation added
with the one-at-a-time triage view (#425).

## Registered surface

The root SvelteKit layout gives the SMRT `Provider` the generated
`webMcpToolDefinitions` only on `/admin` and its descendants. The Provider
feature-detects `document.modelContext`, so SSR and ordinary browsers receive
no browser-native registration.

The generated definitions come from model `api` decorator metadata, not from
the application's CLI or server-MCP configuration. The command center selects
only read operations from `opportunities`. Generic `applications` and `tasks`
reads are deliberately excluded because their records can contain ATS answers,
approval data, login identity notes, arbitrary task descriptions, and artifact
references. No generic create, update, or delete operation is registered.

The private candidate data model is likewise never a WebMCP surface. The
`CandidateProfile` contact facts (email, phone, location, work-authorization
preference, canonical LinkedIn/GitHub URLs) and the reusable `CandidateAnswer`
answer library are excluded from the command-center policy, and no
`job_search_*` read returns candidate profile or reusable-answer data. These
records move only through the authenticated application workflow and its own
audited writers.

That exclusion is about *contact facts and stored ATS answers*, not about
resume content. The resume — summary, skill groups, experience with projects
and bullets, other experience, education — is already published at the site
root and as a public download, so `job_search_read_resume` returns it (as the
tailoring pipeline structures it) at no confidentiality cost. The read still
strips the profile record down to name, title, and summary; profile links
(`CandidateProfileLink` records, which the exclusion above covers as canonical
profile URLs), email, phone, location, work-authorization preference,
attachment file paths, and the answer library never appear. Likewise
`job_search_inspect_application` returns the answers *already committed to that
application's packet* (they are part of the reviewable material), but never the
reusable library those answers may have been seeded from, and never the
employer-account login identity, account notes, or Warden reference.

Exposure tiers, for clarity: (1) the browser WebMCP surface registers no
candidate profile or answer tools at all; (2) the generic `/api` CRUD routes
and generated server MCP remain owner-authenticated administrative surfaces —
`CandidateProfile` editing (now including phone and contact facts) stays
available there deliberately, while `CandidateAnswer` is registered on neither
(`api`/`cli`/`mcp` decorators are all empty), so the reusable answer library
has no generic CRUD surface anywhere; (3) the application review UI reaches
the library only through server-side workflow writers.

Fifteen application-owned definitions provide the curated workflow surface:

- `job_search_browse_opportunities` searches and filters up to 25 local results.
  Its results and totals exclude `archived` rows unless the `status` filter names
  them, which its published description and `status` property say so an agent
  reading only the tool inventory cannot mistake a default total for the table.
- `job_search_next_triage_candidate` returns the single highest-scoring
  undecided opportunity for one-at-a-time triage, with its queue position, the
  number remaining, and the offset it was served at. It runs the same filter
  model as the browse read under the triage preset — undecided only, archived
  excluded, expired and no-longer-seen postings dropped, and ordered by its
  `sort` argument, the same two orderings the deck offers (`score`, the default,
  or `newest`) — so
  the agent queue and the admin triage deck (a modal over
  `/admin/opportunities`; `?triage=1` opens it, and `/admin/opportunities/triage`
  redirects there) cannot diverge. It
  is read-only: an agent records the verdict with `job_search_record_decision`
  and passes on a candidate by asking again with a higher `offset`, because
  there is no server-side skip list to hold a session in. An offset at or past
  the end of the queue returns a null candidate rather than the last one again,
  so a pass-loop always terminates.
- `job_search_dig_deeper` is the agent counterpart of the triage right swipe: it
  records the `maybe` verdict through the same review writer the admin surfaces
  use and queues the deep dive — the opportunity intelligence job, one bounded
  posting preflight, and the company's `research_company` task. It is declared
  **not idempotent**, because each call records another review write — and, when
  no recent verdict stands, another live posting check — even though the queued
  job and the research task are themselves deduplicated, and **open-world**,
  because the posting check fetches the employer's posting URL. That check is
  throttled: a recorded verdict younger than 15 minutes is reused and nothing is
  fetched, so a fast triage run over several roles at one employer cannot hammer
  that host. The step reports `recent` rather than `queued` when it does. It never starts, prepares, or submits an
  application: the verdict it can record is `maybe` and nothing else, so an agent
  cannot reach an apply through it. The verdict is written before any queue step
  runs, and a step that fails comes back in `steps`/`failed` rather than
  unwinding the decision — an agent that sees a failure should report it, not
  re-decide the opportunity.
- `job_search_inspect_opportunity` returns curated decision context for one
  local opportunity, including the recorded posting-preflight verdict
  (`preflight.state` is one of `never_preflighted`, `live`, `closed`,
  `inconclusive`), its timestamp, reason, bounded evidence (final URL,
  provider, HTTP status, redirect flag, excerpt capped at 240 characters), and
  the `AgentRun` evidence reference. The override audit is never consulted.
- `job_search_verify_posting` runs one posting preflight for one opportunity
  through the existing `recordPostingPreflight` server function and returns the
  new verdict in the same shape. It fetches only the known-ATS posting URL
  without credentials (bounded body, redirects, and timeout as in #317), writes
  one `posting_preflight` audit, and never archives the opportunity, accepts an
  override reason, or touches an application; lifecycle transitions still run
  their own gate.
- `job_search_inspect_application` returns read-only review context for one
  application: the four-material inventory (packet, resume, cover letter,
  answers) with availability and fingerprint-matched review state, at most 25
  unresolved review comments (bodies capped at 1,000 characters), at most 60
  committed per-question answers (1,000 characters each), at most 20 active
  tasks, at most 40 blocking items with human-readable reasons, an `awaiting`
  sentence for `awaiting_user` applications, approval scope/notes/timestamps
  plus the final-approval marker and whether its material snapshot is still
  current, and submission evidence when present. Material bodies are not
  returned. Approval cannot be recorded through this tool.
- `job_search_read_resume` returns the tailored resume structure: profile
  name/title/summary (profile links are excluded), at most 20 skill groups of 60
  skills, at most 30 positions with 20 projects, 20 achievements, and 20 duties
  each, 30 other roles, and 20 education entries, with per-field character
  caps. An optional `tailoring` slug selects one stored active
  `ResumeTailoringConfig`; the canonical config is applied otherwise, and the
  response lists at most 25 available slugs. An optional `profileKey` (at most
  120 characters) selects one `CandidateProfile` by key; the active default
  profile is assembled otherwise. The response names the selected `profileKey`
  and lists at most 25 selectable `profiles` as `{ key, name, active, default }`
  only — no contact facts — and an unknown key is a `404 { error }` resolved
  against that inventory before anything is loaded, never a fallback to another
  profile.
- `job_search_sweep_opportunities` archives the opportunities that can never be
  re-seen: those whose source is inactive, whose status is still `found` or
  `recommended`, and whose `last_seen_at` predates `notSeenDays` (default 30,
  1–3650). A decided posting is excluded even when its lifecycle status is
  still `found`/`recommended`: "Maybe" and an admin review record the owner's
  verdict in `human_review_status` without moving the row, and an accepted
  posting keeps an `Application`, so the match also excludes any row whose
  `human_review_status` is `apply`, `maybe`, or `reject`, any row with an
  `Application`, and any row with an owner-authored `Decision`. Those two extra
  reads are asserted operations like every other, so a principal without
  `applications.read` or `decisions.read` is refused before any count. It is dry-run first — with no arguments, or `dryRun: true`, it
  returns the matching count, the resolved filter, and a sample of at most ten
  rows and writes nothing. `dryRun: false` applies one batched update that sets
  the same `ARCHIVED_OPPORTUNITY_STATE` the closed-posting path uses
  (`freshness: stale`, `humanReviewStatus: archived`, `status: archived`) plus
  `archiveReason: source_inactive`, and records exactly one
  `opportunity_sweep_source_inactive` `AgentRun` with the counts and the filter.
  It never deletes a row, never touches a row carrying a decision or
  application, and every archived row can be restored individually. Archived
  rows are hidden from the admin list and from
  `job_search_browse_opportunities` unless a `status` filter names them.
- `job_search_import_opportunity` imports a public HTTPS posting URL and reuses
  an existing canonical URL match when available.
- `job_search_record_decision` records Apply, Maybe, or Reject through the
  existing audited decision and application workflow.
- `job_search_open_application` returns an existing local application or
  creates one through the same explicit Apply lifecycle.
- `job_search_list_source_health` lists at most 25 explicitly classified root
  sources and ranks providers from at most 20 durable terminal crawls per
  source.
- `job_search_source_crawl_status` returns at most 20 crawls with reconciled
  terminal counts and at most five sanitized error samples per crawl.
- `job_search_set_source_active` enables or disables one explicit root source,
  synchronizes its schedule, and records the authenticated reason.
- `job_search_crawl_source` queues one explicit root source with a caller
  idempotency key, a maximum candidate limit of 100, and stable job/crawl IDs.

Together with the two generated opportunity reads, the expected inventory
contains seventeen tools, and `COMMAND_CENTER_MAX_TOOLS` is raised to match. Each
increment is deliberate: it widens the browser-native surface the command center
publishes, so the cap is never bumped as a side effect of adding a tool. The page policy permits read and write effects, but
only the eight named mutation tools can write; `job_search_verify_posting`
writes nothing except its own audit record, and `job_search_sweep_opportunities`
writes nothing at all unless it is called with `dryRun: false`. No destructive operation, generic
source writer, crawl-all operation, approval writer, or mounted UI-control tool
is registered. `preflightOverrideReason` is accepted by no tool; a human
override of an inconclusive verification stays a judgment call made in the
admin UI.

Source operations use durable provenance rather than URL or name inference.
Only `sourceRole: root` records with no parent are operable. Crawler-created
career sources persist `sourceRole: posting_derived`, an explicit
`parentSourceId`, and inactive state. Legacy rows are promoted to root only when
direct `SourceCrawl` history proves they were operated as roots; ambiguous rows
remain `unknown`, inactive, and unavailable until an operator explicitly
reconciles them. Database guards reject dangling, self-referential, or non-root
parents. The same root check runs at the crawler execution boundary, not only in
the browser route.

Provider performance is calculated only from the durable terminal accounting
fields introduced by #370 (`attemptCount`, created, duplicate, skipped,
failed-persistence, reused, and relisted counts). Running/queued summaries never
inflate rankings or displace the bounded terminal history. Status responses
allow only named operational fields and redact authorization, cookie, token,
password, secret, URL credential, query-string, and fragment material. Source
account notes, login identities, Warden references, raw crawl payloads, and job
errors are not returned.

Provider identity is persisted on each root from the source adapter's declared
job-board type. Health requests never infer a provider from a URL or display
name. Discovery scans at most 500 roots, aggregates terminal performance by
that persisted identity before applying the provider and item response caps,
and returns scan, provider-provenance, and truncation metadata so a partial
ranking cannot be mistaken for a complete inventory.

Manual enqueue resolves one request-scoped database and uses it for the Source,
SourceCrawl, job, and schedule operations. A per-source PostgreSQL advisory lock
serializes the active-job check with enqueue, while a partial unique index on
active source-crawl jobs is the durable cross-replica backstop. Concurrent
different-key requests therefore leave one active operation and return a
bounded conflict for the loser; same-key retries return the stable operation.
New and recovered crawl rows receive the configured per-crawl intelligence
request, token, and cost limits before execution, so a manual operation cannot
enter the worker without the same bounded budget as a scheduled crawl.
Activation and its schedule synchronization run inside one database transaction
under the same per-source lock; schedule failure therefore rolls the activation
state back instead of leaving a partially enabled provider.
The crawl tool is marked open-world because the queued worker contacts the
selected provider and can use configured intelligence services; the explicit
source, item, idempotency, and intelligence-budget caps still apply.

Posting preflight verdicts are read from the `posting_preflight` `AgentRun`
audit that `recordPostingPreflight` writes, never recomputed from posting or
expiry dates, so `freshness` and `preflight` remain distinct signals. The
application inspection fingerprints only the assets already selected on and
owned by the application (`loadApplicationReviewSnapshot`); unlike the admin
review page it never prepares, clones, or re-binds material assets, so an agent
read cannot change review state.

Tool execution uses the page's same-origin `/api` transport. Existing session,
authorization, tenancy, writable-field, and sensitive-field checks remain on
the server; browser registration is not an authorization grant. Every
`/api/job-search/[action]` call is schema-validated server-side against the
same `inputSchema` objects the browser registers
(`apps/site/src/lib/job-search-tool-schemas.ts`, enforced by
`apps/site/src/lib/server/tool-arguments.ts`): `required`, `anyOf` of
`required` branches, `additionalProperties: false`, primitive types (query
strings coerced by declared type), `enum`, `format: 'uuid'`, string length,
and numeric bounds. A schema rejection returns a descriptive
`400 { "error": "Invalid arguments for <tool>: …", "details": [{ path, code, message }] }`
(capped at ten details) only after authentication, so a wrong argument name
such as `id` for `opportunityId` is named precisely; `401 { "error": "Unauthorized" }`
and `403 { "error": "Forbidden" }` stay non-descriptive by design and never
carry validation detail. Known limitation: `@happyvertical/smrt-web` 0.43.x
surfaces only `{ error }` 4xx bodies, so a handler's SvelteKit `error(400, …)`
(`{ message }`) still reads as `HTTP 400` in the browser until the upstream
client parses `{ message }`.

Agent-driven mutations execute as a single **owner principal**
(`apps/site/src/lib/server/owner-principal.ts`). Each WebMCP route action, each
authenticated server-MCP `tools/call`, and the agent-drivable admin form
actions (`reviewOpportunity`, `acceptOpportunity`, `bulkReviewOpportunities`,
`createOpportunityRelation`, `deleteOpportunityRelation`,
`createDraftApplication`, `createFactIntake`, `processRecommendationTask`)
and the DataSurface bulk actions below
run inside
`executeAsPrincipal()` from `@happyvertical/smrt-agents`, bound to the signed-in
user and tenant with the session's resolved permission snapshot published, no
`TenantAgent` ceiling, no second persona, and Postgres RLS off. The principal's
fail-closed `allowedTools` list is derived at runtime from the manifest tool
catalog — the authenticated generated server-MCP tools, the command-center
WebMCP definitions, and the two DataSurface bulk capability names
(`tool-catalog.ts`) — never hand-maintained, so effective
authority equals the owner's own RBAC. Inside the run, `assertToolAllowed()`
checks the tool and `assertOperation()` asserts every generated model
`(collection, action)` permission the tool's curated response and workflow
side effects need before any read or mutation (`deleteOpportunityRelation`
asserts the relation's `read` and `delete` and looks the record up only inside
the run, so an unauthorized caller cannot probe which ids exist or which
opportunity they belong to); a denial returns the same
`403 { "error": "Forbidden" }` body as before. `AgentRun` is system-authored
(the generated catalog exposes it as list/get only, so no `agentruns.create`
permission exists); by convention every workflow that writes an audit run —
not only posting verification, but the source activation, crawl enqueue, and
import audits, the Apply paths' posting preflight, and the admin draft,
accept, and accept-to-apply actions — asserts `(agentruns, read)` as the
surrogate, declared once as `agentRunAuditOperations` in
`workflow-operations.ts`. The decision and
application-opening routes still require decision-read permission before
returning decision context; the inspect and verify routes require `agentruns`
read (the preflight audit), the application inspection requires
`applications`, `applicationmaterialcomments`, `agentruns`, `opportunities`,
`resumeassets`, and `tasks` reads, and the resume read asserts read on every
collection in both resume read plans plus `resumetailoringconfigs`. The
generated server-MCP mutation tools assert the composite operation set of the
write, not only its primary `(collection, action)`: `mcpToolOperations()`
(`mcp-tools.ts`) adds the workflow side effects `callMcpTool()` runs around each
class's create/update/delete, declared once in `workflow-operations.ts` and
shared with the admin form actions — application writes add the application
re-read, `tasks` read/create/update, and the `opportunities` read/update of the
submitted-application re-status; opportunity writes add the `opportunities`
read and `tasks` read/create/update of the recommendation-task sync; source
writes add the `sources` read/update of the schedule re-save and the
account-task sync; resume-variant writes add the selected applications'
read/update plus the application task sync; resume-asset updates and deletes
add the `resumeassets` read that refuses application-owned materials. A
principal holding `applications.update` but no `tasks.*` permission is refused
before the write and no task is created. Every execution emits one structured JSON audit
line (`event: owner_principal.audit`, `agentClass: iolaus/owner`)
recording the actor, the on-behalf-of user, tenant, action label, and tool.
Browser-cookie and terminal Bearer sessions both execute inside the SMRT
request database and tenant context. The public read-only server-MCP path
(`SMRT_PUBLIC_MCP_TOOLS`) runs without a principal and cannot mutate.

WebMCP is confined to local job-seeker data. Import may retrieve the supplied
public job-posting URL through the existing detail resolver. Import accepts only
HTTPS DNS hostnames, rejects any private or reserved DNS answer, pins the
validated address for the request, revalidates redirects and resolver-supplied
canonical URLs, limits response size, and applies one end-to-end deadline. Its
response includes only a bounded status summary, never the downloaded posting
body. Failed or unresolved imports remain retryable.

Apply decisions and application creation share a per-opportunity database lock,
and all lifecycle record writes use the same transaction connection. Simultaneous
Apply, Maybe, and Reject requests therefore cannot create contradictory or
partially committed lifecycle state. Concurrent requests to open the same
application reuse the first result without recording or planning it twice. Apply
may invoke the application's configured AI to prepare local planning data after
the transaction releases; this is reflected in the tool's open-world annotation.
It cannot submit an application, contact an employer, create an employer account,
bypass CAPTCHA or 2FA, or operate an employer web site. The inspect and browse
results omit candidate profile records and return only the opportunity, company,
score, decision, and application context needed for the next safe step.

## DataSurface bulk actions

The admin opportunity list exposes two bulk workflows through the
`@happyvertical/smrt-agents` DataSurface action adapter
(`apps/site/src/lib/server/opportunity-data-surface-actions.ts`). **They are
not WebMCP tools and not server-MCP tools.** They are reachable only over
`POST /api/admin/opportunities/bulk-actions/{preview,apply}`, behind the same
session requirement and the same owner principal as every other agent-driven
mutation. `opportunity_bulk_review` and `opportunity_bulk_process_llm` are
principal capability names, present in `allowedTools` only so the fail-closed
`assertToolAllowed()` check has something to match; they are absent from the
MCP catalog, from `jobSearchWebMcpToolDefinitions`, and from the command-center
tool budget.

| Action | Operation | Sensitivity | Effect |
| --- | --- | --- | --- |
| `review` | `(opportunities, update)` | sensitive | Records a human review disposition, carrying over rating, notes, and reviewer when the caller omits them. |
| `process-with-llm` | `(opportunities, update)` | public | Queues one durable, idempotent opportunity-intelligence job per row. |

Bounds:

- **Selection scopes** are `explicit-ids`, `current-page`, and `all-matching`.
  Browser-supplied ids are only ever hints. `current-page` is re-derived from
  the caller's filter state and page number; `all-matching` is re-resolved from
  the server's own query and never from ids the browser holds.
- **The filter state is fingerprinted.** `createOpportunityQueryFingerprint()`
  digests the canonical filter state and sort. The page offset is excluded, so
  the digest identifies the filtered set rather than one page of it; the apply
  request fingerprint binds the page separately, and the admin route rebuilds
  the list component on any URL change, so an escalation does not survive
  paging in the browser. An `all-matching`
  request that presents a fingerprint other than the one the server computes
  from the declared filters is refused as `stale_query_fingerprint`. The
  fingerprint also participates in the confirmation and idempotency
  fingerprints, so two applies with the same arguments but different filters
  are different decisions.
- **`maxSelectionSize` is 500.** A larger `all-matching` set is refused as
  `limit_exceeded` rather than truncated, and a set that changes between the
  count and the listing is refused as `matching_count_drifted`.
- **Preview is mandatory.** Every action declares `confirmation: required`, so
  an apply must carry a confirmation token minted by a prior preview. The token
  is single-use, expires, and binds the actor, tenant, on-behalf-of and
  acts-as ids, agent class, surface identity, action id, action arguments,
  query fingerprint, selection fingerprint, and resolved-rows fingerprint. An
  apply whose filters, arguments, or matched rows have drifted since the
  preview is refused.
- **Applies are idempotent.** Each carries an `idempotencyKey` reserved
  durably before any work; a retry with the same key and request replays the
  stored result, and a retry with the same key and a *different* request is
  refused. Token consumption admits a replay of the same key and refuses any
  other, so one preview authorizes exactly one decision.
- **Per-row outcomes** are reported rather than aggregated into success or
  failure: `not_found`, `invalid_status_transition` (archived rows are never
  re-reviewed), `posting_content_missing` (an LLM row with no stored posting
  content), `already_queued`, and `row_revision_drifted` — every write is
  pinned to the revision the selection resolved it at, so a row edited in
  between fails rather than overwriting the newer value.
- **Authority is re-checked at apply time.** Every apply that reaches the rows
  re-enters the owner principal and repeats the descriptor, tool, operation,
  authorization, and per-row eligibility checks rather than inheriting the
  preview's decision, emitting one `owner_principal.audit` line carrying
  `surfaceId`, `actionId`, `requestId`, and the `idempotencyKey`. The upstream
  adapter settles some outcomes *before* entering the principal -- a malformed
  envelope, an expired, mismatched, or already-spent confirmation, an
  idempotency conflict, a replay of a completed apply, a reservation still held
  elsewhere -- and those re-assert no operation and write no line of their own.
  The route covers them: it hands the principal an audit sink that records
  whether the principal wrote its line, and emits one itself when it did not,
  under the same `data_surface.action.preview` / `data_surface.action.apply`
  labels the adapter stamps on the phases it executes. Every answer the route
  returns therefore carries exactly one audit line, and one filter over the
  audit stream returns them all -- `outcome: replayed` for a successful result
  an earlier apply already recorded, and otherwise `outcome: refused` with the
  reason. A replayed *unsuccessful* result is recorded as refused too: the
  route cannot distinguish it from a fresh refusal, and the reason is the part
  worth keeping. An unexpected failure before the principal
  -- the state store, or the adapter's own database work -- has no result to
  report but is still recorded, as `outcome: failed`, before the 500 escapes.
  Outside this: an unauthenticated caller is rejected with 401 before any of
  it. Tool and operation denials are *not* an exception
  -- they surface from the adapter and return 403, by which point the principal
  has already written its line.
- **State is durable and shared.** Confirmation tokens and idempotency records
  live in `data_surface_preview_tokens` and `data_surface_idempotency`, so a
  retry that lands on another replica sees the same state. Both objects are
  off every generated surface (`api`/`cli`/`mcp` includes are empty), asserted
  by `api-exposure.spec.ts`.

"Select all N matching" is a purely client-side escalation of the list's own
checkbox selection: it registers no WebMCP command, and it holds no row ids in
the browser — it records only the query fingerprint the listing was rendered
under, which the server re-resolves. It is bound to that fingerprint, so a
filter or sort change drops the escalation rather than retargeting it. The
actions themselves are never browser-callable except through the authenticated
route above.

## Reproducible local discovery

1. Install the pinned workspace dependencies, then start the site:

   ```bash
   pnpm install
   pnpm --filter @willgriffin/iolaus-site exec vite dev --host 127.0.0.1 --port 5724
   ```

2. In a WebMCP-capable browser, use the normal local command-center session and
   open `http://127.0.0.1:5724/admin/`.
3. Connect a fresh external WebMCP harness to that tab. Begin with its
   tool-inventory action; do not interact with page controls.
4. Record the browser and harness versions, URL, authenticated role (never a
   credential), and returned tool inventory. It must contain the two generated
   opportunity reads plus the twelve `job_search_*` operations listed above,
   and no generic application/task/candidate reads, create, update, delete,
   destructive, or UI-control tools.
5. For a non-mutating functional check, call browse with `limit: 1`, then inspect
   the returned opportunity. Confirm neither response contains candidate profile
   fields or credentials.
6. Capture the inventory and bounded read output plus a screenshot of the idle
   admin page as the evidence artifact. Confirm no application, opportunity,
   task, or employer record was changed.

`apps/site/src/lib/webmcp.spec.ts` is the session-independent registration
regression check. Service and route tests cover bounded input, URL validation,
authentication, curated output, and reuse of the existing application workflow.

## Deployed-browser procedure

Use this procedure only after the reviewed deployment containing this change is
live. Keep the production audit read-only even though bounded write operations
are discoverable.

1. Have the deployment owner provide an already-authenticated admin tab. Do
   not create a new production login/session as part of this audit.
2. Attach a fresh external WebMCP harness to that existing tab and request its
   tool inventory. Optionally call only the bounded browse and inspect tools.
   Do not invoke a write tool, click a control, navigate to an employer site,
   or open a posting URL.
3. Save the exact URL, deployment revision, browser/harness versions, tool
   inventory, and an idle-page screenshot. Do not record cookies, tokens, or
   personal profile data.
4. The expected result is the same fifteen-tool surface as local. If the harness
   reports no tools, capture that exact response and stop; diagnose the
   browser/runtime prerequisite before changing app policy.

The "fresh" requirement applies to the external harness connection. Reusing an
already-authenticated page is deliberate: it permits discovery without creating
or modifying production records or sessions.
