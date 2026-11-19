# macOS desktop MVP — #310

Session train: willgriffin/iolaus, current main release line, branch
`codex/iolaus-desktop-mvp`, one ready pull request. Claim: issue #310,
comment 6961267294. Ordered micro-items, each committed with `Refs #310`:

1. Adopt compatible published SMRT 0.62.1 and its required SDK 0.113.1 cohort.
2. Package Iolaus with the published SMRT desktop bundler and Tauri builder.
3. Verify local resume import, opportunity capture, application preparation,
   tailored PDF export, tracking and persistence.
4. Document installation/recovery and validate the installed artifact.

No hosted promotion, employer transmission, role rekey, or merge is authorized.
Optional external AI requires the owner's explicitly configured provider.

## Desktop packaging test design

| Behavior / invariant | Reachable trigger / positive | Negative / failure | Actor / executor | Runtime / external edge | Level / command |
| --- | --- | --- | --- | --- | --- |
| Coherent published dependency cohort | Frozen install resolves SMRT 0.62.1 | Missing exports or incompatible contracts fail build | Builder; N/A transaction: install only | Node 26, pnpm 11, published registry | Install; site build and narrow runtime specs |
| Self-contained production artifact | Stage then SMRT bundle/build with runtime files | Missing config/model/asset, foreign native or secret fails packaging | Local user; no application mutation while packaging | macOS arm64, bundled pinned Node, published builder | `pnpm desktop:bundle`, `pnpm desktop:build` |
| Local startup and ownership | Launch with empty data directory, claim local owner, health 200 | Missing launch secret denied, invalid schema startup fails closed | Sole local owner, framework SQLite initialization/lease | macOS Tauri webview and loopback HTTP | Published launch smoke plus installed app QA |
| Persistence and restart | Quit/relaunch retains SQLite and assets | Competing writer rejected; no hosted fallback | Same local owner; framework SQLite transactions | Stable user data root, no source checkout required | Disposable-directory startup/restart QA |
| Installation and recovery | Copy completed app to user Applications and open | Existing app is never silently replaced while running; clear recovery | User install; N/A database transaction: filesystem copy | macOS Finder/open | `pnpm desktop:install`; artifact inspection |

Evidence lives outside the repository under `/tmp/iolaus-desktop-evidence`.
Full documented validation and one review-cycle run on the integrated branch.

Compatibility probe: SMRT 0.62.1 declares SDK `^0.113.0`. Retaining direct
SDK 0.111.5 produced incompatible nominal OAuth issuer types; direct SDK
dependencies therefore align at 0.113.1, preserving PDF/OCR/spider specialty pins.
