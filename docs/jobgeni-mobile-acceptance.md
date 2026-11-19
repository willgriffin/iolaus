# Phone acceptance — 2026-11-19

Production and isolated acceptance are different evidence:

| Target | Observation |
|---|---|
| `https://jobgeni.us/admin/career/`, `us.jobgeni.app`, iPhone 18 Pro / iOS 27.0 | Real hosted Career entry redirects to invited-email sign-in with the Career return path. No production authentication or personal record access. |
| `https://localhost:34472`, `us.jobgeni.app.qa`, separate iPhone 17e / iOS 27.0 | Actual native XCTest sign-in and resume/publication acceptance below. |

The isolated application ran `self-hosted`, `shared`, `magic-link` mode with its
real migrations on disposable PostgreSQL 18.6, a real Garage 1.0.1 S3 bucket, and a
loopback-only STARTTLS SMTP sink. A local test certificate was trusted in the QA
simulator. Only `.invalid` synthetic invitations were added through the product
invitation service. No user/session was pre-created: the real emailed one-time
link and confirmation POST provisioned the account, private tenant and session.
The sink reverses SMTP dot-stuffing before MIME decoding; a fixture decoding
error initially produced an invalid link, correctly refused by the application.

The native QA bundle uses an explicit Debug server-origin override. It opens
links only for that exact configured scheme/host/port and magic-link path.
Release link entry remains pinned to `https://jobgeni.us`. No cookie transfer,
JavaScript injection, token-validation backend, offline database or paid model
service was added. The installed production-target app/device was preserved.

## Executed results

| Case | Result |
|---|---|
| `test10RealEmailSignIn` | Native WKWebView email form → actual STARTTLS message → explicit native paste → existing hosted confirmation and POST → authenticated onboarding. Real user count changed 0→1. |
| `test20CreateResumeAndRelaunch` | Real session survived native relaunch. Created and saved Fictional Mobile Candidate through onboarding; opened the saved record via Menu → Resume. |
| `test30EditPersistPublishWithdraw` | Edited the summary through the resume UI, terminated/relaunched the app and saw the exact saved text. Generated the real PDF preview in the existing renderer/storage path and explicitly published that version. |
| Anonymous selected snapshot | An ephemeral URLSession with no app cookies received HTTP 200 and the chosen fictional name/summary. Contact email was absent because its checkbox remained off. |
| Private edits stay private | A later private summary edit containing `PRIVATE MATERIAL` did not appear in the already published snapshot; the earlier reviewed summary remained present. |
| Withdrawal | Explicit native Unpublish removed the current publication. An independent anonymous HTTPS request followed redirects and received HTTP 404. |
| Second-account authority | A separately invited fictional account completed the actual email challenge and confirmation, then saved its own profile. Guessed foreign reads returned 404, foreign edits 404, and foreign publication preparation 403. The owner's record hash remained unchanged; no foreign content was returned. |
| Logout | The second account's actual logout cleared its session cookie; a private route returned to sign-in. |
| `test50RevokedSessionReturnsToSignIn` | Revoked the synthetic owner's live session through `SessionService.destroyAllUserSessions`, then relaunched the native app. It showed sign-in and no private profile content. |
| No platform inference | During the native creation/edit/publication workflow, AI spend rows = 0 and agent runs = 0. No inference credentials were configured. |

The XCTest runner is retained at `mobile/qa/NativeQA.xcodeproj`; fixture
prerequisites and invocation are in `mobile/qa/README.md`. The URL validator has
21 positive/negative cases including exact Debug-origin matching and rejection
of another host/port and local URLs under the production default.

Native form testing exposed iOS focus zoom on onboarding's inherited 14px inputs.
Mobile onboarding inputs now use 16px, matching the existing career editor.

Sanitized local evidence lives at
`/Users/will/Work/happyvertical/evidence/jobgeni-phone-372/verified-hosted-mode/`:
`edited-resume-after-relaunch.png`, `selected-resume-published.png`,
`resume-unpublished.png`, `revoked-session-signin.png`, the second-account result
JSON, and aggregate/test summaries. Raw one-time link activity, `.xcresult`
bundles, mail contents and fixture credentials are not retained for handoff.

## Remaining limits

This proves the exercised flow on the real isolated hosted-mode product, not a
production login or deployed free-cloud rollout. No personal account was needed.
Network-loss retry, expired-token timing, Android, physical-device signing,
export/deletion UI and production rollout acceptance remain pending in #372.
There was no production deploy, merge, App Store action, real email or employer
submission. Full review/mergeability remains a separate delivery gate; the
existing workstation Docker import fixture failures were not waived.
