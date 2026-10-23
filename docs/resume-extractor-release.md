# Resume extractor release qualification

The release-image workflow builds site and extractor from one checked-out release
revision and frozen lockfile. Both candidates publish a BuildKit SBOM, maximum
build provenance and GitHub registry attestation. Both runtime images carry
`org.opencontainers.image.revision` and
`dev.happyvertical.iolaus.pnpm-lock.sha256`. Never deploy the mutable release or
candidate tags: consume the two immutable references from `resume-image-pair.json`
in the workflow artifact or release assets.

The release tags are assigned only after the extractor candidate's actual default
entrypoint passes `scripts/resume-extractor-candidate.mjs`. Failure leaves only
candidate tags; it does not publish release tags or a successful pair record.
A registry operation can fail between the two release-tag updates: the pair
record, not the presence of a tag, is the completion signal. A retry can publish
a new candidate digest, so preserve the exact pair used for qualification.

The executable probe uses Linux Docker, no published ports, network `none`, UID
10001, a read-only root, all capabilities dropped, no privilege escalation,
512 MiB memory without extra swap, one CPU, 64 PIDs and a 32 MiB noexec tmpfs.
It checks effective identity/capabilities/cgroup ceilings, denies root writes and
external connections, exercises the real health/default entrypoint and invalid
PDF child, rejects oversized input, expires an incomplete upload on the 75-second
production deadline, and checks disconnect cleanup and subsequent admission.
It removes the named candidate container on success or failure.

Run it against a built/published candidate (Linux cgroup v2 required):

```sh
node --test scripts/resume-extractor-release.test.mjs
node scripts/resume-extractor-candidate.mjs \
  ghcr.io/willgriffin/iolaus/resume-import-extraction@sha256:<digest> \
  <40-character-source-revision> <64-character-lock-sha256>
```

This probe does not establish valid PDF extraction, successful OCR, peak native
parser memory, oversized child output handling, child termination under a stuck
native parser, or Kubernetes network-policy enforcement. The image record says
`candidate-envelope-passed; production-integration-required` deliberately.
A registry attestation proves build identity, not safe parsing or vulnerability
clearance. Release publication does not authorize rollout.

Before IaC consumes the pair, the integration coordinator must record dated
commands, complete logs, fixture identities and both image digests for:

- Synthetic text PDF and cold scanned PDF through the real private upload,
  extractor, configured OCR and editable cited review within the 120-second bound.
- Parser deadline, disconnect during child execution, oversized/malformed output,
  memory/temp exhaustion, cleanup and retry; inspect process/cgroup evidence.
- Both images' attestations and SBOMs, vulnerability findings and disposition;
  source labels and lock hash must match the released pair.
- Actual namespace denial of extractor egress and unauthorized ingress; allow
  only declared web/worker clients. Docker network isolation is narrower proof.
- Durable private storage read after restart, scope/revocation/deletion fences,
  capacity and selective explicit import; no production candidate data in tests.
- Reviewed GitOps digest pins, deployment revisions, migration/status, actual
  workflow results and rollback preserving private assets. A placeholder digest,
  floating tag, health response alone or mocked test is insufficient.

## Behavior-to-test contract

| Invariant / trigger | Positive / negative | Actor, executor and runtime | Edge, level and command |
| --- | --- | --- | --- |
| Tagged release publication | Site/extractor share revision and lock; missing/mismatched provenance fails | Release workflow / GHCR and BuildKit / Linux; database N/A (image publication) | Workflow contract, `node --test scripts/resume-extractor-release.test.mjs`; real registry run required |
| Immutable candidate envelope | Exact digest starts under bounds; mutable input and wrong labels refused | Coordinator or CI / Docker / Linux cgroup v2; tenant N/A (fictional parser bytes) | Mocked orchestration contract plus real `node scripts/resume-extractor-candidate.mjs ...`; native execution required |
| Failure cleanup | Probe failure removes container; request timeout/disconnect releases temp and admission | Extractor / actual Node child and tmpfs / Linux | Contract test plus actual candidate probe; stuck native-child proof remains integration work |
| Rollout readiness | Exact pair plus dated native/security evidence; absent evidence blocks IaC qualification | Integration coordinator / registry, private storage, OCR and Kubernetes | Integration checklist above; no unit-test substitute |

The narrow contract tests run without containers. Their mocked Docker calls prove
orchestration and refusal behavior only. The base workflow had no extractor build
or gate; the workflow contract would fail against that base. Native image and
production qualification are pending until their actual commands pass.

## Runtime dependency hardening (2026-10-22)

Both final image stages refresh Debian's package index and upgrade only the
installed `perl-base` package before deleting apt indexes. The official
Bookworm security index publishes `5.36.0-7+deb12u4`, the fix for the scanned
`5.36.0-7+deb12u3` finding. Builds select the repository's available security
candidate rather than pinning an obsolete package archive; qualification must
record the resulting `dpkg-query -W perl-base` output and rescan both digests.

Both final stages remove `/usr/local/lib/node_modules/npm` and its `npm`/`npx`
launchers after installing runtime OS packages and creating the unprivileged
user. The old base's npm 11.19.1 carries vulnerable undici 6.28.0 independently
of the workspace lockfile. Removing the unused global npm closure removes this
copy without changing the application's separately pinned undici versions.
Build stages retain npm to install pinned pnpm. The site retains global pnpm
11.25.0 for operator migration/status commands; its default server and worker
entrypoints use Node and the installed tsx loader. Source inspection of
`scripts/smrt-app.mjs`, `scripts/daily-use-dev.mjs`, `scripts/smrt-worker.mjs`,
site migration/status scripts and worker bootstrap found no runtime npm/npx
invocation. `npm_execpath` in the app wrapper identifies a running pnpm process;
it does not invoke npm. The extractor runs its Node entrypoint and Node child
only, so its final stage needs neither npm nor pnpm.

| Invariant / trigger | Positive / negative | Actor, executor and runtime | Edge, level and command |
| --- | --- | --- | --- |
| Runtime OS remediation | Updated perl-base candidate; stale vulnerable version must fail image qualification | Image builder and release coordinator / apt and dpkg / Debian Bookworm, Node 26.10; data transaction N/A | Official security repository; source contract `node --test scripts/resume-extractor-release.test.mjs`, actual `dpkg-query -W perl-base` and digest scan required |
| Remove unused npm closure | npm directory and npm/npx commands absent; site pnpm 11.25 remains callable as UID 10001 | Runtime operator / Node and pnpm / Linux; no database mutation in version smoke | Global tool closure; Dockerfile build assertions plus actual image command smoke; wrong/missing pnpm fails retained version checks |
| Preserve extraction entrypoint | Node 26.10 remains present, extractor has no package-manager command; valid PDF extraction and malformed-input refusal remain required | Extractor UID 10001 / Node child / Linux; no application database transaction | Native parser and published dependencies; actual candidate envelope and PDF integration probes required |

Source-only contracts and manifest checks pass without building containers.
They do not establish that an image layer is free of vulnerable files. Before
publication, inspect the actual final filesystems, run the retained site pnpm
version and Node/tsx worker bootstrap smokes, exercise the extractor entrypoint
and benign text PDF, and scan both exact images. Runtime package installation
through npm/npx is intentionally unavailable; supported operator scripts use
pnpm. Native package/runtime behavior on Linux and the security repository's
availability remain actual-build qualification risks.


The qualified extractor dependency assessment is recorded in
[the supply-chain disposition](releases/resume-extractor-supply-chain.md). It
retains visible scanner findings and their feature-specific rationale; it is
not a clean-image assertion. Bind the final rebuilt image digest to its own scan
before rollout. The site image has a broader execution surface; its
[separate disposition](releases/resume-site-supply-chain.md) records the remaining
findings without claiming unrelated application features are certified.
