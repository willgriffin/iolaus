# Public URL intake

Issue: https://github.com/willgriffin/iolaus/issues/148

The Opportunities and Sources lists expose **Add URL**. A public Ashby,
Greenhouse, or Lever posting is imported through the existing opportunity
workflow and queues its existing source preparation/assessment workflow when
details are available. A recognized board creates or reuses a root source and
requests one initial pull of up to 25 listings. Unrecognized URLs require the
user to choose a posting or careers page; the app does not guess from page text.

Sources remain operator-managed. New sources use `ad_hoc` cadence. Repeating a
URL reuses its canonical source and the initial pull for the current verified
workspace; a terminal pull is reported without silently starting another one.
Paused sources stay paused. A saved record remains available when queueing fails.

Intake crawl fetching uses the existing pinned public-HTTPS transport for the
root, derived ATS APIs, index links, posting details, and every redirect. Static
index parsing does not execute scripts or send credentials. An initial crawl
has a three-minute deadline and a 64-request ceiling; each request retains the
transport's 15-second deadline and response-size limit. Generic pages requiring
JavaScript or authentication are unsupported by this static intake path.

## Test design

Named risk trigger: accepting external URLs requires SSRF, credential, redirect,
and active workspace authority checks. Tests use injected transports and native
workflow fixtures; validation never contacts wild URLs or model providers.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deterministic detection and canonicalization | Paste URL | Three ATS posting/board shapes; tracking aliases | Unknown page requires choice; malformed URL, unknown choice, secret query/private host | Browser and authenticated server | N/A: pure parsing | Node/browser; SQL N/A | Unknown ATS path/optional query | Unit: isolated Vitest `src/lib/url-intake.spec.ts` |
| Fresh native authorization | Submit intake | Active owned workspace allowed; operator source create | Missing/foreign/revoked context; denied import/source permission | User × current tenant/profile; source operator | `runAsOwner` at each mutation boundary | Node; fixture PG/SQLite source paths | Client IDs rejected | Unit: isolated Vitest intake/server route specs; existing native auth suite |
| Idempotent source creation | Submit board twice | One source, stable workspace initial-pull key | Duplicate existing roots; transaction rollback; queue failure leaves saved source; paused source untouched | Active operator | Native Source collection and audit share lock transaction | PG advisory transaction lock and SQLite shared lock | Existing terminal crawl reports actual status | Unit: isolated Vitest server intake spec; existing native enqueue/import transaction suites |
| Public-only bounded fetch | Root/API/index/details | Public DNS address pinned; valid redirects expose final URL for relative links | Private DNS/redirect, rebind, POST, failed root, request/deadline limit | Native operator job tuple | No writes during transport | Node HTTPS; SQL N/A | Upstream HTTP failure; static scripts ignored | Unit: isolated Vitest public HTTPS and intake fetch specs |
| Native crawl uses supplied safe context | Initial intake crawl | Actual generic discovery consumes guarded static context | Guarded root failure prevents crawler; default callers unchanged | Existing native source job owner | Existing durable crawl failure/write fences | Node; existing PG/SQLite job coverage | Derived API/link requests use same transport | Unit: isolated Vitest crawler/job specs |
| Shared form outcomes | Open/submit/retry | Posting/source result and refresh; repeated click submits once | Unknown type selection; invalid URL; HTTP failure retains input; unsupported saved result | Authenticated browser | Server API; mocked response in client harness | Browser | Missing/malformed response; safe internal result link | Isolated happy-dom browser spec; separate authenticated desktop/mobile/dark form QA without live submission |

The final-response URL regression must demonstrate an empty constructed Response
URL on the previous implementation and the exact validated redirected URL on
this change, preserving the same Response body, status, and headers.
