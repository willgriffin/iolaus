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
