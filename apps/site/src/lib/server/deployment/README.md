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
`GET /api/v1/namespaces/<namespace>/configmaps/<configMapName>`. The only extra
app RBAC permission is read-only `get` on that exact precreated ConfigMap name.
The app never creates, renews, updates or releases the fence. No previous
callback's lease is reused.

The native ConfigMap must have the pinned name, UID and namespace, a native
resourceVersion, and no deletion timestamp or binary data. Its data has exactly
`contract.json`, `uids.json` and `lease.json`. Contract and approved UID-map
identities are SHA256 of `JSON.stringify()` of their parsed objects, matching
the platform producer; the outer contract identity differs from the inner
upstream fence contract identity. Held/null leases fail closed.

The exact outer API is `iolaus.happyvertical.com/writer-fence-lease-v1`, with
source `smrt.happyvertical.com/writer-fence-v1`. It binds the independently
admitted published application source revision, platform contract hash,
namespace UID, PostgreSQL host, maintenance database `postgres`, target database
`jobgeni_prod`, release, attempt, adoption, epoch, phase `migrate`, current native
migration Job/Pod UIDs, producer namespace/service account/Pod UID, approved
UID-map identity, ConfigMap UID and native PostgreSQL visibility qualification
identity. All hashes and producer identities come from the protected policy.

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
