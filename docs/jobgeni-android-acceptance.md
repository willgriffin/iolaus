# Android phone acceptance — 2026-11-19

Android is the primary phone client. An installable, debug-signed review APK is at:

`/Users/will/Work/happyvertical/artifacts/jobgeni-android-372/jobgenius-android-debug.apk`

SHA256: `5bc08126d93a755a8536c66b408bebcada0596e8737d32c0f3a18c4dc31755d8`.
The signature verifies. The packaged server URL is exactly
`https://jobgeni.us/admin/career/`; the APK contains no QA certificate or QA
network-security configuration. Package `us.jobgeni.app`, version 1.0 (1),
minimum Android API 24, target API 36. No physical phone was connected.

## Install and sign in

Copy the APK to the Android phone and open it to install. With an authorized USB
debugging connection, list the device serial with `adb devices`, then:

```sh
adb -s <phone-serial> install /Users/will/Work/happyvertical/artifacts/jobgeni-android-372/jobgenius-android-debug.apk
adb -s <phone-serial> shell am start -n us.jobgeni.app/.MainActivity
```

The install command does not replace an existing package. Open JobGenius, request
an email sign-in link using the existing invited account, copy the emailed link,
return to the app, tap **Open sign-in link**, paste it and tap **Open**, then
confirm on the existing hosted page. Opening a link in Chrome establishes a
different browser cookie jar; the explicit native control keeps confirmation in
this app's WebView. No personal account was used during development acceptance.

The emulator's production-target app remains launchable with:

```sh
adb -s emulator-5582 shell am start -n us.jobgeni.app/.MainActivity
```

## Native behavior

The Android control does no native authentication: it validates navigation to
the exact trusted scheme/host/port, exact magic-link path, and one bounded
nonempty token, then loads the existing hosted confirmation in the same WebView.
It rejects foreign origins, credentials, fragments, extra fields, duplicate
parameters, malformed escapes and oversized input. Release builds pin
`https://jobgeni.us`; Debug uses only the explicit Capacitor server origin.
No automatic clipboard access, autofill, saved native input, token logging,
cookie transfer, injected app JavaScript, offline database or billing was added.
Client backup is disabled. Native controls account for Android system-bar insets.

## Executed acceptance

| Target | Result |
|---|---|
| Production `jobgeni.us`, `us.jobgeni.app` | APK installed and actual hosted invited-email sign-in screen observed. No production sign-in, invitation, email or personal records. |
| Isolated `https://localhost:34472`, `us.jobgeni.app.qa` | Pixel 7 ARM64 emulator, Android 16 / API 36, serial `emulator-5582`; a newly created isolated AVD, preserving existing AVDs/data. Actual product in self-hosted/shared/magic-link mode with PostgreSQL 18.6, real Garage 1.0.1 S3, and loopback STARTTLS SMTP sink. |
| `HostedPhoneTest#signupCreateAndEdit` | Passed. Real email form → actual SMTP message → native paste dialog → unchanged hosted confirmation/POST → real account/session; create/save/edit fictional resume through the actual UI. Users/profiles changed 0→1. |
| `HostedPhoneTest#relaunchPublishPrivateEditAndWithdraw` | Passed after a separate app process restart. Session and edited resume persisted; real PDF preview prepared; explicit publication returned the selected name/summary to a separate unauthenticated HTTPS reader. Unchecked email was absent. A later private edit stayed absent from the published snapshot. Explicit withdrawal returned anonymous 404. |
| Inference | AI spend rows 0, agent runs 0 during the exercised flow; no model credentials configured. |
| Build/security | JDK 21, Gradle 8.14.3, SDK/build-tools 36; JVM URL validation (19 assertions), Debug APK, QA APK/instrumentation and Release compilation pass. Production APK signature/config verified independently. |

Android instrumentation uses UiAutomator for the actual native dialog and
Espresso-Web for the actual hosted UI; those are test transports, not runtime
hooks. It does not fabricate users/cookies or bypass TLS. Only the separate QA
build trusts the ephemeral localhost test CA through Android's supported network
security configuration. The production-target APK excludes that material.

Source tests are under `mobile/android/app/src/{test,androidTest}/`. The two
instrumentation methods run in order against a fresh disposable fixture; see
`mobile/qa/README.md`. Sanitized screenshots and result summaries are in
`/Users/will/Work/happyvertical/evidence/jobgeni-phone-372/android/`.
Raw one-use link activity, QA credentials and fixture data are removed after
acceptance. The APK, production-target emulator app and sanitized proof remain.

## Build

```sh
pnpm --dir mobile install --frozen-lockfile
pnpm --dir mobile sync
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/Users/will/Library/Android/sdk
hv-heavy -- ./mobile/android/gradlew -p mobile/android :app:testDebugUnitTest :app:assembleDebug
```

The APK is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
A store release needs the owner's signing/distribution process; no private
signing material or store publication is included. Physical-device acceptance,
network-loss retry, expired-link timing and production rollout remain separate.
The existing root Docker-test/review blockers are not waived by native success.
