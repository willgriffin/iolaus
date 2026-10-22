# Resume dependency release closure

The resume production train (#223) consumes published SMRT **0.55.19** and SDK
**0.103.5**, with PDF **0.66.0**, OCR **0.61.6**, Sharp **0.35.5** and animation
**0.5.0**. All coordinated packages use exact registry versions and workspace
overrides; ingestion's SMRT siblings remain on the same release. SDK 0.103.4 was
not selected because its auth archive lacks the `./server` export used by Iolaus.
The first compatible published auth candidate is 0.103.5. This is a bounded
release selection rather than an upgrade to the newest SMRT/SDK release.

`vendor/release/published-closure.json` is the active dependency record. It
captures registry tarball URLs, SHA-512 integrity and SHA-1 registry metadata,
plus independently observed SDK/SMRT source tag commits. The registry supplied
no `gitHead` or build attestation: tag references are source context, **not proof
that a tarball was built from that commit**. Frozen pnpm installation verifies
registry archive integrity. Runtime tests qualify installed consumer behavior.

Run `node scripts/verify-published-closure.mjs` after a frozen install to verify
exact overrides, direct versions, lock integrities and all active package
identities. The self-hosted manifest check runs this verification as well.
Unreachable historical directories in pnpm's virtual store do not belong to the
active frozen graph. Historical local archives, their source closure and the
compatibility-repack verifier remain for audit/reproduction; current manifests
and deployment checks no longer consume them. Their older qualification claims
do not qualify this release.

Narrow qualification covers installed native ingestion lifecycle, local OAuth
session-backed authorization/revocation and replay rejection, SDK server imports,
PDF/OCR/Sharp native imports, and the release verifier's integrity/version failure
paths. Full integrated validation and release qualification belong to the train
coordinator and are recorded on its pull request; this document does not declare
a production rollout.
