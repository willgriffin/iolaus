# Private resume ingestion storage

Resume ingestion uses `IOLAUS_RESUME_IMPORT_STORAGE_JSON`, independently of
`RESUME_FILES_CONFIG_JSON` (legacy resume files). This is an additive storage
boundary; changing it does not migrate existing objects. Keep the same private
bucket configuration for every web replica, worker and scheduled recovery or
retention process. Account deletion uses the same ingestion runtime. Account
export contains authorized receipt metadata only, never object URLs or bytes.

The `local` runtime (including an unset `SMRT_RUNTIME_PROFILE`) always uses the
canonical user asset root returned by `getIolausUserAssetsRoot()`. Its optional
JSON configuration may only specify `type: "local"` and that canonical
`basePath`. It cannot select another local directory or an external provider.

Both `self-hosted` and `cloud` require explicit S3 configuration. Missing,
malformed or unrecognized configuration fails closed; there is no local fallback.
Example shape, with fictional non-secret values:

```json
{
  "type": "s3",
  "bucket": "private-ingestion",
  "region": "us-east-1",
  "endpoint": "https://objects.example.invalid",
  "forcePathStyle": true
}
```

`endpoint` is optional for AWS S3; a custom endpoint must use HTTPS with no user
information, query, fragment or path prefix. The sole HTTP exception is the
explicit `IOLAUS_RESUME_IMPORT_CLUSTER_GARAGE=1` opt-in with the exact endpoint
`http://garage.garage.svc.cluster.local:3900`, `region: "garage"` and
`forcePathStyle: true`. The opt-in does not permit any other HTTP host, port,
path or spelling. It accepts plaintext transport inside the cluster; NetworkPolicy
must restrict web/worker access to that Garage service. This is not TLS encryption.
Use a new private originals bucket and bucket-scoped key, never the generated-PDF
bucket or its credentials. Mount the same protected configuration in every
request, worker, retention and operator recovery process. `forcePathStyle` is an optional
boolean. Use either the SDK's ambient IAM credential chain or the paired
`accessKeyId` and `secretAccessKey` fields delivered through the protected
runtime Secret. Never put credentials or the JSON value in logs, source,
diagnostics or deployment evidence. Unknown fields, partial credentials,
non-S3 hosted providers and `basePath` are rejected. Released AssetRuntime S3
locators do not encode a provider prefix, so a dedicated bucket avoids ambiguous
prefix ownership. Do not repoint or migrate the legacy resume storage bucket.

AssetRuntime owns provider initialization, byte I/O and persisted Asset
metadata. Its storage resolver enforces the configured bucket (or canonical
local root) on every operation, rejecting foreign provider locators and path
escapes. Host/ingestion authorization still enforces tenant, profile and owner;
a storage configuration is not an authorization grant. Receipts and evidence
remain private, and providers must not expose unauthenticated public reads.
Bucket policy/ACL, encryption and narrowly scoped list/read/write/delete IAM are
infrastructure requirements; the filesystem API cannot attest those settings.
Keep bucket identity stable across restarts: changing it intentionally blocks
access to old locators until an explicitly authorized migration restores them.

Provider failures propagate to ingestion's durable recovery/deletion machinery;
there is no alternate store. Retention retries failed sweeps, and account deletion
must finish private source revocation/quarantine before suspension; physical
original-PDF purge follows the recovery deadline. Recovery warnings omit raw
provider errors to avoid disclosing credentials. Do not delete the bucket to
roll back application code.

Configuration/resolver unit tests and native SQLite/local AssetRuntime tests
verify application wiring and restart behavior. Actual cross-process S3
read/deny, unavailable provider, interrupted deletion/retry and PostgreSQL
lifecycle qualification must run against the isolated private staging bucket
before release; local tests do not establish hosted durability or bucket privacy.

## Uploaded-original recovery retention

The application quarantines deleted uploaded **original PDFs** in place in the
private import store for 30 days after the first durable native revocation.
Normal reads and writes are denied immediately, including revoked native items
whose storage callback has not completed. Derived extraction/evidence continues
native immediate purge. This is application-managed retention: Garage provides
neither version recovery nor object lock. Direct administrative/key-level deletion
of the sole object is outside this recovery promise and requires independent backup.

The durable `resume_import_quarantines` ledger has a unique storage identity/key,
original hash and length, scalar tenant/owner/profile/asset/item/deletion identities,
and fixed revocation/purge timestamps. It has no account foreign keys. The ledger
commits before native metadata is removed or redacted and survives account deletion.
Retries, restarts and completed-deletion replays cannot reset the deadline. Minimal
tombstones remain after physical purge so delayed cleanup cannot create a new window;
they contain no extracted content. These recovery identities are an explicit exception
to the otherwise detached account deletion audit and have no normal user surface.

The worker runs independent retention before looking up active profiles, even when
an owner is deleted or suspended. At/after the deadline it deletes the original
through the configured filesystem and retains the tombstone. Provider failures retry.
An unresolved write marker causes repeated physical sweeps and an operator warning,
never a claim that bytes have permanently settled and never timeout-based clearing.
A provider outage or unresolved writer may delay physical completion; investigate
rather than claiming a strict physical 30-day maximum was met.

Operator-only `recoverQuarantinedResumeOriginal` requires explicit authorization
of the named actor, exact tenant/ledger identity, reason and destination authority.
It requires an independently committing root database (no outer transaction),
commits a private audit before reading and verifies original length/SHA-256
before releasing bytes. It refuses foreign, expired, purged or corrupted originals.
The service never reactivates a deleted account/expired receipt or restores derived
facts. A fresh authorized import must receive a fresh native asset identity.
There is no public recovery URL, presigning or user-facing recovery endpoint.

This is separate from ingestion's existing source-evidence/receipt expiry measured
**30 days from upload**. A day-5 deletion becomes physically eligible on day 35;
upload expiry on day 30 begins recovery retention until day 60. A delayed
sweeper uses the persisted access-expiry timestamp and cannot extend that window. Active-original
lifetime is unchanged. Generated PDFs retain their existing
`RESUME_FILES_CONFIG_JSON` storage/deletion policy and are not migrated.

Before rollout migrate both private ledger/audit tables, qualify disposable native
SQLite/PostgreSQL and Garage lifecycle checks, and confirm anonymous access and
legacy bucket access are denied. Rollback must preserve ledger and bucket and must
not use an older binary that physically deletes quarantined originals.

## Unresolved private writes and account deletion

Before calling native ingestion `receive`, Iolaus commits a new random invocation
row in `resume_import_write_operations`. Admission checks an extant active user,
profile, tenant and membership and no started deletion while holding the existing
users-row lock in the same native transaction (PostgreSQL `FOR UPDATE`, SQLite
writer lock). Request IDs and delivery deduplication never replace invocation IDs.
A fully accepted/duplicate native receive, after awaited preservation and
receipt acceptance, resolves that invocation. The pinned ingestion 0.55.19 source
also proves every `rejected` result and `retry/busy` return before its first
`preserve()` call; these outcomes resolve only this invocation's marker because
it never began source writes. Another busy invocation retains its own marker.
Failed resolution leaves evidence. No generic `finally`, provider error, other
retry, unknown outcome, elapsed lease, process restart or disconnected advisory
session resolves it. Markers have
no expiry. Their source/delivery locators are private operator recovery data and
are excluded from generated API, CLI and MCP access.

Deletion takes the same account lock and commits/reuses a started deletion record
before checking markers. That record permanently closes new admission while it
exists. An unresolved marker produces `pending-source-writes` (browser HTTP 503;
operator CLI prints the typed error). The account has **not** been deleted: private
source cleanup, identity removal and audit completion are refused. Existing account
credentials may remain until recovery; started deletion prevents further upload.
A retry reuses the started record. Final row deletion checks closed admission and
zero markers again in its native transaction before removing identities. A future
upload cannot pass admission after the native account row is gone.

For a persistent pending deletion, an operator must first establish quiescence of
**all** web/worker processes and source writes for the affected account, including
in-flight provider operations and requests that might resume. Session/lease loss
or age alone is insufficient. Retain the account, started deletion, operation
rows, ingestion evidence and Asset locators. Reconcile each invocation's
`tenant_id`, `user_id`, `profile_id`, `source_id` and `delivery_key` with native
receipts/evidence, planned asset locators and actual provider outcomes. A locator
may exist without receipt acceptance. If quiescence or the complete locator/object
set cannot be established, keep the deletion pending and escalate; never announce
private-byte deletion complete. Once independently documented quiescence and
reconciliation establish that an invocation cannot produce further writes, an
operator may remove **only that invocation row scoped by id, tenant_id and user_id**
and rerun `account:delete`. There is deliberately no automatic clearing or public
recovery endpoint. Keep the independent recovery evidence outside candidate logs;
never copy bytes, credentials or provider errors into a deletion audit summary.

Source qualification: installed `@happyvertical/smrt-ingestion` 0.55.19 `server.js`
uses `preserve()` only from `receive()`. Its `planFile` and `preserveFile` writes
are awaited; `readEvidence`, analysis/retry and dispatch repair read sources or
write database state. Native accepted/duplicate results follow preservation and
receipt acceptance; unavailable retries and thrown/unknown outcomes can follow
source writes and retain their markers. Rejected outcomes and retry/busy are
provably prewrite in this pinned version; recheck every return point on upgrades. Recheck this source
contract when upgrading ingestion/assets. Ordinary native SQLite and PostgreSQL
transaction tests are distinct from actual provider/interruption qualification.
The preserved stopped fault-injection artifact is not executed or replaced;
remaining applicable provider/deployment gates must be recorded before release.

Account deletion constructs the configured provider only when it finds a receipt
captured for that owner. Expired/deleted receipts still require provider cleanup;
missing configuration fails closed for them. An account with no matching receipts
can complete without import storage configuration. The separate durable pending
write gate still runs first, and retained quarantine tombstones remain the
independent retention worker's responsibility even after account deletion.
