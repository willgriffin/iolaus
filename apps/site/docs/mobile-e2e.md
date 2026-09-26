# Mobile browser E2E

Test implementation: https://github.com/willgriffin/iolaus/issues/102

Open mobile defects: https://github.com/willgriffin/iolaus/issues/103

These tests exercise the built application, local owner authentication, SQLite,
and real Chromium rendering/touch input. The existing `test:browser` suite uses
happy-dom and does not provide this coverage.

## Test design

| Invariant | Trigger / positive case | Failure case | Context / data | Level / command |
| --- | --- | --- | --- | --- |
| CandidateProfile references use permitted query fields | Load task data with an candidate profile | SMRT rejects ordering on sensitive `CandidateProfile.name` | Real SMRT + SQLite, no raw SQL bypass | E2E setup health check; existing unit coverage |
| Authenticated routes load | Fresh owner session opens tasks, opportunities, applications, sources | HTTP failure or application error fails before mobile assertions | Isolated local owner; synthetic SQLite records | E2E: `pnpm test:e2e` |
| Navigation remains reachable | Tap header navigation, select Opportunities, reopen and close | No on-screen opener at mobile widths (audit M01) | Fresh browser context for each viewport; real shell | E2E, required pass |
| Task cards remain usable | At least 120 CSS pixels of card viewport, then swipe vertically | Zero/58px card viewport in landscape/small portrait (M02) | 16 fictional inbox tasks in the Intake & Decisions lane; local SQLite | E2E, required pass; short pages scroll the header out of the way |
| Board scrolls horizontally | Swipe across lane headers reveals later lanes | Touch gesture does not move board | Chromium CDP touch input; no DOM scroll assignment | E2E: `pnpm test:e2e` |
| Lane content passes horizontal swipes to the board | Swipe over lane content at usable sizes | Nested lane scroller traps horizontal touch input (M08) | Real pointer input; portrait and desktop control | E2E, required pass on every viewport |
| Settings overlay uses mobile width | Open account/settings drawer | Reserved desktop rail width clips mobile panel (M03, SMRT) | Local owner, real upstream shell | E2E, expected failure on mobile |
| Review actions remain on screen | Open fictional application review | Header actions overflow narrow viewport (M04) | Synthetic awaiting-review application | E2E, required pass |
| Filter controls fit | Open opportunity filters | Horizontal content overflow (M05) | Real form controls, no mocked layout | E2E, required pass with macOS and Linux fonts |
| Application stages remain legible | Render the five stage labels | Adjacent label bounds overlap (M06) | Fictional application | E2E, required pass |
| Footer chips remain visible | Render status footer | Chips extend past fixed footer bounds (M07) | Real shell footer | E2E, expected failure at narrow widths |
| Filters remain usable | Open filters, swipe to lower controls, close | Drawer traps scrolling or exceeds viewport | Real opportunity filters and synthetic records | E2E: `pnpm test:e2e` |

External services, PostgreSQL, OIDC and worker jobs are N/A: this suite targets
layout and gestures using the supported local runtime. There are no network
provider credentials, production records, or employer submissions. Browser
requests outside the local origin are blocked. Fixtures use application
collections, not mocked endpoints or direct SQL.

## Run

Use Node/pnpm versions from `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @willgriffin/iolaus-site exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:check
# Show all known regressions as ordinary failures:
IOLAUS_E2E_STRICT=1 pnpm test:e2e
```

The runner builds, migrates and seeds a fresh temporary local runtime, starts the built Node server
on a free loopback port, claims its fictional owner and shuts it down afterward.
It never uses an existing server, database or browser session. Do not run other
builds or E2E invocations concurrently in the same checkout. Auth state lives
outside the checkout and is removed with the runtime after shutdown. Setup logs
stay in that temporary runtime and are retained only if setup/cleanup fails.

Reports and failure screenshots/traces are under `apps/site/playwright-report`
and `apps/site/test-results`. These contain only fictional local data; do not
point the suite at production. Expected failures reference the audit IDs above;
Playwright treats an unexpected pass as a failure so the annotation must be
removed when fixing a regression. Strict mode is the baseline/fix verification
command, not the default CI command while known defects remain.

Projects: 390×844 Android portrait, 667×375 Android landscape, 320×568 narrow
portrait, and 1280×800 desktop control. Chromium device emulation is not proof on
a physical Android phone, Android WebView, or Safari. The suite covers M01–M08 plus navigation reload/resize and short-page toolbar scrolling. It does not cover every admin form or keyboard behavior. Font requests are blocked, so these
checks use local fallback fonts rather than depending on Google Fonts. Linux and macOS font metrics differ; filter sizing must pass on both. Gesture helpers wait for scrolling to settle before the next interaction, because a tap during kinetic scrolling can be consumed to stop the scroll.

The older checkout exposed a task-data HTTP 500 from sorting sensitive
`CandidateProfile.name`. Current main already fixes this by querying neutral
fields and sorting rendered labels; this test change preserves that solution.
The suite refuses to start if authenticated task data fails to load.

The legacy package `db:status` script assumes PostgreSQL and fails on SQLite
(`pg_tables` missing); tracked separately in [#104](https://github.com/willgriffin/iolaus/issues/104).
The harness uses the supported SMRT CLI migration/status commands for its local
runtime. No PostgreSQL schema or migration is changed.

## Recorded baseline

On macOS Chromium against current main (SMRT 0.51.16), strict mode executes 44 scenarios: 24 passed
and 20 failed on the tracked M01–M08 defects, with no skipped tests. These are
viewport/scenario counts, not 20 distinct bugs. Default mode marks precisely
those existing failures as expected; it must not be described as a clean mobile
UI audit. A passing annotation becomes an unexpected pass that fails CI. Linux additionally reproduces M05 at landscape and desktop drawer widths (22 expected failures across the same 44 scenarios).


## Mobile fixes (issue #103)

The app restores an always-reachable app-bar navigation toggle. Short task
viewports allow the page header and filters to scroll while keeping a useful
card area; vertical lane scroll containment no longer traps horizontal swipes.
Review actions stack on narrow screens, filter fields can shrink, and stage
labels stack vertically on phones at 400 CSS pixels or narrower.

The suite now runs 52 scenarios. With the existing released SMRT dependency,
47 pass normally and five remain explicit expected failures: M03 settings drawer
width (three mobile projects) and M07 footer clipping (two narrow projects).
The shared fixes belong to happyvertical/smrt#3156. Their annotations must be
removed when the upstream release is adopted; strict mode remains the full
acceptance gate. There is no downstream shell CSS patch or dependency override.

The combined app and candidate upstream components pass all 52 scenarios in
strict mode on macOS Chromium. This integration probe temporarily substitutes
the four built shell components for validation and restores the installed
package afterward; it is not a shipped dependency override. The upstream shell
suite also passes 37 geometry, long-content, and touch-scroll scenarios.
