# Self-hosted Kubernetes deployment

`deploy/self-hosted/` is an operator-owned Kubernetes topology for the
`self-hosted` s-m-r-t runtime. It deliberately does not contain a live host,
DNS zone, TLS issuer credentials, database URL, asset-storage credentials, or
candidate data. Local and managed-cloud profiles remain separate; do not use
these manifests for either one.

The checked-in topology is intentionally **not directly applicable**. Before
an isolated deployment, create a private operator overlay that replaces the
reserved ingress hostname and issuer, and replaces every image placeholder
with one released Iolaus digest. This prevents an accidental domain claim or a
mutable/unreleased image rollout from source control.

## Required operator-owned resources

Create these resources outside this repository, in the target namespace:

- `Secret/iolaus-runtime`: runtime configuration only, mounted by web and
  worker processes. It must include a unique, non-default `SMRT_APP_ID`, its
  matching dedicated PostgreSQL `DATABASE_URL`, `IOLAUS_PUBLIC_URL`, OIDC
  configuration, S3-compatible asset provider configuration (including
  `RESUME_FILES_CONFIG_JSON`), and the installed authentication/assets/secrets
  readiness module selectors required by the selected s-m-r-t providers. Add
  optional crawler, model, or submit-provider settings only after their
  independent approval and budgeting checks.
- `Secret/iolaus-migration-runtime`: migration-init configuration only. It
  contains the unique `SMRT_APP_ID`, a migration-owner PostgreSQL
  `DATABASE_URL`, and only the S3-compatible configuration required by the
  idempotent resume-asset backfill. It is not mounted by the monitor process
  and must not contain OIDC, crawler, model, or employer-submission values.
- `Secret/iolaus-monitor-runtime`: monitor-process configuration only. It
  contains the same `SMRT_APP_ID` and a distinct, read-only PostgreSQL
  `DATABASE_URL`; it must not contain OIDC, S3, model, crawler, or submission
  configuration. The monitor only projects aggregate `_smrt_jobs` and
  `source_crawls` state, so its role receives `CONNECT`, schema `USAGE`, and
  column-level `SELECT` only: `_smrt_jobs(queue, status)` and
  `source_crawls(status, started_at, finished_at)` (or protected views that
  expose only the documented aggregates). It receives no DDL, DML, ownership,
  role-management, OIDC, asset, crawler, model, or submission privilege.
- `Secret/iolaus-registry`: only when the selected immutable registry image
  requires it.

The self-hosted profile intentionally uses its released default
`s3-compatible` asset provider. Web, migrations, and workers read their
operator-owned external object storage configuration from their scoped runtime
secret; the monitor does not receive asset access. Configure
bucket/versioning/encryption/retention and independently verify object backup
and restore before importing any production asset. Do not substitute an
`emptyDir`, an image layer, or source-checkout path.

The secret is consumed with Kubernetes `secretRef` only. Do not add a
`Secret` manifest, sample token, endpoint, email address, or base64 value to
this repository. `SMRT_APP_ID` and the PostgreSQL database name must satisfy
Iolaus's hosted-database guard: the database must be named after that unique
application identity, not `iolaus`, `iolaus_dev`, or a predecessor database.

The released image runs as UID/GID `10001`; every workload applies
`runAsNonRoot`, drops Linux capabilities, uses the `RuntimeDefault` seccomp
profile, and has a read-only root filesystem. Each process receives only an
ephemeral `/tmp` volume (including Chromium cache paths); workers separately
receive their heartbeat `emptyDir`. No durable data or assets are writable in
the image filesystem. Verify these mounts in the isolated rehearsal by running
the web, a task worker, and the schedule worker under the rendered pod security
context before enabling a provider fixture.

## Workload topology

| Workload | Responsibility | Availability signal |
| --- | --- | --- |
| `iolaus-web` | Authenticated web/API/WebMCP surface | `/health` startup/readiness checks bounded deployed providers; `/live` is process liveness; two rolling replicas |
| `iolaus-task-worker` | Task execution, including provider crawl jobs | TaskRunner imports local classes and claims source-crawl, scheduled-source, intelligence, and approved-submit queues; it never polls schedules; its process heartbeat stays live through its four-minute drain |
| `iolaus-schedule-worker` | Due schedule dispatch; it creates provider-crawl task jobs but does not execute them | Process-local heartbeat probe and 90-second graceful drain |
| `iolaus-queue-provider-monitor` | Read-only aggregate queue and crawl-watchdog check | CronJob failure plus count-only JSON; independent of web health |

Every web and worker workload, including the queue/provider monitor, runs
`db:migrate` in an init container using only `iolaus-migration-runtime`. The
application's PostgreSQL advisory lock serializes that idempotent migration,
so parallel rollout cannot create concurrent schema writers. A failed
migration blocks that workload before it serves traffic, executes jobs, or lets
the read-only monitor query an incompatible schema.

Worker heartbeat files are held in per-pod `emptyDir` volumes and contain only
worker kind, time, and a ready state. They are not durable application data.
The liveness probe rejects a process whose event loop can no longer refresh its
own heartbeat; pod running status alone is not accepted as worker health.

The monitor emits only queue/status counts and source-crawl aggregates. Its SQL
never selects crawl identifiers, URLs, errors, or payloads; bind its reader role
to protected aggregate-only views where supported, otherwise grant the exact
column-level `SELECT` contract above. It fails on stale or timed-out
provider work. Alert from the cluster's job-failure
metric and retain its logs under the deployment's normal restricted log policy.
Establish queue-depth and provider-error alert thresholds from the isolated
rehearsal; they are intentionally not guessed in the generic manifest.

## Private overlay and isolated verification

Use a private overlay or the deployment system's protected values mechanism.
It must replace all of the following before an apply:

1. `REPLACE_WITH_RELEASED_IMAGE_DIGEST` with one published
   `ghcr.io/willgriffin/iolaus/site@sha256:<digest>` image. Do not use a tag,
   local framework checkout, or a locally built unpinned image.
2. `iolaus.example.invalid` and `iolaus-self-hosted-cluster-issuer` with the
   isolated environment's host and existing issuer. This is the only path that
   adds a real hostname; it must be reviewed outside this repository.
3. Namespace, registry pull secret, resource sizing, and S3 provider settings
   if the verified target environment requires different values.

Validate repository topology before rendering the private overlay:

```sh
pnpm deploy:self-hosted:check
kubectl kustomize deploy/self-hosted/production
```

Then, from an authorized isolated-cluster context only, validate the rendered
private overlay and wait for each workload separately:

```sh
kubectl apply --dry-run=server -k /private/path/to/iolaus-overlay
kubectl apply -k /private/path/to/iolaus-overlay
kubectl -n <isolated-namespace> rollout status deployment/iolaus-web
kubectl -n <isolated-namespace> rollout status deployment/iolaus-task-worker
kubectl -n <isolated-namespace> rollout status deployment/iolaus-schedule-worker
kubectl -n <isolated-namespace> get jobs -l app.kubernetes.io/component=queue-provider-monitor
```

Run `pnpm --filter @willgriffin/iolaus-site db:status` in a short-lived,
authorized diagnostics pod after migrations. Verify an authenticated web
session, generated APIs and WebMCP inventory separately; the public health
endpoint never proves authentication, permissions, redaction, or worker state.
Restart a worker pod and verify its heartbeat returns before testing a
synthetic, explicitly approved provider-crawl fixture. Restart a web pod and
verify a synthetic non-production asset remains readable from the same
operator-owned object store.

### Parity contract and evidence

Before building an image, run the deterministic source contract under the
pinned Node and pnpm versions:

```sh
pnpm parity:contract -- --evidence /private/evidence/iolaus-parity.json
```

The command runs the reviewed generated REST/MCP/WebMCP inventory, route
authentication, field-projection, triage/bulk workflow, approval-boundary,
provider-crawl, task/schedule worker, retry/fencing/recovery, heartbeat, and
self-hosted topology scenarios. It writes only exact source and dependency
digests, inventory counts, scenario names, binary observables, and pass/fail
state. Test fixtures are synthetic; the report contains no record bodies,
credentials, URLs, database targets, or asset paths. Inventory drift fails
closed until `apps/site/scripts/deployed-parity-inventory.snapshot.json` is
reviewed and explicitly regenerated with:

```sh
pnpm --filter @willgriffin/iolaus-site exec tsx \
  scripts/deployed-parity-inventory.ts --update
```

The runner discards the caller's database, provider, and credential
environment, creates a temporary home/config/cache boundary, and installs a
deny-by-default outbound network hook for every parity scenario. It removes any
existing destination report before validation begins, so a failed rerun cannot
leave stale passing evidence behind. The approval-boundary scenario directly
exercises refusal behavior for every registered ATS submitter. The only reused
caller cache is Corepack's already-installed, pinned pnpm distribution; network
installation remains denied. Unit scenarios deliberately use the local runtime
with a temporary home so no deployed database or provider can be selected; the
separate topology scenario validates the self-hosted workload profile.
Every scenario also runs beneath an inherited operating-system network
boundary: macOS `sandbox-exec` denies remote IP sockets while retaining local
Unix-domain IPC, and Linux uses an unshared network namespace. The command
fails closed when neither isolation backend is available.

This source-only report is explicitly marked `releaseEligible: false` and
`candidateImageTested: false`. It is a pre-build check, never release evidence.

Pull-request CI also builds the exact checked-out revision without publishing
it and runs the contract against Docker's immutable local `sha256` image ID.
That report proves the built image passed the containerized scenarios and is
uploaded as a secret-free workflow artifact, but remains
`releaseEligible: false`: a local image ID is not a released repository digest.
The `--local-image-id` option exists only for that non-release verification and
rejects tags and mutable references.

The build sets `SMRT_APP_ID=iolaus-build` because SvelteKit imports server
modules during route analysis, including the hosted profile's non-default
identity guard. Omitting it causes the build to stall during those imports.
This synthetic identity exists only in the build stage: the `runner` starts
from `base` and does not inherit it. Deployed workloads must receive their
unique operator-owned `SMRT_APP_ID` through runtime configuration. No build
identity or synthetic database is a production configuration default.

Candidate CI runs this build under a one-shot watchdog. If it is still running
after three minutes, CI records bounded diagnostics only for Node/Vite processes
whose working directory is exactly `/app/apps/site`: a short native backtrace
when `gdb` is available, or `/proc` CPU, RSS, state, and wait-channel fields as
a fallback. It does not read process arguments or environments, inspect
unrelated processes, or change the build's exit status.

For pull requests, candidate CI checks out the pull request head revision and
uses that same revision for the image provenance label, evidence assertion, and
artifact name. Pushes use `github.sha`. This exact revision binding is required
because the default pull-request `github.sha` can identify GitHub's synthetic
merge commit rather than the candidate source.

Candidate image builds must set `IOLAUS_SOURCE_REVISION` to the exact
40-character Git revision and `IOLAUS_LOCKFILE_SHA256` to the SHA-256 of
`pnpm-lock.yaml`.
The Dockerfile stores both as OCI labels. For a released candidate, check out
that exact source revision, pull the immutable digest locally without retagging
it, run the same contract, and pass that digest:

```sh
pnpm parity:contract -- \
  --image-ref ghcr.io/willgriffin/iolaus/site@sha256:<64-hex-digest> \
  --evidence /private/evidence/iolaus-parity.json
```

The image argument is accepted only when `docker image inspect` proves that the
local image has the requested repository digest and its two provenance labels
match the current source revision and lockfile digest. Runtime parity scenarios
and the inventory then run from that immutable image with Docker networking
disabled, a read-only root filesystem, dropped capabilities, no-new-privileges,
and a synthetic local runtime environment. The disposable `/tmp` mount allows
the test runner to regenerate derived SMRT artifacts without mutating the
image. The inventory resolves the installed s-m-r-t package versions and
requires them to equal the released, pinned declarations.

`candidateImageTested: true` proves only those explicitly image-executed
scenarios. The topology check remains host-executed with the same sanitized
environment and OS network boundary because the runtime image deliberately
contains no cluster administration tools. Its check record says
`execution.kind: "host"`; candidate-image records say
`execution.kind: "candidate-image"`. Therefore every contract report remains
`releaseEligible: false`: a distinct isolated deployment report must bind the
same digest to actual web, task, schedule, and monitor workloads before any
release or cutover decision.
As a prerequisite for later deployment release evidence, the runner also
fingerprints every tracked source file included by the Docker context and
requires the candidate's bytes to match the clean reviewed checkout exactly.
Host-reviewed code streams the Docker-export TAR archive, verifies every header
checksum and terminating block,
rejects unsafe/ambiguous PAX names, duplicate normalized application paths, and
any link or non-regular entry at a reviewed source path or its ancestors, then
hashes only the raw regular-file bodies. It never dereferences a
candidate-controlled path on the host. The candidate inventory is executed
only after those reviewed source bytes match and must match the independently
executed host inventory, including installed pinned s-m-r-t versions.
The report records only already-known digests, versions, and pass/fail facts.
It is not a substitute for checking Kubernetes
`status.containerStatuses[].imageID`. The isolated
rehearsal must prove every web/task/schedule pod reports that same digest,
capture a successful aggregate monitor Job, and execute the synthetic browser
smoke, provider crawl, schedule dispatch, active-job drain, and restart
recovery against the deployed PostgreSQL instance. Record only IDs hashed for
the rehearsal, counts, terminal states, timestamps, and digests. A green web
health endpoint or source contract alone does not satisfy those deployed
checks. Production remains read-only until its separate write checkpoint is
approved.

## Operational safety

Do not enable provider crawling, paid intelligence, or external submission as
part of this topology rollout. Provider configuration and budgets are explicit
deployment inputs, and employer transmission retains the application's human
approval boundary.

For a drain, first stop creating new source work with the application control
described in `docs/employment-workflows.md`, then allow task jobs to reach zero
before scaling the task worker down. The task pod has a 270-second grace period:
its three-minute crawl ceiling and four-minute TaskRunner drain budget ensure a
SIGTERM stops claiming new jobs before Kubernetes can kill active work. Rehearse
that SIGTERM path with a bounded non-production job before rollout. Do not scale
down both worker deployments
as a substitute for a migration or a rollback. Rollback is a traffic and
worker-fleet decision owned by the cutover runbook; this topology neither
changes DNS/TLS nor decommissions a predecessor deployment.
