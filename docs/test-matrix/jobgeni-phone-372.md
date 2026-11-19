# Phone cloud client #372

Architecture: consume the existing hosted web UI in Capacitor, matching shipped
Hearth #96 / PR #101. No local application server, replicated database, token
store, inference call, billing or new server API. WebView cookie sign-in is the
shipped Hearth session path; native bearer bootstrap is not introduced here.

| Behavior/invariant | Reachable trigger | Positive | Failure | Actor/context | Data executor/transaction | Runtime | External edge | Test level / command |
|---|---|---|---|---|---|---|---|---|
| Hosted workspace launch | Launch shell | HTTPS JobGenius visible | Offline page offers retry | Signed out | N/A: web navigation | iOS simulator; Android config only | HTTPS unavailable | Config unit tests + native build/launch |
| Restricted development origin | Explicit override | Local HTTP or HTTPS accepted | Credentials, non-origin, public HTTP rejected | Developer | N/A: config only | Node 26 | Malformed origin | `pnpm --dir mobile validate` |
| Explicit sign-in link navigation | Tap native button and paste | Hosted confirmation in same WebView | Foreign origin, malformed/duplicate token, credentials, extra query rejected | Signed-out phone | N/A: native navigation only; hosted POST owns session | iOS | Pasted URL | Actual Swift validator: `mobile/scripts/test-sign-in-link.sh`; 21 cases pass; native XCTest sign-in and confirmation pass |
| Session and resume ownership | Sign-in then owned resume routes | Existing web authorization applies | Expired/revoked session and foreign resume denied | Isolated test owner and second account | Existing hosted service owns transactions | Hosted PostgreSQL | Email delivery/session expiry | Real isolated hosted-mode native signup/create/edit/relaunch and revocation pass; actual second-account HTTP denial and logout pass |
| Publish selected resume | Explicit preview and publish | Existing immutable snapshot appears | Private edits absent; withdrawal denies | Isolated owner and anonymous viewer | Existing public-profile service | Hosted PostgreSQL | PDF/storage availability | Native XCTest PDF preview/publish, anonymous snapshot/privacy and withdrawal pass |
| No hosted inference for shell | Basic launch/navigation | No AI dependency or invocation in shell | No offline write/retry queue | Phone user | N/A: no local writes | iOS/Android | Existing web actions remain server-owned | Dependency/config inspection; actual isolated workflow: zero AI spend rows and zero agent runs |

No new auth backend or persistence behavior is implemented. Native evidence and
its production-versus-isolated boundary are recorded in
`docs/jobgeni-mobile-acceptance.md`. Network-loss retry, Android, physical signing
and production rollout remain pending; the issue stays open.
