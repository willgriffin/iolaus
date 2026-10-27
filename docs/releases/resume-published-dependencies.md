# Resume dependency release closure

## Current adoption baseline (#236, 2026-10-26)

The active published closure uses SMRT **0.57.32** and standard SDK **0.108.0**.
OCR moves to **0.62.1**, the minimum required by ingestion's `^0.62.1` range.
PDF **0.66.0**, spider **1.1.11**, animation **0.5.0** and Sharp **0.35.5** remain
unchanged. All 57 first-party active lock identities, including independently
versioned spider, have exact overrides and registry metadata records in
`vendor/release/published-closure.json`. The verifier rejects an unrecorded
first-party transitive identity.

Normal and frozen pnpm installation, all six closure verifier contracts, and
public ESM imports for core migrations, SQL, auth/server, PDF, OCR,
ingestion/server and spider pass with Node **26.12.1** and pnpm **11.25.0**.
`DeploymentPhaseTracker` imports from `@happyvertical/smrt-core/migrations`.
Registry SHA-512 integrities match the frozen lock; installed versions match
the closure records.
Observed source references are SDK `v0.108.0` at
`82f860d056251d89376844827fa573639f856273` and SMRT `v0.57.32` at
`ce94e5805d8cd159a84c9d615b4cd2a2779ca0ab`; registry metadata supplies no
`gitHead` or build attestation.

The existing coordinated override policy still supersedes historical ranges
from independent packages: PDF requests utils `^0.80.1` and OCR `^0.61.1`; OCR
requests ai/utils `^0.80.0`; spider requests cache/utils `^0.74.8`; ingestion
requests PDF `^0.65.9`. The standard SDK satisfies SMRT's new `^0.108.0`
minimum. These import and identity checks do not qualify every downstream
runtime behavior. Full integrated tests and deployment qualification belong to
#236; the historical evidence below does not qualify the new baseline or a
production rollout.

## Historical resume release (#223)

The resume production train (#223) consumed published SMRT **0.55.19** and SDK
**0.103.5**, with PDF **0.66.0**, OCR **0.61.6**, Sharp **0.35.5** and animation
**0.5.0**. All coordinated packages use exact registry versions and workspace
overrides; ingestion's SMRT siblings remain on the same release. SDK 0.103.4 was
not selected because its auth archive lacks the `./server` export used by Iolaus.
The first compatible published auth candidate is 0.103.5. This is a bounded
release selection rather than an upgrade to the newest SMRT/SDK release.

`vendor/release/published-closure.json` is the active dependency record. It
captures registry tarball URLs, SHA-512 integrity and SHA-1 registry metadata,
plus independently observed SDK/SMRT source tag commits. The registry supplied
no `gitHead` or build attestation: tag references are source context, **not proof
that a tarball was built from that commit**. Frozen pnpm installation verifies
registry archive integrity. Runtime tests qualify installed consumer behavior.

Run `node scripts/verify-published-closure.mjs` after a frozen install to verify
exact overrides, direct versions, lock integrities and all active package
identities. The self-hosted manifest check runs this verification as well.
Unreachable historical directories in pnpm's virtual store do not belong to the
active frozen graph. Historical local archives, their source closure and the
compatibility-repack verifier remain for audit/reproduction; current manifests
and deployment checks no longer consume them. Their older qualification claims
do not qualify this release.

Narrow qualification covers installed native ingestion lifecycle, local OAuth
session-backed authorization/revocation and replay rejection, SDK server imports,
PDF/OCR/Sharp native imports, and the release verifier's integrity/version failure
paths. Full integrated validation and release qualification belong to the train
coordinator and are recorded on its pull request; this document does not declare
a production rollout.

## Bounded advisory remediation (2026-10-22)

The workspace additionally pins the following published transitive versions with
major-qualified override selectors. They preserve the existing major lines;
PDF's exact upstream `6.1.200` pin is deliberately superseded here pending an
upstream PDF release. These overrides qualify the downstream frozen graph, not a
new upstream compatibility guarantee. The Vite catalog moves to **8.1.6**; the resolved Vite peer closure uses
esbuild **0.28.2**. Browserslist's updated minimum dependency ranges also refresh
its four browser-release datasets in the lockfile.

| Package | Qualified version |
| --- | --- |
| pdfjs-dist | 6.2.108 |
| proxy-addr | 2.0.8 |
| undici | 7.29.1 and 8.10.2 |
| axios / follow-redirects | 1.20.0 / 1.16.1 |
| fast-uri / ip-address | 3.1.7 / 10.3.1 |
| nanoid / http-cache-semantics | 3.3.18 / 4.3.0 |
| brace-expansion | 2.1.6 and 5.0.11 |
| postcss / source-map-js | 8.5.18 / 1.2.2 |
| browserslist / figlet / vite | 4.28.7 / 1.11.3 / 8.1.6 |

Registry metadata confirmed every target exists and its declared Node engine
supports Node **26.10.0**. Frozen installation under Node 26.10.0/pnpm 11.25.0
and the 56-package closure verifier pass. PDF API and worker resolve from the
same installed `pdfjs-dist@6.2.108` directory. The real extraction worker returns
one text page containing the fictional Alex Example resume, with no OCR needed;
malformed PDF bytes exit with code 65 and no output. PDF, OCR, auth/server and
ingestion/server imports and Sharp's native PNG encode/decode pass on macOS
arm64. The closure verifier's five rejection/positive contracts pass. The two
parity inventory contracts pass after updating only the lockfile and inventory
hashes; exposed surfaces and first-party identities are unchanged. Integrated
suite and Linux image qualification remain the train coordinator's work.

The behavior-to-test contract for this dependency-only patch is:

| Invariant / trigger | Positive and failure evidence | Context / executor / runtime | External edge / level / command |
| --- | --- | --- | --- |
| Install/deploy preserves published identity | Frozen install and closure verifier pass; integrity, incompatible-copy, local-repack and stale-link rejection tests pass | Build actor; no application transaction; Node 26.10/pnpm 11.25 | npm archive integrity; contract; `pnpm install --frozen-lockfile`, `node scripts/verify-published-closure.mjs`, `node --test scripts/verify-published-closure.test.mjs` |
| Uploaded PDF uses aligned parser/worker | Benign fictional text preserved; malformed input exits 65 without output | Extraction worker, OCR disabled; parser only; Node 26.10/macOS arm64 | PDF API/worker; integration; `node apps/site/scripts/resume-import-extraction.mjs --worker <fixture.pdf> <output.json>` |
| App initialization keeps native imports | PDF/OCR/auth/ingestion import and Sharp PNG roundtrip; no native implementation change requiring new failure injection | App actor; no transaction; Node 26.10/macOS arm64 | Published exports/native ABI; import smoke |
| Generated deployment identity remains reviewable | Inventory and generated manifest agree; private-surface exclusions pass | Tooling actor; no transaction; Node 26.10 | Discovery inventory; contract; `pnpm --filter @willgriffin/iolaus-site exec vitest run scripts/deployed-parity-inventory.spec.ts` |

The production audit after this patch reports **62 advisory records**: 0
critical, 16 high, 43 moderate and 3 low, compared with the prior 134 records
(1 critical, 55 high, 68 moderate, 10 low). Counts describe advisory records,
not independent reachable vulnerabilities. High residuals are MCP v1/v2,
Nodemailer 7, adm-zip 0.5 and braces 3.0.3. MCP requires upstream request/input
bounds as well as dependency updates; Nodemailer crosses majors and adm-zip
crosses a 0.x minor. Braces has no advisory fix. Remaining moderate/low records
also require separate assessment; this patch does not establish a clean audit
or qualify all affected network features. The old extractor image additionally
contains npm's bundled undici 6.28.0 at
`usr/local/lib/node_modules/npm/node_modules/undici/package.json`; no undici 6
occurs in this workspace lock, so its remediation belongs to base-image/npm
qualification and cannot be achieved by a workspace override.

Upstream remediation is tracked in
[SMRT #4175](https://github.com/happyvertical/smrt/issues/4175) for MCP request
and validation limits, and [SDK #1447](https://github.com/happyvertical/sdk/issues/1447)
for compatible mail/archive adapter updates. These are not parser execution
features; the site's broader runtime exposure must be assessed separately from
the isolated extractor's feature-specific dispositions.
