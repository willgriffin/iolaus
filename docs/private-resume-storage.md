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
information, query, fragment or path prefix. `forcePathStyle` is an optional
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
must finish private byte cleanup before suspension. Recovery warnings omit raw
provider errors to avoid disclosing credentials. Do not delete the bucket to
roll back application code.

Configuration/resolver unit tests and native SQLite/local AssetRuntime tests
verify application wiring and restart behavior. Actual cross-process S3
read/deny, unavailable provider, interrupted deletion/retry and PostgreSQL
lifecycle qualification must run against the isolated private staging bucket
before release; local tests do not establish hosted durability or bucket privacy.
