# Iolaus maintenance adoption preparation (#236)

Rollout is **held**. `deploy/self-hosted/adoption/` is unreferenced by both active
Kustomizations. The new manual qualification workflow cannot publish an image,
change GitOps, merge a PR, or reach an existing cluster. Active init-container
migration guards remain in the existing topology until separately authorized
ownership transfer and rollout.

## Public prerequisites

`deploy/self-hosted/adoption/prerequisites.json` pins the public chart 0.2.1 OCI
manifest, packaged chart SHA256 and runner Git commit from
[the verified SMRT #4433 publication](https://github.com/happyvertical/smrt/issues/4305#issuecomment-6473305779).
Anonymous registry and Helm pulls verified both digests, all packaged source
files and phase renders; the public runner source matches the reviewed bytes.
Chart 0.1.0 cannot supply the required security envelope or observer projection.
Chart 0.2.0 rejects the required migration settings `SMRT_RUNTIME_PROFILE` and
`SMRT_APP_ID`; 0.2.1 permits exactly those application settings while keeping
release identity names reserved. The workflow derives both the pull version and
archive path from the validated prerequisite record; unsupported versions fail
before environment export.
These prerequisite identities enable qualification, not installation or rollout.
The already pinned Kind node, PostgreSQL and maintenance responder images are
reused from the upstream disposable exercise; they are platform-resolved and
verified before use.
No unpublished worktree supplies CI code. The public runner checkout must have
its exact approved origin, revision and clean tree. OCI manifest bytes must hash
to their requested digest and bind the packaged chart layer bytes.

The image inputs must be published `ghcr.io/willgriffin/iolaus/site@sha256:…` and
`ghcr.io/willgriffin/iolaus/resume-import-extraction@sha256:…` artifacts from the
exact checked-out source commit and frozen lock. Availability of this exact
image pair is an external prerequisite; this workflow does not build or publish it.
The site package may remain private. After fetching the public chart and runner,
manual CI authenticates using its temporary `GITHUB_TOKEN` with only
`contents: read` and `packages: read`.
The fixture sends immutable pull Secrets directly to its two freshly created
namespaces and binds them to its ServiceAccounts. They are never application
environment or mounted credentials, never written to evidence or manifest files,
and are deleted with Kind; the login action logs out at job completion. The raw
token is removed from the fixture's child-process environment. No personal token,
package visibility change, existing-cluster credential or registry write is used.
An index is resolved to exactly
one Linux/amd64 platform manifest; both index and child bytes are digest checked.
A local Docker ID, mutable tag, wrong architecture, unknown source or wrong lock
fails. No release-image promotion wiring changes in this preparation.
Docker's familiar Hub names and optional tag spelling are normalized only when
matching inspected repository+digest identity; registry bytes and the exact
requested digest remain authoritative. Static `[adoption]` stage checkpoints
locate a failure without emitting credential-bearing child stderr. Cleanup
completion is logged only after the disposable cluster is deleted.

## Inactive target

Build a target with `node scripts/adoption-candidate.mjs images.json
reviewed-contract.json /tmp/target-runtime.json`. The reviewed non-secret contract
must explicitly select `authMode` and `workspaceMode`; there is no auth default.
OIDC additionally requires `oidcIssuerMode` (`root` or `realm`) and an explicit
`optionalOidcKeys` list limited to `IOLAUS_OIDC_CLIENT_SECRET` and
`IOLAUS_OIDC_IMPORTED_OWNER_BINDINGS`. Both auth modes require the named
`IOLAUS_OIDC_ADMIN_EMAILS` key for web, task and schedule, preserving the reviewed
installation operator allowlist. An explicit empty value selects no operators
in shared mode; omission fails. Private OIDC requires a nonempty administrator-email
configuration. Monitor and migration never receive this authority. Realm mode
requires a realm key, while root mode excludes it.
Preserve the existing deployment's reviewed authentication and workspace contract;
this preparation does not choose or alter Iolaus's live auth profile. Images must already be resolved platform manifests by
`scripts/adoption-images.mjs`; the qualification entrypoint does this itself.
The target is a runtime object, not an applied HelmRelease. A complete protected
HelmRelease must separately bind its current runtime, release ID/attempt,
maintenance responder, retained database/bucket identities and ingress. Do not
use bootstrap `current:false` to replace an existing deployment.

| Workload | Actual image command | Actor and deployment responsibility |
| --- | --- | --- |
| web | `node apps/site/build` | Runtime database role denied DDL; two replicas; `/health` startup/readiness and `/live` liveness |
| task | `node --import tsx apps/site/scripts/jobs-worker.ts` | Runtime task-only worker; four concurrent jobs; 240000ms drain; 270s grace; heartbeat probes |
| schedule | `node scripts/smrt-worker.mjs schedule` | Runtime singleton scheduler; heartbeat probes; 90s grace |
| extractor | `node /app/apps/site/scripts/resume-import-extraction.mjs` | No database/Secret environment; private port8080; `/health`; 32Mi `/tmp` |
| monitor | `node --import tsx apps/site/scripts/deployment-monitor.ts` | Separate count-only database role; CronJob every five minutes; suspended and drained for migration |
| migration | `pnpm --filter @willgriffin/iolaus-site db:release-migrate -- --maintenance-window` | Dedicated maintenance database role and `iolaus-migration-observer` ServiceAccount; retained single-attempt Job |

`writer:true` means the monitor participates in stop/drain sequencing even though
its business database authority is read-only. Every application container uses
non-root UID/GID10001, RuntimeDefault seccomp, no privilege escalation, read-only
root and dropped ALL capabilities. Every application workload has bounded
`/tmp` scratch; heartbeat files live inside `/tmp`, not a credential projection.
Runtime pods have no API token. Only migration opts into the fixed short-lived
projection under `/var/run/secrets/kubernetes.io/serviceaccount/` with `token`,
`ca.crt`, `namespace`, `pod-name`, and `pod-uid`.

All environment entries are explicit named Secret key references. The proposed
platform-owned names are `iolaus-runtime-v1`, `iolaus-migration-v1`, and
`iolaus-monitor-v1`, with `immutable:true`. No values, envFrom, or production
credential documents are committed. The target enumerates every required key;
`DATABASE_URL` differs by role. The platform supplies non-secret deployment
settings in the same immutable configuration contract. Monitor receives only
DATABASE_URL, SMRT_RUNTIME_PROFILE, IOLAUS_DEPLOYMENT_PROTOCOL, SMRT_APP_ID,
NODE_ENV, HOME and XDG_CACHE_HOME.
Migration receives those keys plus IOLAUS_WORKSPACE_MODE (the reachable canonical
schedule seed/reconciliation checks shared mode) and its observer policy. Neither
actor receives authentication, SMTP, S3, crawler, model or submission credentials.
The currently reachable release catalog does not need asset access; disabled
legacy personal resume/asset backfills remain disabled.

Web/task/schedule receive the reviewed authentication/provider configuration,
unique application ID, public URL, workspace mode, trusted ADDRESS_HEADER,
S3-compatible assets, and their process-specific keys. Configured Secret values
must agree with the reviewed contract; literal environment values are never
rendered by the candidate builder. The disposable fixture explicitly selects
magic-link/shared, supplies public URL and trusted proxy-header settings plus
its synthetic signing key/SMTP settings, and is tested against the application's
real authentication resolver. That fixture profile is not the live Iolaus profile.
Fixture Secret contents are projected from each actor's exact required env keys,
so restricted actors cannot receive runtime credentials through an overbroad
Secret even when they are not referenced by the Pod.

Migration additionally requires `IOLAUS_MAINTENANCE_OBSERVER_POLICY` in its named
Secret. This JSON binds exact `releaseName`, maintenance `image`, SHA256 of actual
rendered ConfigMap `data['default.conf']`, `serviceAccountName` (`default` for the
current chart responder), and `migrationServiceAccountName`. The observer fixes
the nginx command to `['nginx','-g','daemon off;']`; a role label cannot exempt a
writer. Config bytes must be calculated from the reviewed rendering before
platform Secret creation; no fallback or guessed digest is valid.

## Platform responsibilities before adoption

These are requirements, not resources applied to an existing platform by this PR:

- Existing runtime, monitor, migration-observer, reconciler and responder
  ServiceAccounts and inherited registry pull Secrets, with verified key versions.
- Observer namespace get/list on Pods, Deployment/ReplicaSet/StatefulSet/DaemonSet,
  Jobs/CronJobs, and HPA; get only the named maintenance ConfigMap; native CA and
  short-lived TokenRequest projection. No write, cluster-admin or long-lived token.
- Runner observation and impersonation permissions; reconciler inventory RBAC,
  Helm storage Secret permissions, complete server admission dry runs (including
  synthetic Pods), and platform enforcement of namespace/database writer fencing.
- Runtime role denied DDL and ownership, migration principal isolated, monitor
  SELECT only on aggregate-safe source crawl/job columns. Database and private
  bucket infrastructure stays platform-owned and retained.
- Ownership transfer for every existing resource must be reviewed. Existing
  objects need exact Helm release/namespace ownership and established
  `helm-controller` manager; the runner fails on collisions and never force-adopts.
- Review the public chart's rendered inventory for all five phases, including
  ConfigMaps, Services, Ingress, workloads, retained migration Job, named Secrets,
  ServiceAccounts and observer CA. All unknown resources/admission changes block.

The protected runner source uses `chartRef = {kind:'OCIRepository', name:'smrt-app',
namespace:'flux-system'}` with OCI source spec `{interval:'1m', url: <chart reference>,
ref:{digest:<chart OCI digest>}}` in the synthetic evidence. Production source
names/spec or ingress/bindings that differ require freshly bound CI evidence.
A synthetic fixture receipt is not production rollout approval.

## Actual-image qualification

Run the manual **Inactive adoption image qualification** workflow using the
reviewed pins and matching final-source image pair. It creates one uniquely named disposable Kind cluster,
never reads a default kubeconfig or accepts an arbitrary namespace, and destroys
the cluster in `finally`. PostgreSQL and the synthetic provider HTTP endpoint
live outside the dedicated application namespace, so they cannot be mistaken
for app writers by the observer. The fixture creates only synthetic credentials
in memory and does not retain child stderr or Secret manifests.

The real images execute under the chart envelope. The fixture first creates an
unknown writer and requires the actual migration wrapper to fail without any
schema/ledger table creation. After that writer is removed, attempt2 must finish
using a real TLS-verified projected observer identity and PostgreSQL. It then
starts the actual web/task/schedule/extractor images, checks Pod platform imageIDs,
checks positive liveness/readiness and an anonymous private HTTP denial (never
accepting HTTP500), verifies projected operator allowlist and allow/deny/revocation
in the actual task image's native tenant context, sends SIGTERM to running workers
and requires exit0/restart,
and executes the monitor using column-restricted database grants. Existing
`deployed-parity.mjs` checks raw source bytes and installed dependencies inside
the actual site image, and the existing extractor qualification executes its
real HTTP/envelope cases. Those frameworks are reused rather than replaced.

Success evidence is created only after every command/assertion succeeds. It binds
source commit/tree, lock, toolchain identities, platform images, runtime and
migration command, chart package/OCI/reference/source, and maintenance/bindings/
ingress. A dry run, local-image-only check, Job completion without wrapper checks,
or operator-written `passed:true` does not satisfy this contract.

This is synthetic image qualification: the asset endpoint exercises real
HeadBucket HTTP readiness but is not an S3 vendor; mail settings do not send mail;
OCR is not exercised; worker SIGTERM uses idle queues and does not prove inflight
provider cancellation. The synthetic operator context does not prove login-provider
or queued-job principal revalidation. Real provider effects and the durable PostgreSQL fault
matrix in [the test matrix](maintenance-adoption-test-matrix.md) remain separate
required evidence. Flux Git phase publication/acknowledgement is covered by the
upstream disposable exercise and must be rerun against the released runner; this
fixture does not impersonate a Flux integration run. Rollout remains held.

## Explicit adoption protocol boundary

The inactive candidate requires `IOLAUS_DEPLOYMENT_PROTOCOL=smrt-release-v1`
as an explicit key in its versioned immutable named Secrets. Web/task/schedule
cannot omit this key; the disposable fixture supplies the exact value and its
Secret producer rejects missing, empty or unsupported values. The same nonsecret
mode key is included in monitor and migration configuration for consistent
adoption identity. It is never inferred from a profile, database URL, owner role,
release label or partial Kubernetes environment.

The new strict role/static-schema startup gates apply only to explicitly opted
application processes. An undefined protocol variable retains the exact legacy
hosted startup behavior, including owner-role support and its existing schema
initialization. Any defined unsupported value (including the empty string) fails
closed. This is a compatibility boundary preserving the active topology while
rollout is held; it does not relax the adoption schema/role contract. Existing
`deploy/self-hosted/base` and production environment wiring remain untouched.

## Dedicated migration and deployed startup

`pnpm --filter @willgriffin/iolaus-site db:release-migrate -- --maintenance-window`
is PostgreSQL-only. It requires the chart's `SMRT_APP_NAME`,
`SMRT_APP_ENVIRONMENT`, `SMRT_RELEASE_ID` and `SMRT_RELEASE_ATTEMPT`; it never
infers approval from a supplied quiescence flag. `db:migrate` remains available
for documented local/standalone compatibility; the inactive candidate alone
uses the dedicated command. Local SQLite onboarding is unchanged.

The pinned global application migration lock remains held through schema,
data and final verification. The released SQL adapter owns pinned sessions and
cleans their advisory locks on release. MigrationTracker remains the schema
history authority and the explicit maintenance window retains NULL-equal index
semantics. Schema compatibility and ancillary guard helpers run as named native
operations, not shell commands recorded as schema migrations. Released integrity
bridges are restored immediately after schema success and attempted independently
on failure; final activation requires validated source/tag guards.

DeploymentPhaseTracker stores permanent application/environment/data-step IDs,
not release timestamps. The catalog records lifecycle values, achievement
placement, source provenance/providers/fingerprints, identity readiness, canonical
seeds and schedules. Checksums bind the logical specification and its enumerated
implementation source bytes (the native identity helper is additionally bound to
the published dependency closure). Changing an implementation requires a new
logical ID. Retain completed markers permanently.

Lifecycle, achievement and source-fingerprint writes use only the tracker's
query-only transactional connection, so their writes and completion marker commit
or roll back together. Collection/native helpers that own independent transactions
use reconciled steps instead: independent inspectors verify persisted roles,
permission mappings, types, vocabulary, control existence, provenance/provider
constraints, identity keys/links and schedule fields. The canonical role seeder is
additive (`prune:false`); expected grants must exist while operator-added grants
remain intact. Existing intelligence-control choices are preserved. A legacy
native-import completion marker can be adopted; an absent marker with existing
legacy input is ambiguous and becomes `needs-repair`. Empty legacy input is a
verified no-op. Personal resume imports, source imports and asset rewrites remain
permanently disabled and are absent from the executable catalog.

Safety is checked on every tracker entry, including a completed-step replay, and
immediately before schema/data effects. It compares concrete registry schemas
against the built app artifact and released dependency manifests, reads fresh
TLS-verified namespace inventory and immutable Pod/Job identity, and refuses
non-maintenance database sessions. Internal checkpoint/failure marker writes stay
pinned and remain possible after safety is lost; they are not additional mutation
authorization. The observer never kills sessions or mutates Kubernetes resources.
It refuses missing projections, unknown or terminating writers, nonterminal Jobs,
unsuspended CronJobs and non-drained writer controllers. Retained failed Jobs need
a true terminal `Failed` condition. The monitor is drained during migration.

Only the approved maintenance responder is exempt: the immutable policy binds its
exact image digest, fixed nginx command, ConfigMap byte hash, service accounts and
release identity; the actual Deployment/ReplicaSet/Pod UID chain and absence of
credential/token/extra containers are inspected. These are actual API reads,
not trusted labels or a `writer:false` assertion.

Static manifests also carry inheritance-only metadata for undecorated
SmrtClass/SmrtObject/SmrtCollection bases; those are not application tables. Web
and task startup verify every concrete registered schema against static metadata
and actual PostgreSQL columns/types/nullability, then attest their declared physical foreign keys and indexes directly through
read-only `pg_catalog` queries. Chat's private model closure is registered
with the public metadata-only `ObjectRegistry.registerFromManifest` API; importing
its full facade would unnecessarily evaluate unrelated same-named message models.
Released manifests supply transitive prompts/secrets/playbooks/reports metadata.
The plain-Node scheduler checks its actual persisted jobs/events/agent-schedule
closure from the same built artifact. Processes explicitly opted into the adoption
protocol require a role denied
schema/database creation and table ownership; their queue recovery and normal
queue writes occur only after readiness. Their startup paths never create missing
tables. Legacy hosted startup remains on its existing schema/initialization path
when the protocol variable is undefined, including support for existing owner
roles; adopting these gates requires the separate reviewed role cutover.

## Reproducing migration evidence

Use the repository-pinned Node/pnpm toolchain and an isolated, disposable
PostgreSQL16 database with a fixture administrator allowed to create/drop synthetic
databases and roles. Never point these commands at a live database. The tests
create uniquely named schemas/databases/roles, retain a sentinel across two full
catalog passes, and remove only their own fixtures. The catalog test selects its
self-hosted synthetic identity before imports; a local profile never redirects
its database to the supplied PostgreSQL URL.

```bash
export IOLAUS_RELEASE_TEST_DATABASE_URL='postgresql://<fixture-role>:<fixture-password>@127.0.0.1:<fixture-port>/<fixture-database>'
pnpm --filter @willgriffin/iolaus-site exec vitest run scripts/db-release-executor.integration.spec.ts scripts/db-release-catalog.integration.spec.ts
pnpm --filter @willgriffin/iolaus-site exec vitest run scripts/db-release-inspectors.spec.ts src/lib/server/deployment/observer.spec.ts src/lib/server/deployment/observer-http.spec.ts scripts/db-common.spec.ts src/lib/server/application-runtime.spec.ts
node --test scripts/smrt-deployment-schema.test.mjs
```

The real PostgreSQL suite covers marker/data rollback, concurrent executors,
changed checksums, fresh safety on completed replay, lost COMMIT acknowledgement
and retry, unresolved reconciliation, runtime DDL denial with permitted data
writes, missing queue tables and restricted monitor reads. The full application
catalog test exercises clean bootstrap, existing-schema replay, seeded state,
validated integrity and sentinel retention. Its safety callback validates actual
static/registry agreement on an isolated fixture; it does not impersonate
Kubernetes observation. Pure observer tests verify chart-shaped maintenance and
failure decisions. The image/Kind workflow is the separate real API/TLS/projected
identity boundary. Unexecuted image/provider/Flux cases remain unqualified; local
PostgreSQL success does not authorize rollout.

The migration planner is an owner-oriented DDL tool, not the runtime readiness
attestor: its information_schema foreign-key views hide existing constraints from
a runtime principal lacking REFERENCES, even when that principal has full planned
DML privileges. Readiness therefore reads pg_catalog directly through the public
query API. It checks ordered FK source/target columns, target schema, actions and
validation; declared index method, key order, uniqueness, NULLS NOT DISTINCT,
readiness/validity and predicates. The one published jobs-ready partial predicate
uses its fixed exact PostgreSQL deparse; unknown expressions/predicates fail
closed as unsupported. Owning source-provider/accounting guard defaults and NOT
NULL invariants remain intact; advisory-only planner suggestions never relax them.
Real fixture tests remove/alter FKs and indexes under the maintenance actor and
require the nonowner startup attestor to refuse them, then accept restored schema.
The production web connection callback accepts the legacy owner without protocol,
refuses that owner with the adoption protocol, and refuses a missing queue table
under a DDL-denied role. Unrelated provider initialization is isolated in this DB
startup test; it does not claim real auth/mail/assets readiness qualification.
The observer parsing tests exercise the production native HTTPS/JSON path using
raw API List payloads with absent item TypeMeta, validate list/item type agreement,
assert verified-CA TLS options, and verify projected token rereads for rotation.
These transport mocks complement, rather than replace, the real Kind/TLS boundary.
