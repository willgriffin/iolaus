# Unified intake for launch

Status: proposed scope for the next coordinated push. Written October 13, 2026.
Implementation, validation and local user acceptance must precede publication.
Keep work local until the owner asks to push; this document does not authorize
deployment, package publication or employer submission.

## Release outcome

A signed-in user can add a resume PDF or a public URL and reach the right next
step: review imported resume experience, open an application, inspect a company,
select companies from a directory, or add a posting source. These five paths are
one release scope. Resume PDF import is required for launch.

Use one consistent intake interaction, accessible from the relevant page header,
with file drop, file picker and pasted URL support. Context supplies the initial
intent, and the user can correct an uncertain classification. Show processing,
review, partial completion and retry states without losing the original input.

| Input | Default outcome | Review or confirmation |
| --- | --- | --- |
| Resume PDF | Proposed updates to the user's resume | Correct and select records before applying |
| Individual job posting | Imported or reused opportunity | Applications context starts or reuses a local application; general intake opens the opportunity |
| Company website or company profile page | Created or enriched company, with discovered careers links | Review proposed company matches, fields and source links |
| Company directory or listing page | Bounded set of discovered companies | Select companies before import; do not import every company automatically |
| Job board, careers page or posting source | Source plus a bounded posting preview | Confirm selected imports; recurring crawling is a separate explicit choice |

Company listing input includes both a page about one company and a directory of
many companies. Classification must distinguish those cases. Supported fetchable
sites must have a documented capability matrix; accepting a URL does not promise
that every site can be parsed. Unsupported, blocked and sign-in-only sites need
an actionable result, never an invented successful import.

## Existing capabilities to reuse

- `AddUrlIntake.svelte` and `/api/admin/url-intake` provide the current URL dialog
  and authenticated transport.
- `lib/url-intake.ts` classifies supported ATS postings versus source pages and
  normalizes URLs. Server public HTTPS handling protects actual fetches.
- `server/url-intake.ts`, `importJobOpportunity()` and
  `server/opportunity-details.ts` already import or reuse postings and extract
  supported posting details.
- `openJobApplication()` and `server/application-workflow.ts` already create or
  reuse the user's application through the existing decision/preparation flow.
- Existing career management and resume assembly own record relationships,
  inclusion controls, preview generation and publication behavior.

Refactor reusable domain orchestration out of transport-specific modules where
needed. UI, WebMCP and ingestion handlers should call the same domain operation;
one transport must not invoke another transport to perform a write.

## Ingestion architecture

Adopt `@happyvertical/smrt-ingestion` for durable intake receipts, retained source
evidence, processing attempts, reviewed proposals and execution records. Iolaus
owns the resume, company, directory and opportunity handlers. Keep existing ATS
and safe web-fetch adapters; ingestion is not a substitute for them.

The upstream package was assessed at SMRT commit
`af25b95b6d91067752275089f5203db0396380ad`. Its contract requires host-supplied
storage, scoped authorization, jobs, extraction requests and retention cleanup.
Its published evaluation does not establish automatic interpretation quality.
Use explicit user review for generated resume/company/directory proposals.
Do not require AI interpretation to dispatch a known posting URL when the user
has explicitly chosen Start application.

Before implementation, qualify the selected ingestion version against the linked
SMRT/SDK versions. Record the source commits and dependency closure; do not
upgrade the whole stack merely to obtain this package. Any missing reusable
capability belongs upstream in the existing sibling worktrees.

The host must configure private AssetRuntime storage, native migrations, trusted
tenant/user/profile scope, current authorization checks, the ingestion queue,
explicit extraction and interpretation stages, dispatch/deletion repair, and a
purge callback for derived previews and indexes. Do not enable unrelated
background automation in the local QA environment.

## Resume import

1. Offer Upload resume during onboarding and on the Resume page. Bind the intake
   to the authenticated user's active owned profile on the server.
2. Validate the PDF signature and enforce configured byte, page, time and
   extraction budgets. Keep the original privately and acknowledge durable receipt.
3. Extract through `@happyvertical/pdf`. Support ordinary text PDFs and a bounded
   scanned-PDF OCR path through supported upstream adapters. If an upstream
   capability is missing, add it there. Encrypted, corrupt, oversized or unreadable
   files produce clear errors and preserve a safe retry or replacement path.
4. Propose summary/contact details, experience, employers, roles, dates, projects,
   responsibility/achievement bullets, education and skills where supported by
   the document. Experience is the minimum essential outcome. Keep source-page
   evidence and distinguish explicit facts from uncertain interpretation.
5. Present extracted entries beside existing entries. Let users edit, exclude,
   create, merge or keep the current value. Flag partial dates and possible
   duplicates; never invent exact dates, employers, credentials or achievements.
6. Apply only the reviewed revision through existing domain APIs, preserving
   relationships and inclusion settings. Recheck ownership and target revisions
   at the write boundary; concurrent edits require a fresh comparison.
7. Return to the populated Resume tabs. Import does not publish the profile or
   silently regenerate previously issued PDF artifacts.

Receipt retry identity and business deduplication are separate. Re-uploading a
PDF may create a new receipt, but must not silently append duplicate experience.
Use exact import provenance for reliable repeats and proposed matching for
employer/role/date similarities. The user resolves ambiguous matches. A changed
resume must not delete experience omitted from its latest version.

## URL workflows

### Start an application from a posting

Applications offers a prominent posting URL input, including on
`/admin/applications/new/`. Resolve or import the opportunity, then create or
reuse the application for the active owned profile and open its workspace.
Record the user's explicit application intent. Do not mistake a company directory
or job board for one posting; ask the user to select a discovered posting.

If import succeeds but application preparation fails, retain the opportunity and
show the completed step plus a retry for the remaining work. Double clicks,
lost responses and concurrent retries must resolve to the same application.
Missing posting details remain visible as incomplete information. No employer
submission is triggered by intake.

### Company websites and company profile pages

Capture bounded page evidence, propose company identity and descriptive fields,
and discover candidate careers/source links. Match existing companies by verified
identifiers and normalized domains, presenting uncertain matches for review.
Do not overwrite richer existing data with empty or speculative extraction.
Importing a company does not automatically activate its discovered sources.

### Company directories

Extract a bounded preview with each company's name, site/profile link and source
evidence. Show existing matches, invalid links and truncation. The user selects
which companies to import. Track per-company outcomes and retry only unfinished
items. Directory pages must not start unrestricted recursive crawling.

### Posting sources

Reuse supported Ashby, Greenhouse and Lever adapters and bounded generic careers
handling. Preview postings and existing matches before confirmed import. Separate
one-time import from recurring crawling. Preserve operator-only source creation
and activation rules: an ordinary user can submit an intake request and see its
status, but cannot acquire operator privileges by adding a URL. Show a clear
pending-operator path where source onboarding requires that role.

## Trust and data boundaries

Private resume files, extracted text and proposals remain scoped to the owning
workspace and profile. They must not enter the public opportunity catalog or a
cross-user learning pool. Deletion revokes pending work and removes source bytes
and derived content, retaining only permitted minimal replay/audit identities.

Documents and fetched pages are untrusted evidence, including any instructions
embedded within them. They cannot select credentials, authorization, handlers or
crawl budgets. Preserve public HTTPS validation for DNS and every redirect hop;
reject credential-bearing, internal and unsupported URLs. Discovered links pass
the same validation as pasted links. Every eventual write rechecks current grants.

## Implementation work packages

| Order | Work package | Completion checkpoint |
| --- | --- | --- |
| 1 | Qualify ingestion dependencies and host integration | Native migrations, private receipts, jobs, scoped access and cleanup pass on SQLite and PostgreSQL |
| 2 | Shared intake UI and intent dispatch | URL/file input, classification correction, durable progress and retry work in existing headers |
| 3 | PDF extraction and resume proposals | Text and scanned fixtures produce evidence-backed reviewable entries; failures are explicit |
| 4 | Resume comparison and apply | Selective merge works; repeated upload, concurrent edits and failed retries preserve existing data |
| 5 | Posting import and application orchestration | New/existing URLs open one owned application; retries resume after partial failure |
| 6 | Company and directory adapters | Company enrichment and selected directory imports preserve matches and bounded discovery |
| 7 | Source onboarding integration | Preview/import and operator-controlled recurring activation remain distinct |
| 8 | Integrated QA and release preparation | All five journeys pass local owner QA, documented checks and independent review before the requested push |

Use the current linked sibling worktrees. Keep generic ingestion/PDF improvements
in SMRT/SDK and application policy/UI in Iolaus. Introduce deployment changes only
if storage or worker qualification demonstrates they are needed. Track these work
packages as children of the unified-intake epic when implementation is scheduled;
this local plan does not create remote issues or update a PR.

## Launch acceptance and evidence

| Scenario | Required result |
| --- | --- |
| New user uploads a text resume PDF | Reviewed experience appears in Resume with correct relationships and source evidence |
| Scanned, mixed-page and non-tech resumes | Supported extraction is demonstrated across representative documents; omissions/uncertainty are visible |
| Existing resume and repeated upload | No silent duplicates, deletions, overwritten edits or changed visibility settings |
| Wrong user, revoked grants, stale approval | No private evidence access or domain writes; clear recoverable denial |
| Worker restart, lost response, concurrent retry | Same durable result; no duplicate application or repeated completed import step |
| New and already imported posting URLs | Both reach the correct owned application; failed parsing/preparation is shown accurately |
| Company site and individual company listing | Correct proposed company, existing match and careers links; no automatic source activation |
| Directory with duplicates and more results than the cap | Bounded selectable preview, honest truncation and per-item outcomes |
| Supported posting source as operator and ordinary user | Correct preview/import or pending-operator behavior; no permission expansion |
| Unsafe URL, malicious document, bad PDF, unavailable provider | Explicit bounded failure, no unsafe fetch, fabricated success or leaked private data |
| Source deletion or account deletion during work | Access revoked and derived content cleaned without stale workers restoring it |
| Desktop/mobile and light/dark | Drop/picker/paste, keyboard review, corrections, progress, errors and Back navigation remain usable |

Use fictional fixture profiles for mutation QA. Agree and freeze a representative
resume/site corpus before evaluating extraction; document measured field accuracy,
unsupported cases and correction effort. A successful API call or upstream test
suite is not proof that resume extraction is useful enough to launch.

Run focused tests first, then repository format, lint, check, test, build and
knowledge freshness gates. Run native database migration/status and integration
tests for the new persistence and execution paths. Exercise real configured PDF
and OCR adapters, not only mocked extraction. Preserve a local end-to-end demo of
each input type for owner acceptance before the next push. Required CI belongs to
the final shipping step, with no ongoing watch unless requested.

## Outside this release

Automatic employer submission, email inbox ingestion, standalone image/audio
uploads, unrestricted directory crawling, arbitrary authenticated website access,
and automatic acceptance of AI-proposed profile changes remain separate work.
Public resume publishing continues to require its existing explicit action.

## References

- [SMRT ingestion contract](https://github.com/happyvertical/smrt/blob/af25b95b6d91067752275089f5203db0396380ad/packages/ingestion/README.md)
- [Application-aware ingestion design](https://github.com/happyvertical/smrt/blob/af25b95b6d91067752275089f5203db0396380ad/docs/adr/0004-application-aware-ingestion.md)
- [Career management](../career-management.md)
- [Existing coordinated release](agent-first-release.md)
