# Admin Overview (#141)

`/admin` is the Overview landing page. Tasks use the verified workspace's
tenant/user/profile tuple. Overdue actionable work comes first, followed by
user decisions and review, work in progress, other user tasks, agent work, and
blocked work. Completed and canceled tasks are omitted. There is no stored
task priority field; the ordering uses existing workflow columns and due dates.

Best new opportunities use the existing source-current assessment query and
the active profile's eligibility and preference fingerprints. Expired and
stale postings are omitted. Eligible and sponsorship-possible matches rank by
current score; incomplete or unknown assessments appear separately without a
score. An existing subject-owned application, including a draft whose human
review still needs input, excludes that posting. The overview reads up to 250
active tasks and three windows of 30 opportunities per section, and presents
up to eight tasks, six current matches, and three pending assessments.

Visible assignee and submission role labels say **Agent**. Persisted `hermes`
values remain unchanged for existing records, filters, and integrations.

| Behavior / invariant | Reachable trigger | Positive case | Negative case | Context / executor | Runtime / contract | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Verified route authority | Open `/admin` | Hook subject passed to loader | Missing hook subject prevents reads | Authenticated request locals; no mutation/transaction | SvelteKit; no client profile selector | `admin-root-route.spec.ts` |
| Task isolation | Two users in one tenant | Each sees own profile tasks | Adapter-returned other-user rows removed | Native `listPrivateRecords` ownership predicate/post-filter | Engine-neutral collection API; SQLite/Postgres use existing helper | `admin-overview.spec.ts` |
| Task action priority | Overdue/review/agent/blocked tasks | Overdue and user review lead | Finished work omitted; blocked follows actionable work | Pure presentation; no database | No external contract | `overview.spec.ts` |
| Current match semantics | New untriaged posting | Current complete score shown | Stale/missing/incomplete/out-of-range score unavailable | Existing scoped assessment fingerprints/query/projection | Existing cross-dialect query; no new SQL | Both overview specs |
| Existing application exclusion | Draft plus needs-input review | Application remains in workflow | Draft not relisted as new opportunity | Existing subject-scoped application hydration | Read-only; no provider calls | Both overview specs |
| Empty sections | No active tasks/new postings | Clear empty state | No invented scores or broad fallback reads | Read-only | No external contract | Loader spec and browser QA |
| Agent display compatibility | Legacy `hermes` assignee | Agent label shown | Internal value remains `hermes` | Presentation only | Existing role enum/filter contract unchanged | `overview.spec.ts` and browser QA |

Validation is coordinated in the integration team's serialized snapshot lane:
focused overview/route specs, targeted formatting/type checks, then browser
QA of `/admin`, task assignee cells, desktop/mobile navigation and empty states.
No canonical build/test or provider/database mutation is required by this slice.
