# Search and shortlists

On a shared installation with the public catalog enabled, start at `/` or
`/opportunities`. Describe the role, skills and work arrangement you want, or
choose a profession category and toggle skills in its grid. The homepage remembers
the selected category, skill choices and location in this browser. Remove individual
skills or use Reset skills to start again. Text-derived skills appear as selectable
filters; toggling one off keeps it out of the submitted search. These preferences
are device-local, including when signed in.

Use my location asks the browser for permission and resolves a city through the
HappyVertical geo adapter (OpenStreetMap). Previously granted permission can fill
an empty location automatically. You can edit or clear the location; denied
permission or an unavailable lookup leaves manual entry usable. Coordinates are
not saved in preferences or account records. The location filter matches the
posting's location text, not a distance radius; clearing it searches anywhere.

Submitting a search opens a full-page triage deck directly, even with skills alone
or an explicitly empty search. List view shows compact, keyboard-accessible rows
with key facts, a skill preview, and the current choice. Saved, passed, and later entries are
hidden from this list, including after reload; Undo restores them. All choices remain available in the shortlist’s All shown view. Selecting a row opens
that posting with the triage detail layout while keeping List selected and the
signed-in workspace sidebar visible. Save, Pass, or Later returns to the same list
scroll position and focuses the selected row; a failed choice stays in triage
for retry. Switching to List view also returns without making a choice.
Opening triage through the header keeps the normal advance-to-next behavior.
More results load into the same result set. Reload preserves the chosen view
in the URL; the temporary return-to-list context lasts for the current visit.

Triage fills the viewport with user, heart, and search icons grouped
at the top left and the contextual triage/list icon group at the top right.
Pass, Later, and Save sit in the header, with Later centered on the viewport.
Undo is positioned independently on the left. On narrow screens, the actions
occupy a second row inside the header. A divider separates the header from
the posting. Undo is disabled until a choice can be undone.
The posting scrolls within the page while the action bar stays
visible. The posting description is the main reading area, with facts, qualifications and selected-skill matches
beside it on wider screens and stacked on phones. Its action bar keeps Pass,
Later and Save within reach. Multiline qualifications appear as spaced bullets.
A horizontal swipe on non-interactive posting areas passes left or saves right;
links and controls keep their normal behavior. Mouse drags starting on text
select it; drags starting in empty space follow the pointer directly without
tilt. The opportunity counter and swipe instructions are omitted. The list starts directly with opportunity cards, without a visible page title
or matching count. A filter icon in the header
opens a modal for search, skills, work/location, compensation, and sorting.
Apply submits the draft; Close or Escape discards it. The skill catalog keeps
existing selections while searching for additional skills. Clear all filters
starts an unfiltered list without changing shortlist decisions.
Vertical scrolling and selecting text do not make a decision. Buttons remain
available without gestures, including with reduced motion enabled.

Only the active card loads the public posting details. Changing cards cancels or
ignores the previous request; failed detail requests can be retried without
changing the shortlist. The card distinguishes a match to your search filters
from a verified assessment of your qualifications. List view keeps compact cards.

Search interpretation runs without an AI call. It recognizes catalog skill
names and aliases, a curated set of occupation-to-skill suggestions (such as
nurse → patient care), supported work arrangements, explicit country names,
employment types and unambiguous salary minimums with a currency and period.
Unsupported constraints are shown as warnings. The original sentence remains
visible; the resolved query and filters can be edited. These search preferences
never change the skills or eligibility facts in a candidate profile.

For each opportunity:

- **Pass** records that it is not of interest.
- **Later** keeps it in the history for another look.
- **Save** puts it in Saved.
- **Undo last choice** restores the preceding decision.

For signed-in users, the header heart opens Tasks and search opens Opportunities;
these destinations are omitted from the workspace sidebar. Guests use the heart
to open `/shortlist`. The shortlist remains directly available at `/shortlist`
for either session type. Tasks show Shortlist, Applying, and Applied lanes, with
colored icons preserving the more detailed workflow stage. Task filters, view
selection, Sync, and New task controls live in the header.

`/shortlist` has Saved and All shown views. All shown contains cards that were
actually displayed, including ones passed or left for later. You can change a
decision there. Open the original posting in a new tab to apply manually; opening
it and marking Applied are separate actions. Save never queues company research,
AI analysis or an application.

Guests keep a versioned shortlist in browser local storage, bounded to 500
opportunities. Browser storage is local to that browser; clearing it removes
those saved choices. When storage is blocked or full, the interface reports the
problem and retains current choices in memory where possible. This fallback is
not a durable backup. Stale postings remain as history; confirmed unavailable
postings no longer expose an active posting link.

Signing in imports the guest list into the account. Existing account choices
win; retrying an import does not overwrite them. Browser entries are cleared
only after the server acknowledges them, and unavailable jobs remain local.
Account storage belongs to the verified tenant/user, independent of candidate
profile onboarding. A conflicting update reloads the current account entry
instead of silently overwriting another tab's choice.

Email this list opens a draft in the user's email application with public
posting links. Review the draft and enter a recipient before sending. The
export is bounded to keep the link usable; the interface reports truncation.
Iolaus does not send an email automatically or offer an anonymous SMTP relay.
A shareable, interactive cross-device guest shortlist is not part of this flow.

## Implementation boundaries

The existing public API query remains a strict bounded full-text query. The
browser's `search` parameter is interpreted into that API contract; `q` retains
its previous meaning. Public catalog projections are the only job data allowed
into a shortlist snapshot. Guest snapshots are untrusted on account import and
are replaced by fresh public projections.

`/api/shortlist` and `/api/shortlist/import` require a verified workspace identity,
current native principal permissions, and same-origin JSON mutations. Durable
entries and mutation receipts use native SQLite or PostgreSQL transactions,
owner-scoped natural keys, optimistic revisions and idempotency receipts.
They are excluded from generic model API, CLI and MCP CRUD surfaces.

The bare `/opportunities/` entry renders the same profession and skill discovery
page as `/`, including saved category and skill choices. Submitted searches
continue to open the triage/list results interface.

Public discovery, results, shortlist, posting, company, skill, profile, and
sign-in pages share `PublicSiteHeader`, with consistent left navigation and
a contextual action slot on the right.

The shared header reserves its maximum action height at each breakpoint across
all public views, so navigation and content do not shift when switching modes.

List cards also offer small bottom-right Reject (X), Maybe (clock), and Love
(heart) buttons. These record Pass, Later, and Save directly, keep list mode,
and remove the row from results. Undo restores the exact selected opportunity.
The separate card review button still opens full triage details.

On discovery pages, the header stays at the top while scrolling. The primary
search action starts between the search fields and skills directory, then
sticks directly below the measured header height while browsing skills.
