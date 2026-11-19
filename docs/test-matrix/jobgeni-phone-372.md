# Phone cloud client #372

Architecture: consume the existing hosted web UI in Capacitor, matching shipped
Hearth #96 / PR #101. No local application server, replicated database, token
store, inference call, billing or new server API. WebView cookie sign-in is the
shipped Hearth session path; native bearer bootstrap is not introduced here.

| Behavior/invariant | Reachable trigger | Positive | Failure | Actor/context | Data executor/transaction | Runtime | External edge | Test level / command |
|---|---|---|---|---|---|---|---|---|
| Hosted workspace launch | Launch shell | HTTPS JobGenius visible | Offline page offers retry | Signed out | N/A: web navigation | iOS simulator; Android config only | HTTPS unavailable | Config unit tests + native build/launch |
| Restricted development origin | Explicit override | Local HTTP or HTTPS accepted | Credentials, non-origin, public HTTP rejected | Developer | N/A: config only | Node 26 | Malformed origin | `pnpm --dir mobile validate` |
| Explicit sign-in link navigation | Tap native button and paste | Hosted confirmation in same WebView | Foreign origin, malformed/duplicate token, credentials, extra query rejected | Signed-out phone | N/A: native navigation only; hosted POST owns session | iOS | Pasted URL | Actual Swift validator: `mobile/scripts/test-sign-in-link.sh`; 17 cases pass; authenticated interaction pending |
| Session and resume ownership | Sign-in then owned resume routes | Existing web authorization applies | Expired/revoked session and foreign resume denied | Isolated test owner and second account | Existing hosted service owns transactions | Hosted PostgreSQL | Email delivery/session expiry | Hosted synthetic identity acceptance pending; no test account available |
| Publish selected resume | Explicit preview and publish | Existing immutable snapshot appears | Private edits absent; withdrawal denies | Isolated owner and anonymous viewer | Existing public-profile service | Hosted PostgreSQL | PDF/storage availability | Hosted synthetic identity acceptance pending |
| No hosted inference for shell | Basic launch/navigation | No AI dependency or invocation in shell | No offline write/retry queue | Phone user | N/A: no local writes | iOS/Android | Existing web actions remain server-owned | Dependency/config inspection; hosted authenticated acceptance pending |

No new auth or persistence behavior is implemented. Native sign-in, saved-state,
publication, network retry and second-account evidence remain required for full
issue completion; a visible sign-in page alone does not satisfy them.
