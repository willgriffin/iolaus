# Native hosted-mode acceptance

`NativeQA.xcodeproj` is an XCTest UI runner for an **isolated** iOS app with
bundle ID `us.jobgeni.app.qa`. It operates the real WKWebView and native link
entry control. It does not inject JavaScript, manufacture cookies, or mock the
application's authentication, authorization, persistence or PDF services.

The tests intentionally use only `mobile-owner@phone-qa.invalid`, a fictional
candidate and loopback services. Do not point this runner at production.

Fixture prerequisites:

- A disposable `self-hosted`, `shared`, magic-link application at
  `https://localhost:34472`, with its actual migrations applied to its own
  PostgreSQL database, UTC sessions, public profiles enabled, a real isolated
  S3 provider, and background/inference workers disabled.
- A trusted localhost certificate installed only in the QA simulator. The SMTP
  sink must implement STARTTLS and deliver only to the `.invalid` test domain;
  it must correctly undo SMTP dot-stuffing before MIME decoding. Its test-only
  `http://127.0.0.1:25473/link` endpoint returns the most recent delivered link.
  Neither service may expose a port on the LAN.
- Invite the synthetic address through the existing product invitation service
  with `--no-email`; no pre-created user or session. Start with a fresh database
  and an empty mail sink for the signup/create sequence.
- Build the Debug app with `JOBGENI_MOBILE_SERVER_URL=https://localhost:34472`
  during `cap sync`, `PRODUCT_BUNDLE_IDENTIFIER=us.jobgeni.app.qa`, a separate
  derived-data path and simulator. Debug link validation uses that exact
  configured origin. Release validation always pins `https://jobgeni.us`.
- Run `test10RealEmailSignIn`, `test20CreateResumeAndRelaunch`, and
  `test30EditPersistPublishWithdraw` in order, on one simulator. The latter uses
  an ephemeral `URLSession` without the app's cookies for anonymous checks.
- Before running `test50RevokedSessionReturnsToSignIn`, revoke the synthetic
  owner's sessions using the real `SessionService.destroyAllUserSessions` API.

Example runner command, after fixture setup and app installation:

```sh
hv-heavy -- xcodebuild -project mobile/qa/NativeQA.xcodeproj -scheme NativeQA \
  -destination 'platform=iOS Simulator,id=<QA device UUID>' \
  -derivedDataPath /tmp/jobgeni-qa-runner CODE_SIGNING_ALLOWED=NO \
  -only-testing:NativeQA/NativeQA/test10RealEmailSignIn \
  -only-testing:NativeQA/NativeQA/test20CreateResumeAndRelaunch \
  -only-testing:NativeQA/NativeQA/test30EditPersistPublishWithdraw test
```

Capture logs and `.xcresult` bundles in a private temporary directory: XCTest
may record text-entry activity containing the one-use link. Retain only named,
post-authentication screenshots and sanitized summaries, then destroy raw
bundles, message contents, test credentials and the disposable services/data.
Resync the shell without the override before any production-target build.

The executed 2026-11-19 fixture used PostgreSQL 18.6, Garage 1.0.1 and the actual
product SMTP mailer/MagicLinkService. See `docs/jobgeni-mobile-acceptance.md` for
observed outcomes and remaining limits.
