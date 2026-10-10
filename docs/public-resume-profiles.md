# Public resume profiles

Public resume profiles are an opt-in sharing feature for a hosted workspace.
The feature flag is off by default. An owner first chooses a handle and a
candidate profile, then explicitly publishes an allowlisted immutable snapshot.
Private edits, tailored application resumes, and changing the active workspace
do not change an already published revision.

The anonymous HTML page and PDF are derived from the same stored snapshot. The
PDF is stored privately at `public-profiles/<identity-id>/<revision-id>/resume.pdf`;
anonymous delivery must resolve the current published revision through the
application and must never expose an object-store URL. Pages and downloads use
`Cache-Control: no-store` in the first release. The routes are `noindex`.

## Publication and withdrawal

The owner preview, publication prepare, and publication commit use a scoped
identity and revision. Asset generation happens before the short database
commit. A failed render, write, or commit leaves the previously published
revision current. A failed preparation removes its staged file only when a successful read proves
that no revision references it. An unknown commit outcome or process crash can
leave an unreferenced private object; no object is public by its storage key.

Unpublishing removes the current pointer, so later anonymous HTML and PDF
requests are denied. It does not recall copies already downloaded by visitors.
Handles are case-insensitively unique and remain reserved after withdrawal or
account deletion in this release.

## Account lifecycle

Account deletion first tombstones the publication identity under the same
native identity lock used by preparation and publication. Tombstoning clears
the current pointer and prevents an in-flight stale prepare or publish from
becoming current. It retains the handle reservation while removing the owner's
publication settings and immutable revisions.

The deletion then removes every revision PDF path returned while tombstoning,
together with the existing owned resume, application, and attachment files.
The database rows remain the retry manifest until all removals succeed. A
storage failure leaves the hosted account locked and the deletion in `started`;
an operator re-runs `account:delete` after storage recovery. The account export
contains only the signed-in owner's publication identity, settings, revisions,
and private artifact manifest; it does not include another owner's identity or
assets.

## Orphan cleanup and retention

An object at the publication prefix is never deleted merely because it is old.
The staged reconciliation procedure may delete only a bounded batch of keys
older than the configured grace period after a native store query proves that
the exact path is not referenced by any identity or revision. It must only scan
the `public-profiles/` prefix, must never list or delete arbitrary storage keys,
and must stop on provider listing or database-query failure. Run it only after
the selected provider's pagination, consistency, and deletion semantics have
been qualified in the target environment.

There is no automatic cleanup job in the first release. The offline local-provider
cleanup command is available; object-store cleanup remains unsupported until
its listing and consistency semantics are qualified. Retain revision metadata
only while its identity is active; deletion removes revisions after their
private artifacts. The handle tombstone is retained to prevent reuse. In this
release it retains the tenant and owner identifiers as an internal publication
fence; anonymous readers can never retrieve those fields.

Enable the feature explicitly with `IOLAUS_PUBLIC_PROFILES_ENABLED=true` in shared
hosted mode. It is disabled by default and does not alter personal installations.
Owners manage it at `/admin/career/public-profile`; contact email, phone, location,
and links each require opt-in. Resume sections can be selected independently.
The first reserved handle is immutable. At most 20 previews can be prepared in
48 hours per identity. PDF rendering uses two concurrent render slots and a
bounded waiting queue; PDF size is limited to 10 MiB.
