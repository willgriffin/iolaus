# Public resume profile release runbook

This is a qualification checklist, not evidence that any staging or production
deployment has occurred. The public-profile feature flag must remain off until
each applicable check has a dated operator record.

## Before enabling the feature

1. Verify the configured `@happyvertical/files` provider is durable across a
   pod/container restart. The profile PDF prefix must be private and no bucket,
   CDN, or object URL may allow anonymous reads.
2. Verify the application proxy sends public requests through the route that
   checks the current identity and revision. Confirm `no-store`, `noindex`,
   canonical URL, and safe link-preview headers on HTML and PDF responses.
3. Run the SQLite and disposable PostgreSQL publication/deletion suites with
   two users in one tenant and a user in another tenant. Include stale
   publish-versus-delete, render failure, storage write failure, unpublish, and
   retry cases.
4. Render a real PDF, inspect it, and exercise the anonymous page and download
   at 320 px and 1280 px. Confirm the legacy private homepage and `/resume.pdf`
   behavior in a private installation.
5. Restart a pod or local container after a successful publication and confirm
   the same revision remains available. Restart during a failed prepare and
   verify the artifact is not anonymously reachable.

## Deletion and recovery

Account deletion tombstones the public identity before other account rows or
artifacts are removed. The tombstone uses the publication lock, clears the
current revision, reserves the handle, and prevents stale in-flight publication
from restoring the profile. Revision PDF objects are deleted before revision
rows, so a retry has the same manifest.

If storage is unavailable, do not reactivate the account or manually remove
database rows. Re-run the existing hosted-only command after repair:

```sh
pnpm --filter @willgriffin/iolaus-site account:deletions
pnpm --filter @willgriffin/iolaus-site account:delete -- --tenant-id <id> --user-id <id>
```

The command is idempotent. It finishes once it reports `deleted`; a later run
reports `already-deleted`. Keep the retained handle tombstone intact.

## Rollback

To roll back delivery, turn the public-profile feature flag off. This disables
anonymous delivery without deleting private resumes, publication history, or
the handle reservation. Do not remove object-store data as part of feature-flag
rollback. Investigate and reconcile only through the bounded orphan-cleanup
procedure after its provider semantics are qualified.

## Offline local-provider orphan reconciliation

Before enabling a reconciler, record the storage provider's prefix-listing
pagination and consistency behavior, object delete behavior, and the chosen
grace period. Each run must use a bounded page from `public-profiles/`, query
the native publication store for exact referenced paths, and delete only stale
unreferenced keys. Abort on a listing or database failure and record aggregate
counts only. Never scan a broad asset prefix, and never delete a currently
referenced revision or another account's artifact.

The shipped command supports only the local `@happyvertical/files` provider.
Stop every application and worker process that can publish before running it.
It scans 100 sorted paths per page, considers only strict UUID-scoped PDF paths
older than 24 hours, and retains all paths referenced by a revision. The flags
acknowledge operator-enforced downtime; they do not stop processes for you.

```sh
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/cleanup-public-profiles.ts --confirm-offline --app-stopped
# Review the dry-run candidates, then repeat with --apply to delete them.
# For subsequent pages, pass --after-path=<nextCursor> from the previous result.
```

Listing, invalid timestamps, stat, or database errors abort planning before any
delete. A deletion error reports partial progress and can be retried offline.
The local listing adapter inventories the prefix recursively, while deletion
and stat work is paged; large object stores need a separate qualified paginated
adapter and are deliberately refused by this command.
