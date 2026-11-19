# Iolaus for macOS

The desktop app runs the production Iolaus site inside the published SMRT Tauri
wrapper. It bundles Node and dependencies: the installed app does not require a
checkout, Node, pnpm, Docker, or the hosted Iolaus service. The server listens
only on loopback; the wrapper selects an available port. Opening the app signs
the local OS user into the sole local owner account using a fresh launch secret.
No employer communication or hosted promotion occurs during installation.

## Build and install

Use Node 26.10 or later in the 26.x line and pnpm 11.25.0, Rust, and the Xcode
command-line tools. `pnpm install` provides the pinned Tauri CLI. The runtime
bundle explicitly requests Node 26.12.1; its hash must be pinned by the published
SMRT desktop package. Never lower the engine requirement to fit an older pin.

```sh
pnpm install --frozen-lockfile
hv-heavy -- pnpm desktop:bundle
hv-heavy -- pnpm desktop:build -- --smoke
pnpm desktop:install
open "$HOME/Applications/Iolaus.app"
```

When `hv-heavy` is unavailable, run the same build commands without that wrapper.
The unsigned local artifact is `.desktop/installers/Iolaus.app`. This is a local
build, not a signed/notarized public release. The installation command refuses
to replace an existing app: quit Iolaus, move the old app aside, then reinstall.
Application data is independent of the app bundle and is retained.
`IOLAUS_DESKTOP_OUTPUT` selects an alternate absolute build directory.

The bundler stages a standalone production manifest and lockfile, preserving
repository dependency overrides. The workspace resume library is compiled into
the server. Only enumerated public runtime files enter the bundle; checkout
`.env` files, SQLite data, credentials and source trees do not. SMRT verifies
Node/download hashes, native architectures, dependency imports and file digests;
its builder consumes that verified bundle and the package's shipped Rust wrapper.
The CLI bridge is bundled from published `smrt-app-cli`, following SMRT's
explicit interim bridge-build contract.

## Data, providers, and recovery

macOS data lives under
`~/Library/Application Support/com.willgriffin.iolaus/runtime`; the wrapper's
logs live beside it. Quit the app before copying this directory for a backup.
Restore the complete directory with the app stopped; retain private filesystem
permissions. Never put a backup in the repository. Relaunching retains records,
assets and the local owner; a lost webview cookie is recovered by the next
launch's native owner handoff.

The app starts in the local profile with background crawls disabled. AI import,
analysis and tailoring require the user's configured provider; unconfigured
providers produce actionable errors. This MVP imports text PDFs and renders PDFs; local OCR is excluded through
SMRT's supported feature configuration. Enter scanned resumes manually or
provide a text PDF. Browser PDF printing retains its documented installed-
browser prerequisite. Installing or
opening Iolaus does not send applications to employers.

For a failed launch, quit Iolaus, inspect the wrapper's private logs and verify
that the data directory is writable. Do not delete the data directory to fix a
launch. Reinstall the app bundle independently of the data. An unresolved schema
or provider failure must be diagnosed before attempting a new write.

## Validation

The plan and behavior matrix are in [mac-desktop-mvp.md](plans/mac-desktop-mvp.md).
The owner-link unit tests cover missing/incorrect launch proof and cross-origin
denial. Run `desktop:build -- --smoke` for the published wrapper's health,
owner-link denial and orderly shutdown checks. The independent installed-app
workflow harness is documented in `apps/site/e2e/desktop-mvp.acceptance.md`.
Use fictional test data in a separate macOS account when isolating native app
state; production wrapper data roots are managed by macOS application identity.

A temporary `IOLAUS_DESKTOP_FRAMEWORK=/absolute/unpacked/package` can select an
explicitly versioned upstream release candidate for local artifact testing when
the published package lacks the required Node pin. This does not change the
repository dependency pins. `.desktop/framework-provenance.json` records the
actual version and whether it is a local release candidate; such a build is not
published-dependency release validation. Remove that override and rebuild after
the corrected upstream version is published and adopted.

The product uses SQLite and local files. Its bundle explicitly acknowledges lazy
imports for disabled OCR, Gemini SDK, Google Drive files, DuckDB, and framework
build-time generators; these capabilities are not included. The framework still
refuses any missing load-time import. Supported AI defaults retain Anthropic and
OpenAI-compatible adapters, with no implicit inference during manual preparation.

## Guarded native canvas fallback

The public `acknowledgedDynamicImports` configuration includes
`{ "from": "@napi-rs/canvas", "specifier": "./skia.wasi.cjs" }`.
Canvas's generated loader guards that optional WASI fallback in `try/catch`
after selecting the Darwin native implementation. SMRT explicitly documents
acknowledgments for guarded/lazy relative imports and records them in its
bundle report. The earlier diagnosis that this required a new scanner feature
was incorrect. Native canvas loading/rendering must pass on the target, and all
other scanner, native verification, digest and launch checks remain enabled.

To preserve a running application that uses the checkout's production build,
stage an already validated build without regenerating shared SvelteKit files:

```sh
IOLAUS_DESKTOP_OUTPUT=/absolute/isolated/build-directory \
IOLAUS_DESKTOP_BUILD_REVISION=<full-40-hex-compiled-site-commit> \
pnpm desktop:bundle -- --use-existing-build
```

The explicit revision is required; missing/malformed provenance fails before
staging. `build-inputs.json` records the site revision and build-entry digest.
This option copies existing output into a separate immutable stage; it does not
qualify stale output or replace native launch/restart acceptance. Never modify
or replace files under a running personal service's data directory.

Native launch runs the bundled `desktop/setup.mjs` installation/upgrade phase
before importing the HTTP server. It registers the packaged schema metadata,
uses the framework's supplied secure SQLite executor for native and matching
schema preparation, and closes/releases setup custody before normal serving.
Ordinary runtime readiness still checks schema without creating it. The setup
module's migration graph contains no server, model-constructor or Svelte imports.
After staging, validate the exact staged manifest explicitly:

```sh
IOLAUS_NATIVE_TEST_MANIFEST=/absolute/build-directory/stage/apps/site/manifest.json \
node --test desktop/setup.test.mjs scripts/desktop.test.mjs
```

These fresh-root/rollback/restart tests precede the published wrapper smoke and
installed native acceptance; they do not replace either gate.

SvelteKit is a production dependency because the external SMRT SvelteKit owner
handler imports its runtime helpers. Standalone staging resolves catalog entries
to the exact installed versions used by the validated site build; development
packages are not relied on to supply runtime peers. The wrapper smoke verifies
that an unauthenticated owner-link request returns403, rather than allowing a
missing runtime dependency to surface after installation.

In the native wrapper, `/setup` is a recovery page: quit and reopen Iolaus to
sign in. It exposes no owner form or bootstrap token. Native mode comes only
from the supervisor's server-side environment; request parameters cannot enable
it. The route accepts either slash form without a canonical redirect. Browser
installations retain their existing token-guarded setup form.
