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

- `Secret/iolaus-runtime`: runtime configuration only. It must include a
  unique, non-default `SMRT_APP_ID`, its matching dedicated PostgreSQL
  `DATABASE_URL`, `IOLAUS_PUBLIC_URL`, OIDC configuration, S3-compatible asset
  provider configuration (including `RESUME_FILES_CONFIG_JSON`), and the
  installed authentication/assets/secrets readiness module selectors required
  by the selected s-m-r-t providers. Add optional crawler, model, or
  submit-provider settings only after their independent approval and budgeting
  checks.
- `Secret/iolaus-registry`: only when the selected immutable registry image
  requires it.

The self-hosted profile intentionally uses its released default
`s3-compatible` asset provider. Web, migrations, workers, and monitoring read
the same operator-owned external object storage configuration from the runtime
secret. Configure bucket/versioning/encryption/retention and independently
verify object backup and restore before importing any production asset. Do not
substitute an `emptyDir`, an image layer, or source-checkout path.

The secret is consumed with Kubernetes `secretRef` only. Do not add a
`Secret` manifest, sample token, endpoint, email address, or base64 value to
this repository. `SMRT_APP_ID` and the PostgreSQL database name must satisfy
Iolaus's hosted-database guard: the database must be named after that unique
application identity, not `iolaus`, `iolaus_dev`, or a predecessor database.

## Workload topology

| Workload | Responsibility | Availability signal |
| --- | --- | --- |
| `iolaus-web` | Authenticated web/API/WebMCP surface | `/health` startup, readiness, and liveness probes; two rolling replicas |
| `iolaus-task-worker` | Task execution, including provider crawl jobs | Process-local heartbeat probe and 90-second graceful drain |
| `iolaus-schedule-worker` | Due schedule dispatch; it creates provider-crawl task jobs but does not execute them | Process-local heartbeat probe and 90-second graceful drain |
| `iolaus-queue-provider-monitor` | Read-only aggregate queue and crawl-watchdog check | CronJob failure plus count-only JSON; independent of web health |

Every web and worker workload runs `db:migrate` in an init container. The
application's PostgreSQL advisory lock serializes that idempotent migration,
so parallel rollout cannot create concurrent schema writers. A failed
migration blocks that workload before it serves traffic or executes jobs.

Worker heartbeat files are held in per-pod `emptyDir` volumes and contain only
worker kind, time, and a ready state. They are not durable application data.
The liveness probe rejects a process whose event loop can no longer refresh its
own heartbeat; pod running status alone is not accepted as worker health.

The monitor emits only queue/status counts and source-crawl aggregates. It
fails on stale or timed-out provider work. Alert from the cluster's job-failure
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

## Operational safety

Do not enable provider crawling, paid intelligence, or external submission as
part of this topology rollout. Provider configuration and budgets are explicit
deployment inputs, and employer transmission retains the application's human
approval boundary.

For a drain, first stop creating new source work with the application control
described in `docs/employment-workflows.md`, then allow task jobs to reach zero
before scaling the task worker down. Do not scale down both worker deployments
as a substitute for a migration or a rollback. Rollback is a traffic and
worker-fleet decision owned by the cutover runbook; this topology neither
changes DNS/TLS nor decommissions a predecessor deployment.
