# JobGenius phone client

`mobile/` is an independent Capacitor 8.5.3 project. It opens the existing hosted
Career workspace at `https://jobgeni.us/admin/career/`. It follows the shipped
Hearth shell (happyvertical/hearthed.org#96, merged PR #101): one hosted UI,
WebView cookie session, no local application server or replicated database.
There are no AI, billing, camera, filesystem, push or native token-storage plugins.
The existing server owns authorization, resume edits, opt-in publication,
export/deletion and inference policy.

## Launch on this Mac

Use Node >=26.10 and pnpm 11.25, Xcode and an installed iOS runtime:

```sh
pnpm --dir mobile install --frozen-lockfile
pnpm --dir mobile validate
mobile/scripts/test-sign-in-link.sh # Swift validator tests
pnpm --dir mobile sync
hv-heavy -- xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath /tmp/jobgeni-phone-derived CODE_SIGNING_ALLOWED=NO build
xcrun simctl boot 'iPhone 18 Pro' # omit if already booted
xcrun simctl bootstatus 'iPhone 18 Pro' -b
xcrun simctl install booted /tmp/jobgeni-phone-derived/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted us.jobgeni.app
open -a Simulator
```

Bundle ID `us.jobgeni.app`, version 1.0 (1). `pnpm --dir mobile open:ios` opens
Xcode for device builds. Physical iPhones require a developer team, signing and
provisioning configured outside source control. No App Store release is included.
Android is now the primary verified phone client. The Android native same-WebView
link control and synthetic hosted-mode workflow are verified on a Pixel 7 /
Android 16 (API 36) emulator. See [Android acceptance and APK install](jobgeni-android-acceptance.md).
Builds need JDK 21 and the Android SDK; both were recovered from existing
user-local installations without sudo or replacing tools.

For an isolated test server, set an explicit origin for the synced build:

```sh
JOBGENI_MOBILE_SERVER_URL=http://127.0.0.1:5173 pnpm --dir mobile sync
```

Overrides reject credentials, paths, query strings, fragments and public cleartext
hosts. HTTP is restricted to local/private development hosts. Resync without the
override before a hosted build. Config/assets copied by sync are ignored; only
native project source is committed. The dependency-free validator runs even
without native SDKs or installed dependencies.

## Session and acceptance limits

The current hosted site redirects the Career entry to
`/login/?next=%2Fadmin%2Fcareer%2F` and requires an invited email magic link.
The shell displays that actual form; it does not create an account or bypass the
invite gate. On iOS, tap **Open sign-in link**, explicitly paste the link from
the email, then confirm on the existing hosted page. This navigates in the same
WKWebView, so the hosted POST sets this app's cookie. The app does not verify or
consume a token itself, read the clipboard automatically, inject JavaScript,
transfer cookies, or persist/log the pasted URL. It accepts only the exact
HTTPS jobgeni.us magic-link path with one nonempty token; other origins,
credentials, ports, fragments, paths and extra query parameters are refused.

**Authenticated simulator acceptance is verified against a disposable real
hosted-mode instance**, separately from production smoke. XCTest drove the
native control and actual web UI through email challenge/confirmation, fictional
resume creation/editing, app relaunch persistence, PDF preview, explicit
publication, anonymous snapshot/privacy checks, withdrawal, and revoked-session
return to sign-in. A second real account's foreign reads/edits/publication were
denied. See [the acceptance report](jobgeni-mobile-acceptance.md).

Debug builds validate links against the exact configured server origin so an
isolated HTTPS test instance can be used. Release builds pin link entry to
`https://jobgeni.us`. Android now has the equivalent explicit paste-link control and verified
synthetic sign-in/resume/publication flow. No universal-link association or automatic native bootstrap is
mounted by this product.
The shared `createMobileAuthHandlers` contract currently brokers OIDC/PKCE
(`smrt/packages/users/agents/mobile-auth.md`); copying it does not establish
magic-link compatibility. Framework session/callback support must be coordinated
with its existing owner, rather than adding an app-owned token bridge. The
Hearth PR also deferred its bearer bootstrap (happyvertical/smrt#4588).

Production `jobgeni.us` evidence remains HTTPS/sign-in-screen smoke only. No
personal account, production invitation, session or candidate record was used.
The isolated test stack used actual PostgreSQL, Garage S3, the product SMTP mailer
and MagicLinkService; it did not mock auth or manufacture sessions. No platform
model spend or agent runs occurred during the exercised workflow.

Network loss/retry, physical-device/store signing, export/deletion UI, and
production rollout acceptance remain pending in #372. The app does not queue or
replay writes. Offline remote-load failure presents a static retry page; native
offline transition remains unverified. This PR does not establish free
self-service signup or complete the entire rollout issue.
## Evidence

2026-11-19: unsigned Debug build succeeded on Xcode, iPhone 18 Pro / iOS 27.0
simulator (device `5CE17F56-3424-4749-B0A7-423C5B73BCAC`). Installed and launched
`us.jobgeni.app`; the actual hosted invited-email sign-in form and Career return
URL were observed. `ios.contentInset=always` keeps the page below the status bar.
Config tests cover default TLS/navigation, local overrides, malformed and
credential-bearing URLs and the absence of persistence/inference plugins.

See [the behavior matrix](test-matrix/jobgeni-phone-372.md) for pending acceptance.
