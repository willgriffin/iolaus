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

Owners edit profile links at `/admin/candidate-profile-links`. Optional fields
with service icons are provided for common professional and social profiles,
plus a website or portfolio. Existing links populate matching fields; other
links remain available as custom entries. Each field saves independently, and
blank unused fields do not create records. Editing a URL preserves its resume
visibility and ordering. These edits do not update an already published snapshot.

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

## Agent and terminal access

The same lifecycle is available without the admin forms through four
owner-principal tools — `public_profile_status`, `public_profile_prepare`,
`public_profile_publish`, `public_profile_unpublish` — listed on the
authenticated MCP catalogs only when the feature is enabled. From a terminal
signed in with `iolaus auth login`:

```bash
iolaus mcp call public_profile_status '{}'
```

```bash
iolaus mcp call public_profile_prepare '{"profileId":"<owned profile id>","handle":"<handle>","visibility":{"contacts":{"email":false,"phone":false,"location":true,"links":true},"sections":{"experience":true,"education":true,"other":true,"skills":true}}}'
```

```bash
iolaus mcp call public_profile_publish '{"revisionId":"<revisionId from prepare>","expectedRevision":<baseRevision from prepare>}'
```

They call the same service functions as the form actions: preparation still
captures an immutable snapshot and renders the PDF before anything is stored,
the 20-previews-per-48-hours limit and the 10 MiB artifact bound apply, publish
re-reads and hashes the exact reviewed PDF, and a stale `expectedRevision` is
refused. The prepared preview can be reviewed at the returned admin
`previewUrl` before publishing. See `docs/employment-workflows.md` for the
argument shapes and `docs/surface-parity.md` for the parity record.

## External websites

The [versioned public-profile API](public-profile-api/README.md) exposes only
the current published snapshot for anonymous static-site consumers, with typed
withdrawal responses, an opaque revision token, synthetic fixtures and schemas. With `IOLAUS_PUBLIC_ASSISTANT_ENABLED=true` it also offers a bounded,
anonymous assistant (text, and voice with a dedicated OpenAI key) that answers
only from that snapshot; see the API README for its flags and limits.
