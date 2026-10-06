# Private skill discovery UI — issue #161

This local daily-use work exposes explicit discovery and per-proposal review. Discovery never adds a resume skill. Confirming a proposal is a separate native owner action. Public resume publication is separate.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Test level / command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Verified subject on reads and actions | Open page; discover; confirm; dismiss | Selected active workspace reaches native service | Missing/inactive/foreign membership denies before service; submitted ownership ignored | Candidate owner / selected profile | Backend native fence; UI has no database executor | SvelteKit Node; SQL N/A: service owns persistence | Missing locators handled by service | Route Vitest in isolated snapshot |
| Review before adding | Discover button; proposal cards | Evidence, confidence meaning, canonical label visible; explicit per-item confirm | Unknown and duplicate proposals never offer add; failures show error without success | Verified owner | Backend owns atomic confirmation and idempotency | Browser / SSR | Discovery/provider failure rendered safely | Route + SSR Vitest |
| Direct versus introductory | Review proposal | Plain labels and attributable evidence; introductory wording cannot claim production depth | Unknown is unresolved, not proof of absence | Verified owner | N/A: display only | SSR + client | Unknown enum/type constrained by backend contract | SSR + browser Vitest |
| Canonical identity and alias | Review proposal | Canonical label/alias and existing duplicate visible | Browser sends opaque proposal locator only, never label/evidence/ownership | Verified owner | Backend canonical duplicate recheck owns transaction | Browser; SQL N/A | Stale revision rejected by native service | Route + browser Vitest |
| Mobile and accessible save feedback | Submit one review action | Semantic headings, full-width cards, disclosure evidence, status/pending controls | Double submission cancelled; failure leaves proposals reviewable | Browser owner | N/A: progressively enhanced form | Browser + root live mobile QA | Network/action failure | Browser Vitest; root live QA |

No paid provider calls, migration, real database mutation, daily generated-file check, or runtime restart is part of automated UI validation. Root performs authorized live QA; backend worker covers authority, durable preservation, duplicate checks and provider governance.

## Current executable UI evidence

- Isolated SSR and route suites: 17 tests passed; `/tmp/skill-discovery-ui-161-ssr.log`.
- Isolated progressive browser suite: 3 tests passed; `/tmp/skill-discovery-ui-161-browser.log`.
- Root shared/parser, resume-data, screening service regression suites: 66 tests passed in an independent full snapshot; `/tmp/skill-discovery-161-root-tests.log`.
- Tests execute copied UI/route sources with mocked native service responses and no provider calls. Native persistence/governance requires the separate backend suite; real visual/mobile verification belongs to root live QA.
- Complete discovery disables its start button. Partial discovery offers Continue skill discovery and partial-aware success feedback. Case/punctuation-only canonical normalization does not display as an alias; meaningful alias identity remains visible.
- Final combined isolated root/backend/UI SSR+route run: 7 suites, 149 tests passed; `/tmp/skill-discovery-161-combined-tests.log`. Browser suite remains 3 tests passed separately. The combined snapshot includes the stable discovery backend and root career evidence integration.
- Final combined isolated Svelte check: 0 errors and 0 warnings, after the backend classification annotation and pre-existing JEV experiment version annotation; `/tmp/skill-discovery-161-combined-check.log`. No daily generated artifacts were touched.
- After accepted native-fence/onboarding preservation fixes and live navigation feedback: combined 8 suites, 168 tests passed; Svelte check remains 0 errors and 0 warnings. Back to resume targets `/admin/career`; skill-discovery breadcrumbs show Resume → Discover skills. Existing evidence paths above now hold this latest run.
