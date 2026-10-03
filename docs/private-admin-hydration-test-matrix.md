# Private admin list hydration

Issue [#138](https://github.com/willgriffin/iolaus/issues/138) closes generated
private CRUD surfaces. Authenticated admin lists must continue to render when
those models are absent from the public SMRT web registry.

The applications, opportunities, and tasks live lists use application-owned
collection identities. Their display fields remain in `lib/admin/resources.ts`;
the collection metadata contains no tool descriptors or record data. Hydration
reads only `/api/admin-resources/{resource}`, whose server handler verifies the
workspace subject. Mutations stay on the existing guarded application workflows
and form actions. Other admin lists already use that curated read endpoint
without a SMRT web collection lookup.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Private live lists render independently of the public registry | Navigate to each of applications, opportunities, tasks | Every shell constructs an explicit admin collection identity | A public registry lookup that rejects every private name does not prevent rendering | Authenticated admin; SSR shell and signed-in browser hydration | N/A: metadata only; existing server read owns authority | Svelte server and browser; N/A: no SQL added | Closed public registry; no private fields or tool descriptors emitted | SSR regression and signed-in UI | Focused `AdminHydratedResourcePage.spec.ts`, browser navigation |
| List hydration uses only curated admin reads | Live list preload | Query URL and authoritative payload reach `/api/admin-resources/{resource}` | Required create fetcher rejects without network access; get/update/delete/custom fetchers absent | Authenticated admin; tenant/user cache scope retained | Existing verified-subject server handler; no new executor | Node/browser; N/A: no SQL added | Upstream collection requires a create function even for read-only lists | Unit | Focused `admin-resource-hydration.spec.ts` |
| Metadata scope is explicit and bounded | Collection identity lookup | Exactly three supported list identities resolve | Unknown slug rejects; returned metadata cannot mutate future definitions | App-owned display metadata, carries no authority | N/A: pure metadata construction | Node/browser; N/A: no database | No generated CRUD route or WebMCP registration added | Unit | Focused `admin-resource-definitions.spec.ts` |

Regression comparison: the SSR mock now throws for every public registry
lookup, matching the observed browser `Unknown web collection definition:
tasks` failure. Reintroducing the former component lookup fails all three
render cases. Runtime validation is coordinated by the integration owner to
avoid concurrent native dependency and Vite operations.

## Empty evidence and failed hydration (#151)

When no saved partial assessment remains current, Cited support keeps every
unsupported row unranked and uses the existing updated-time/id fallback. Its
empty expression is `CAST(NULL AS INTEGER)`: PostgreSQL rejects a bare `NULL`
in `ORDER BY`. A stale saved assessment must not be revived to avoid that empty
case. This is a read-only query change; no schema or data migration is needed.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Empty current support remains sortable | Cited support ascending or descending after candidate/profile changes | Stable updated-time/id order and page offsets | Missing or stale receipt returns no invented support | Owned workspace; current partial replay retained | Native query; PostgreSQL pinned session and connection-local temporary fixtures; no production writes | PostgreSQL and SQLite | Bare `ORDER BY NULL` production failure (42601) | Native SQL regression and authenticated reload | `admin-opportunity-query.spec.ts`; live production loader readback |
| A rejected read is terminal and retryable | Curated list endpoint rejects HTTP 500 | Error and Retry appear; successful retry restores payload | Pending upstream preload must not keep the initial spinner forever | Same tenant/user/query cache scope | N/A: browser read only; server authority unchanged | Svelte browser; no SQL | SMRT live collection error/preload lifecycle | Mounted browser regression | `AdminHydratedResourcePage.browser.spec.ts` |
| Cached payload and disposal stay safe | Revalidation fails or component unmounts before reply | Existing rows remain visible with the load error | Late rejected/successful response does not alter a disposed view | Scoped authenticated browser cache | N/A: no mutations or external write | Svelte browser; no SQL | Native collection invalidation initiates retry | Mounted browser regression | Same focused browser spec |
