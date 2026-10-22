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
