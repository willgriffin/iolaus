# Issue 156: inactive sweep form authority

| Behavior | Trigger | Allow | Deny | Context / executor / runtime | Verification |
|---|---|---|---|---|---|
| Preview and apply authority | Admin sweep form | Existing opportunity read/update, source read and workflow audit capability | Each missing permission, revoked current permission, mismatched profile | Native principal and verified subject; service mocked, no transaction change | Route Vitest |
| Sweep invariants | Service invoked | Read-only preview; separate apply | Shared hosted refuses; protected records retained | Existing service tests, SQLite transaction integration; live daily PostgreSQL preview | Sweep tests and browser |

No provider calls, schema changes, role grants, or release. Existing native API defines the permission set; UI must use the same set.

Validation: 85 tests passed across route authority, sweep service and SQLite integration. Prior implementation failed both new allow regressions; deny cases passed. Live daily PostgreSQL browser preview returned: No opportunities under an inactive source have gone unseen for 30 days. No apply executed. Native principal checks remain fresh and profile-bound; no new grants. SMRT review routing inspected, strict knowledge check and diff whitespace check passed. Independent worker review remains unavailable under the existing worker quota limit. No release requested.
