# Release migration observer

`observeWriterExclusion()` obtains fresh native Kubernetes workload evidence on
every release safety callback. `createReleaseSafetyCheck()` already calls it
before schema preparation, catalog mutations and integrity finalization. The
observer uses projected service-account credentials and CA verification, rereads
the token before each request, and refuses denied, incomplete or conflicting
inventories. It never changes workloads or database schema.

## Optional native writer-fence lease

The protected `IOLAUS_MAINTENANCE_OBSERVER_POLICY` may include
`writerFenceLease` with exactly the fields in
[`WriterFenceLeasePolicy`](writer-fence.ts). Its absence preserves the existing
observer behavior and performs no lease reads. Every pin must be admitted by the
protected platform producer before the migration starts; never derive expected
values from the lease being checked.

When configured, the observer first verifies the current migration Pod and its
Job owner in the complete workload inventory, then performs a separate fresh
`GET /api/v1/namespaces/<namespace>/configmaps/<configMapName>`. The app needs
read-only `get` on that exact precreated ConfigMap and on the
qualified producer's Pod, controller, optional ReplicaSet, and immutable program
ConfigMap in its protected namespace. It receives no producer write permission.
The app never creates, renews, updates or releases the fence. No previous
callback's lease is reused.

The native ConfigMap must have the pinned name, UID and namespace, a native
resourceVersion, and no deletion timestamp or binary data. Its data has exactly
`contract.json`, `uids.json` and `lease.json`. Contract identity and the lease's
dynamic UID-map digest are SHA256 of
`JSON.stringify()` of parsed objects, matching the producer; the outer contract
identity differs from the inner upstream fence contract identity. The UID-map
digest is not an immutable pre-birth pin: each complete entry is independently
matched against fresh native object names, UIDs and spec hashes. Arbitrary actors
cannot gain an exception by recomputing the map digest. Held/null leases never
authorize mutation; only the bounded startup enrollment wait may retry them.

The exact outer API is `iolaus.happyvertical.com/writer-fence-lease-v1`, with
source `smrt.happyvertical.com/writer-fence-v1`. It binds the independently
admitted published application source revision, platform contract hash,
namespace UID, PostgreSQL host, maintenance database `postgres`, target database
`jobgeni_prod`, release, attempt, adoption, epoch, phase `migrate`, current native
migration Job/Pod UIDs, producer namespace/service account/current native Pod UID,
dynamic UID-map identity, ConfigMap UID and native PostgreSQL visibility
qualification identity. The protected policy pins the precreated producer Job
or Deployment's name, UID
and spec hash, its service account, and an immutable program ConfigMap's name,
UID, sorted-data SHA256 and platform image. Fresh native Pod owner ancestry and
exact admitted template/SA/runtime image bind the current producer UID. Pod UID
replacement under the same admitted controller/program can be re-enrolled;
controller or program replacement requires fresh protected admission.

The inner `fence` follows SMRT `scripts/deployment/adopt.mjs`'s exact
`smrt.happyvertical.com/writer-fence-v1` shape. It pins its contract ID and
identity, adoption/plan/namespace/epoch and namespace/database policy identities.
Both scopes must report zero active writers with fresh, shaped observations.
Outer and inner leases must be unexpired, observed no more than 30 seconds ago,
never in the future, and have a lifetime of at most 30 seconds. Unknown fields,
source/context drift and malformed values produce fixed redacted errors.

This guard reports an observation of an already latched platform hard fence.
Actual production fence enforcement and PostgreSQL 17 cross-database visibility
qualification require their protected native receipts; unit/API mocks do not
qualify production. The keeper connects to the separate `postgres` maintenance
database while observing target `jobgeni_prod`; the app guard adds no keeper
connection or database mutation.

## Constructible first boot and restart

The qualified producer controller and immutable program are precreated before
publishing the migration policy. The policy contains no future migration or
keeper Pod UID/map hash. Authenticated platform enrollment fills the dynamic map
after native birth and Pod IP assignment and publishes its SQL allowance before
the app opens the database.

`waitForWriterFenceEnrollment()` runs in the published migration entrypoint before
DB-related imports or `resolveDatabase()`. It waits at most 30 seconds, re-reading
native app/producer graphs and the exact ConfigMap with fresh credentials. Only
a null lease with otherwise authenticated pending enrollment is retried. A
foreign UID, malformed/drifted context or an issued stale/expired lease fails
immediately. Normal mutation safety callbacks never retry. On producer restart,
old leases fail; authenticated controller-bound re-enrollment may issue a new
lease without republishing the app policy. Mid-mutation failure remains the
release controller's repair boundary.

With the lease guard active, the native producer uses a numeric positive attempt.
The app requires its environment attempt to be canonical positive integer text
and compares the numeric value exactly; padded, nonnumeric and unsafe attempts
are rejected. The optional guard's absence preserves legacy attempt handling.
