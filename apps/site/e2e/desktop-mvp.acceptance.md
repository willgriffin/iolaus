# Local browser runtime acceptance

The same harness can validate the supported `app:setup` / `app:start` / `app:open` browser runtime independently of native packaging. Use a fresh absolute `SMRT_DATA_DIR`, a unique `SMRT_APP_ID`, `SMRT_RUNTIME_PROFILE=local`, an unused loopback `PORT`, and no configured AI providers or keys. Run the documented commands from the repository root, using the Node and pnpm versions in `package.json`. `app:setup` runs the full build and must run through `hv-heavy --` when available. Keep these exact environment settings for every subsequent app command; the default personal workspace must remain untouched.

Run `app:setup`, `app:start`, and `app:open`. For the create phase, set `IOLAUS_LOCAL_ONBOARDING_FILE` to this workspace's private `onboarding.json` created by setup instead of using `IOLAUS_DESKTOP_OWNER_LINK_FILE`. Its location is the state root returned by `resolveApplicationStateRoot()` in `scripts/smrt-runtime-identity.mjs`. The harness consumes the normal bootstrap token through the real setup form without printing it. Once claimed, an absent onboarding file selects the normal `Continue locally` login form, allowing a failed test to retry without resetting the workspace. The harness saves its native session immediately after authentication.

Run the documented `app:stop` and `app:start` commands with the same workspace environment, then the verify phase below. This proves the browser runtime and local persistence; it does **not** prove an installed native `.app`. The synthetic posting URL is mapped to a loopback-only nonexistent fixture route, with the explicit synthetic preflight override, so server posting checks cannot contact an external employer.

# Native packaging acceptance procedure (#310)

This harness connects to the **installed Iolaus.app sidecar**, without starting a source server, invoking demo fixtures, seeding a database, building, or contacting an employer. All candidate/job content comes from `fixtures/desktop-mvp.json`. It uses no AI provider and selects the canonical resume rather than AI tailoring. Run the installed artifact with no AI/provider credentials configured.

Use a **fresh disposable macOS user account** for this procedure. Alternatively, the published SDK's `wrapper/scripts/smoke-support.mjs` exposes `installIsolatedHome()` for a dedicated QA orchestrator child: call it once, retain that custodian and its scoped environment, and reuse the same QA home across native quit/reopen. Never change the shell/global home or a user's profile. `SMRT_DATA_DIR` does not isolate the macOS wrapper's own data root. The installed app uses that account's `~/Library/Application Support/com.willgriffin.iolaus/runtime`; do not point acceptance at an existing daily workspace or remove its files. Install the built `.app` using the packaging instructions, then launch the installed `Iolaus.app` normally within the selected disposable account or SDK QA child. Observe the native window successfully open and sign in. This native observation is separate from the browser harness.

The supervisor selects a random loopback port and per-launch credential. Identify its sidecar child PID using Activity Monitor and its listening loopback port using `lsof -nP -a -p SIDECAR_PID -iTCP -sTCP:LISTEN`. Do not dump its process environment to the terminal. The QA helper below privately reads only that selected process to obtain the existing native owner-link credential; it is not installed product code and does not create a testing auth bypass.

From the repository root with dependencies and Playwright Chromium already installed:

```bash
export IOLAUS_DESKTOP_STATE_DIR="$(mktemp -d /tmp/iolaus-desktop-acceptance.XXXXXX)"
export IOLAUS_DESKTOP_EVIDENCE_DIR="$IOLAUS_DESKTOP_STATE_DIR/evidence-create"
export IOLAUS_DESKTOP_ORIGIN=http://127.0.0.1:ACTUAL_PORT
export IOLAUS_DESKTOP_OWNER_LINK_FILE="$IOLAUS_DESKTOP_STATE_DIR/owner-link.json"
node apps/site/e2e/desktop-mvp-owner-link.mjs SIDECAR_PID "$IOLAUS_DESKTOP_ORIGIN" "$IOLAUS_DESKTOP_OWNER_LINK_FILE"
IOLAUS_DESKTOP_PHASE=create apps/site/node_modules/.bin/playwright test --config apps/site/e2e/desktop-mvp.config.ts
```

Replace `SIDECAR_PID` and `ACTUAL_PORT` with the running installed app's values. The helper writes a new file with mode 0600 and refuses an existing destination or a destination inside the repository. The test invokes the real `GET /api/_runtime/owner-link?launch=...` through a same-origin browser fetch, which sets the native HttpOnly owner cookie. It passes the normal loopback Host/Origin and fetch-site checks; no header forgery is needed. The credential is kept out of page URL history and test traces/video. Native owner sign-in automatically claims the local owner; the desktop flow does not use the source runtime's `/setup` token form.

The create phase fills private setup and the career editor, exports/reads a real canonical PDF through the SDK reader, captures the synthetic job through the New Opportunity form, selects the PDF as default resume, prepares a draft and packet, and changes the opportunity status to Apply. It checks that the application has no final approval/submission. It writes owner cookies and record/PDF checkpoints to the private state directory. Browser requests outside that exact loopback origin are blocked and fail acceptance. It never selects final approval, record submission, auto-submit or posting-link navigation.

**Quit Iolaus.app normally**, confirm its child sidecar exits, and reopen the same installed app under the same macOS account. Determine the new public loopback port. Keep the same QA data and checkpoint directory; do not reset data or run create again. Identify the new embedded Node PID and regenerate only the private per-launch owner-link handoff, as the native wrapper itself does. An old browser cookie is not promised to authenticate the new native origin.

```bash
export IOLAUS_DESKTOP_ORIGIN=http://127.0.0.1:NEW_ACTUAL_PORT
export IOLAUS_DESKTOP_EVIDENCE_DIR="$IOLAUS_DESKTOP_STATE_DIR/evidence-verify"
export IOLAUS_DESKTOP_OWNER_LINK_FILE="$IOLAUS_DESKTOP_STATE_DIR/owner-link-restarted.json"
node apps/site/e2e/desktop-mvp-owner-link.mjs NEW_SIDECAR_PID "$IOLAUS_DESKTOP_ORIGIN" "$IOLAUS_DESKTOP_OWNER_LINK_FILE"
IOLAUS_DESKTOP_PHASE=verify apps/site/node_modules/.bin/playwright test --config apps/site/e2e/desktop-mvp.config.ts
```

Verify requires a changed runtime process instance and the same host, while allowing the supervisor's port to change. When `IOLAUS_DESKTOP_OWNER_LINK_FILE` is supplied, verify starts a fresh browser context and repeats the existing native owner handoff with the new launch proof before reading the original checkpoint. This matches the installed WebView and never uses legacy local login. Without that variable, the fixed-port browser-runtime variant keeps its existing saved-session behavior. It reloads the same profile, job/application IDs and Apply status, checks no approval/submission appeared, and downloads byte-identical PDFs. A refresh of the same process is insufficient. Retain the screenshots, extracted-PDF checks and checkpoint hashes as acceptance evidence; keep cookie/owner-link files private and delete those credentials after the run. The state directory also contains synthetic PDFs for visual inspection.

Evidence limits: Playwright automates Chromium against the installed sidecar, not the native WebView. Record manual `.app` launch, quit/reopen, installation/signing/Gatekeeper and native window evidence separately. Browser interception does not observe server egress; no-AI configuration and OS network evidence are needed for a total offline claim. Native GUI PDF saving is a separate release gate: a successful HTTP PDF download or inline preview does not qualify it. The installed app must actually present and complete its native save/export path to an explicit QA destination. Current native GUI export remains **blocked**: the PDF-link action produced no new window, save dialog, or exported file; retain that blocker until the shared wrapper supplies the required behavior.
