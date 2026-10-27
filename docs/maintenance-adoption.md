# Iolaus maintenance adoption preparation (#236)

Rollout is **held**. `deploy/self-hosted/adoption/` is unreferenced by both active
Kustomizations. The new manual qualification workflow cannot publish an image,
change GitOps, merge a PR, or reach an existing cluster. Active init-container
migration guards remain in the existing topology until separately authorized
ownership transfer and rollout.

## Public prerequisites

`deploy/self-hosted/adoption/prerequisites.json` intentionally has null artifact
pins. This is a blocking input, not an installable deployment. Chart 0.1.0 cannot
supply the required security envelope or observer projection. After chart 0.2.0
and its reviewed runner source are publicly released, a reviewed change must fill
in the exact OCI manifest digest, packaged chart SHA256 and public runner Git commit.
The already pinned Kind node, PostgreSQL and maintenance responder images are
reused from the upstream disposable exercise; they are platform-resolved and
verified before use.
No unpublished worktree supplies CI code. The public runner checkout must have
its exact approved origin, revision and clean tree. OCI manifest bytes must hash
to their requested digest and bind the packaged chart layer bytes.

The image inputs must be public `ghcr.io/willgriffin/iolaus/site@sha256:…` and
`ghcr.io/willgriffin/iolaus/resume-import-extraction@sha256:…` artifacts from the
exact checked-out source commit and frozen lock. Availability of this exact public
image pair is an external prerequisite; this workflow does not build or publish it. An index is resolved to exactly
one Linux/amd64 platform manifest; both index and child bytes are digest checked.
A local Docker ID, mutable tag, wrong architecture, unknown source or wrong lock
fails. No release-image promotion wiring changes in this preparation.

## Inactive target

Build a target with `node scripts/adoption-candidate.mjs images.json
reviewed-contract.json /tmp/target-runtime.json`. The reviewed non-secret contract
must explicitly select `authMode` and `workspaceMode`; there is no auth default.
OIDC additionally requires `oidcIssuerMode` (`root` or `realm`) and an explicit
`optionalOidcKeys` list limited to `IOLAUS_OIDC_CLIENT_SECRET` and
`IOLAUS_OIDC_IMPORTED_OWNER_BINDINGS`. Private OIDC requires administrator-email
configuration; realm mode requires a realm key, while root mode excludes it.
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
DATABASE_URL, SMRT_RUNTIME_PROFILE, SMRT_APP_ID, NODE_ENV, HOME and XDG_CACHE_HOME.
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

Run the manual **Inactive adoption image qualification** workflow only after
reviewed pins exist. It creates one uniquely named disposable Kind cluster,
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
accepting HTTP500), sends SIGTERM to running workers and requires exit0/restart,
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
provider cancellation. Real provider effects and the durable PostgreSQL fault
matrix in [the test matrix](maintenance-adoption-test-matrix.md) remain separate
required evidence. Flux Git phase publication/acknowledgement is covered by the
upstream disposable exercise and must be rerun against the released runner; this
fixture does not impersonate a Flux integration run. Rollout remains held.
