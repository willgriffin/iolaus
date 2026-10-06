# Issue 157: triage deep-dive authority

| Behavior | Trigger | Allow | Deny | Context/executor/runtime | Evidence |
|---|---|---|---|---|---|
| Triage form authority | Dig deeper action | Opportunity/company read and application.review workflow | Missing each grant, revocation, foreign profile | Native principal + verified workspace; mocked workflow, no DB dialect change | Route regression tests |
| Verdict and follow-ups | Authorized action | Private maybe decision, preserved notes/rating | Partial queue failure preserves verdict; missing target refused | Existing service fixtures; no transaction or provider change | Deep-dive specs |

Local development only. No live decision replay: the user-selected opportunity is not identified in this report and replay could create duplicate work. API and form must assert identical capabilities.

Validation: 77 tests passed (admin route + deep-dive service); new allow regression failed against prior code, all deny regressions passed. Explicit target, verified profile and omitted-field preservation covered. Native revocation and foreign profile denial covered. SMRT review routing inspected; strict knowledge freshness passed with zero issues. No live decision replay, provider requests, migrations or release. Independent worker review remains unavailable under existing worker quota limits.
