# Issue 156: inactive sweep form authority

| Behavior | Trigger | Allow | Deny | Context / executor / runtime | Verification |
|---|---|---|---|---|---|
| Preview and apply authority | Admin sweep form | Existing opportunity read/update, source read and workflow audit capability | Each missing permission, revoked current permission, mismatched profile | Native principal and verified subject; service mocked, no transaction change | Route Vitest |
| Sweep invariants | Service invoked | Read-only preview; separate apply | Shared hosted refuses; protected records retained | Existing service tests, SQLite transaction integration; live daily PostgreSQL preview | Sweep tests and browser |

No provider calls, schema changes, role grants, or release. Existing native API defines the permission set; UI must use the same set.

Validation: 85 tests passed across route authority, sweep service and SQLite integration. Prior implementation failed both new allow regressions; deny cases passed. Live daily PostgreSQL browser preview returned: No opportunities under an inactive source have gone unseen for 30 days. No apply executed. Native principal checks remain fresh and profile-bound; no new grants. SMRT review routing inspected, strict knowledge check and diff whitespace check passed. Independent worker review remains unavailable under the existing worker quota limit. No release requested.

## Shared-hosted preview

| Behavior | Trigger | Allow | Deny | Context / executor / runtime | Verification |
|---|---|---|---|---|---|
| Catalog preview | Sweep inactive in Opportunities | Current allowlisted catalog operator with the existing native workflow permissions can preview eligible postings | Non-operator and revoked operator get HTTP 403 before catalog access | Verified request subject, PostgreSQL count and bounded sample | Sweep unit and hosted PostgreSQL clone |
| Shared archive boundary | Direct apply or existing tool invocation | Private preview and apply retain the existing authorization and protection predicates | Shared apply requires operator dispatch. Shared tool calls retain their existing restriction. | Existing native principal, PostgreSQL shared mode, SQLite and PostgreSQL private mode | Service, route and SQLite transaction tests |
| Toolbar availability | Load Opportunities or finish a preview | Shared operator sees the preview control and dispatch notice. Private operator sees the archive confirmation after preview. | Shared members see no sweep control. Shared preview never renders archive confirmation. | Server-derived mode, Svelte render, no data mutation | Toolbar tests |

The shared preview exercises the same catalog predicates without scheduling jobs, changing any posting, or recording an archive audit.
