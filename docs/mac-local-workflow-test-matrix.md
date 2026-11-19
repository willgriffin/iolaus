# Mac local workflow test design (#310)

Recorded before implementation. Risk: standard; local PDF reading changes the execution boundary, not ownership or schema.

| Behavior/invariant | Reachable trigger | Positive | Failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local native PDF text stays in process | Owner uploads resume in local runtime | SDK reads synthetic two-page PDF, citations preserved | malformed, >20 pages, >120k chars, revoked authorization; no HTTP/Docker | verified owner; authorize before read | N/A read only; host retains apply transaction | Node/macOS; SQL N/A | SDK unpdf, OCR disabled | integration/unit | site vitest local-resume-pdf.spec.ts |
| Local no-AI import remains useful and private | Upload without AI profile | reviewable summary proposal, user edits before apply | blank/scanned PDF explains manual entry; no OCR/network | verified owner | ingestion host persists/reviews/applies using existing transaction | local SQLite | AI/OCR never called in local manual mode | unit + desktop acceptance | site vitest local-resume-import.spec.ts; e2e desktop-mvp harness |
| Existing hosted extraction remains isolated | hosted upload | HTTP/Docker unchanged | existing malformed/cancellation bounds | verified workspace | existing host apply transaction | Node/PostgreSQL | extractor | regression | site vitest resume-import-pdf-client.spec.ts resume-import-extraction.spec.ts |
| Profile, capture, prepare/export, tracking survive restart | installed app manual daily flow | synthetic profile/job/application/status visible after relaunch | foreign tuple denied; invalid fields rejected | local owner and foreign ownership fixtures | native SMRT SQLite writes | installed Mac/local SQLite | PDF SDK system Chromium; no employer submission | existing unit + desktop e2e | desktop-mvp create/verify harness (integration owner) |

No new schema or mutation executors are introduced. Existing domain/route suites provide apply atomicity and ownership coverage; installed-app acceptance is required before claiming end-to-end readiness.

## Narrow validation (2026-11-19)

Node 26.12.1, SMRT 0.62.1, SDK PDF 0.66.0: 8 files / 116 tests passed. From `apps/site`:

```sh
node node_modules/vitest/vitest.mjs run src/lib/components/admin/ResumeImport.spec.ts src/lib/server/local-resume-pdf.spec.ts src/lib/server/local-resume-pdf-limits.spec.ts src/lib/server/local-resume-import.spec.ts src/lib/server/resume-import-pdf-client.spec.ts src/lib/server/resume-import-extraction.spec.ts src/lib/server/resume-import-domain.spec.ts src/lib/server/resume-import-host.spec.ts
```

Synthetic fixtures use the SDK's browser-free Markdown PDF generator. They verify real native PDF extraction, distinct page boundaries, >20-page rejection, malformed/empty/oversized/cancelled PDFs, revoked authorization, no `fetch`, blank-page guidance, no-AI manual proposal, and local/hosted consent text. The mocked provider test covers >120k expanded text. Existing host/domain suites cover foreign ownership and transactional apply. Base behavior is concretely broken: local upload selects Docker/HTTP and, without AI, returns no entries; the new integration expectations require the native reader and manual summary. The new module has no base implementation to execute directly. UI regression was observed failing when the local flag was not passed.

Biome checks passed with five pre-existing warnings in the extraction module (non-null assertions and provider contract naming). `git diff --check` passed. Full validation and installed-app restart evidence belong to the integration owner; this narrow run does not claim them.

## Integrated gap follow-up

| Behavior/invariant | Reachable trigger | Positive | Failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local material preparation does not implicitly invoke AI | Generate packet with default resume and no cover letter | packet PDF prepared, no planning/writing client invocation | hosted planning remains covered by existing tests; ownership/lifecycle lock assertions remain | verified local owner | existing lifecycle transaction and conditional artifact commits | Node/macOS SQLite (unit executor stand-ins) | SDK PDF; no implicit AI | unit | vitest run src/lib/server/application-package.spec.ts |
| Upstream collection DOM contract and parity release pins are current | SSR list; inventory check after dependency upgrade | stable CollectionList data attribute; dependency snapshot regenerated | full surface projection equality retained | N/A no actor/mutation | N/A read only | Node | SMRT0.62.1 | unit | vitest run src/lib/components/admin/OpportunityCardList.spec.ts scripts/deployed-parity-inventory.spec.ts |
| Triage timing checks behavior without timing module loading | prefetch-size test | server module loaded in suite setup before per-test timer | assert prefetch does not exceed server queue size | N/A pure assertion | N/A no mutation | Node | server import graph | unit | vitest run src/lib/admin/triage-session.spec.ts |

No-AI preparation concern was real: the prior unconditional planning call could contact a provider despite manual material modes. Local generation now retains the user's existing plan; explicit generated material modes keep their existing writing gates. Three narrow suites passed 97 tests on Node26.12.1; cold imports took ~26s collectively, confirming the previous 5s *per-test dynamic import* bound was testing import load, not triage behavior. The inventory's entire `surfaces` projection is byte-for-byte equivalent after regeneration; only dependency identities/digests change.

Root Docker-boundary failure is external: Docker context `kiri`, Kiri0.2.1 engine27.5.1 rejects a valid synthetic tar with `docker import - iolaus-import-diagnostic:310`: `Error response from daemon: invalid image reference:`. No containers were started. The tests retain their assertions and now capture stderr, making the blocker visible. No skip/gate relaxation was added.

## Explicit local projection setup (#310 live acceptance repair)

| Behavior/invariant | Trigger | Positive | Failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Explicit setup installs application-owned matching projections | app:setup prepareDatabase after native migration | fresh SQLite can read matching results, repeated setup preserves data | installer failure rolls back projection changes | local operator; writer lease held | supplied native runtime db; existing owning matching migration transaction | Node26/macOS SQLite | public runtime prepareDatabase + existing projection migrator | integration | vitest run src/lib/server/local-application-schema.spec.ts |
| Startup never repairs missing projection schema | app:start readiness | prepared SQLite ready across reopen | missing projection tables produce setup recovery, with no DDL | local runtime | supplied db, read only | Node26/macOS SQLite | matching readiness API | integration + existing runtime tests | vitest run src/lib/server/local-application-schema.spec.ts src/lib/server/application-runtime.spec.ts |

Live baseline: authenticated opportunities list and newly captured job detail both fail `SQLITE_ERROR: no such table: matching_results`; 241 native tables exist but zero matching projection tables. Native packaging initialization is a separate blocked requirement until it invokes this same explicit application preparation lifecycle; ordinary startup must not hide the omission with lazy DDL.

Validation: Node26.12.1, `node node_modules/vitest/vitest.mjs run src/lib/server/local-application-schema.spec.ts src/lib/server/application-runtime.spec.ts` from `apps/site`: **9 tests / 2 files passed**. The disposable file fixture uses the same secure `node:sqlite` SDK driver as the local runtime, copies only synthetic native input-table DDL, verifies ordinary startup refuses missing projections without creating them, verifies actual empty opportunities count after preparation, preserves progress through repeated preparation and database reopen, and proves projection DDL rolls back on missing native input. Tooling-only `tsx/esm/api` import of the setup module also succeeds under Node26. Explicit setup keeps framework migration in its existing subprocess and passes the already-held native runtime executor to the application step; no new live database connection is opened by that step. Native framework migration and application projection installation are separate transactions; the projection install itself is atomic. End-to-end acceptance remains pending documented app:setup/app:start on the preserved synthetic workspace.

## Explicit private default resume selection (#310 live acceptance repair)

| Behavior/invariant | Trigger | Positive | Failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Private selected resume takes precedence over published fallback | Create default-resume draft; generate packet with empty attachment | exact active candidate root's selected private resume attaches without publication | selected asset under another profile/user/tenant or wrong asset type is refused; no fallback conceals invalid selection | verified workspace subject and matching root/asset tuples | draft native lifecycle transaction; packet existing lifecycle lock/conditional commit | Node/macOS SQLite runtime, unit real domain guards with stand-in collections | no public publishing/employer submission | regression | vitest run src/lib/server/application-package.spec.ts |

Live UI confirms selected resume and application share current candidate owner+tenant; the bootstrap profile is a different tuple. Both default draft resolution and packet fallback currently ignore CandidateProfile.resumeAssetId and only search isPublished assets. This is a product defect independent of repeated synthetic workspace runs.

Validation: the six new selected-private regression cases fail against the prior resolver (two missing attachments, four invalid selections accepted). After the fix, `node node_modules/vitest/vitest.mjs run src/lib/server/application-package.spec.ts src/lib/server/private-workspace.spec.ts` from `apps/site` passes **64 tests / 2 files** on Node26.12.1. Tests cover private choice ahead of published fallback, existing empty default draft preparation without AI, and separate cross-profile, cross-user, cross-tenant and wrong-material refusals. Draft selection uses its lifecycle transaction executor explicitly. Existing published fallback and application-owned selected-material behavior remain covered.
