# Resume content management

`/admin/career` displays the active workspace profile's canonical resume through
the same `loadAdminResumeSource` resolver used by resume generation. The overview
shows short editable previews of summary/contact, grouped skills, positions,
projects, responsibilities, achievements, other experience and education. It does not select a
different profile, publish or regenerate PDFs, or call an AI provider on load.

Tap a preview card to edit that exact existing record. The form replaces the
preview in the same card position; Save and Cancel return the preview. One editor
opens at a time. Unsaved changes are protected when closing,
switching records, changing disclosure or navigating. Failed saves preserve the
draft; successful saves refresh the preview and return focus to the card. Profile
summary/contact, experience summary/URL, project name/summary/URL, achievement and
responsibility text, education, other roles, contact links, and skill category/group
labels are editable. Each record has its own save form. Dates, relationships,
ordering, memberships, and adding/removing records remain available through the
section's detailed management link. Existing generated resumes remain unchanged
until explicitly regenerated through **Preview & PDFs** at `/admin/resume`.

The eye control beside each section reveals loaded entries omitted by canonical
assembly. It changes the view only; it does not alter inclusion. Related projects
and bullets use lightweight disclosures. Membership uses stable canonical keys or
native record IDs; bullets rendered anywhere count as included once. Education and
other roles share the canonical assembler's exact predicates. Ambiguous identity,
unavailable canonical relationships and bounded incomplete reads are labeled
unavailable rather than hidden. Excluded skill memberships link to existing detailed
inclusion controls. Counts describe loaded entries, not an invented total.

The server resolves identity from the authenticated request, rechecks native
`workflow.profile.manage` permission and the active owned profile immediately
before a write, and reads the target record again with the tenant/user/profile
tuple. Submitted ownership, profile selectors, relationships, preferences,
publication, and artifact fields cannot change through these forms. Private editor
records carry record IDs, fixed editable fields and read-only presentation metadata; foreign records are
excluded even if an adapter ignores its query predicate. Unsafe stored links are
never rendered as clickable links, and new link values accept HTTP, HTTPS or mailto.

Focused regressions live in `career-management.spec.ts`, `career-presentation.spec.ts`,
`resume-canonical-membership.spec.ts`, `resume-data.spec.ts`, `CareerResume.spec.ts`,
and `career-route.spec.ts`. Browser validation uses isolated fictional owner data
to verify real edits and reload persistence, ownership denial, and desktop/mobile
light/dark rendering without changing the user's profile or generated assets.
