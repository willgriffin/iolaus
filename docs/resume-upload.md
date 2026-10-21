# Resume PDF upload

Resume upload is a private, signed-in workflow available from Resume and
onboarding. A user uploads one PDF, reviews evidence-backed suggestions, and
explicitly chooses what to add. Uploading or processing never publishes a
profile or submits anything to an employer.

## User flow

Choose a PDF of at most 10 MiB and confirm: “Resume text is sent to our
configured AI provider to prepare suggestions. Nothing is added until you
review and import.” Both browser and upload route require that confirmation.

Processing proposes experience, education, skills, and an optional profile
summary, genuine projects, and labeled bullet sections. Headings such as
“Team Leadership” remain sections under their role rather than synthetic projects.
Proposals include source-page evidence when it is available. Dates
remain as `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`; absent dates stay blank. An
uncertain proposal or possible existing-record match begins as **Skip**.

For each entry choose **Create new**, **Merge with existing**, or **Skip**.
Editable fields are company, title, dates, summary and newline-separated
bullets for experience; title, institution, dates and detail for education; a
skill name; and a profile summary. Bullet-section titles and their individual
bullets are editable. Skill observations are read-only source evidence pinned to
the proposal: role, demonstrated use, source quotation/page, and explicitly
supported usage dates. Employment dates provide context and are not assumed to
be skill-usage dates. Observations accumulate across roles without inventing
expertise scores, summing overlapping tenures, or creating shared catalog facts. Applying is revision-bound. If a proposal is
stale, reload and compare the latest version; the browser retains unsent edits.
Each proposal and its review decision may contain at most 200 entries. This
count limit is independent of the existing aggregate byte and field limits, so
an unusually large set of entries can still be rejected safely.

Warnings remain visible during review. OCR-derived proposals require
verification. An unavailable AI provider, unreadable PDF, extraction failure,
or size/type refusal is actionable: retry a failed receipt or remove the
private upload and start again. If a deleted or expired receipt rejects the same
PDF, Iolaus does not retry it automatically; choose **Start a new import** to
explicitly create a new receipt. This implementation does not claim support for
every scanned, encrypted, or malformed PDF.

## Operations and privacy

The receipt, original bytes, extracted evidence, review state, and execution
records are scoped to the authenticated tenant, user, and candidate profile.
The server sets that scope. PDF text and source metadata are untrusted input;
access is rechecked while processing and applying.

Receipts have a 30-day retention/replay window. Deleting an upload revokes the
receipt and removes its private source assets through native ingestion cleanup.
The task worker runs retention/repair at startup and every five minutes. Operators
must provide private AssetRuntime storage, apply ingestion migrations before
service, and run that worker. Never put resume files, evidence, or extracted
text in a public bucket or shared catalog.

Text extraction runs through the private
`iolaus-resume-import-extraction` ClusterIP service, configured through
`IOLAUS_RESUME_EXTRACTION_URL`. It accepts only `POST /extract` with an
`application/pdf` body up to 10 MiB and exposes `GET /health`. One bounded
child process runs at a time with a 75-second deadline. Input/output files are
mode 0600 in a mode 0700 disposable directory, output is capped at 1 MiB, and
all files are removed on success, timeout, failure, or client disconnect.

Build the local image from the repository root:

```sh
docker build -f apps/site/Dockerfile.resume-import-extraction -t iolaus-resume-extraction:local .
```

Run its process-boundary test suite with:

```sh
pnpm --filter @willgriffin/iolaus-site test:resume-import-extraction
```

The extractor has no credentials, service-account token, public ingress, or
egress. Its NetworkPolicy accepts only Iolaus web and worker pods, while its
read-only non-root pod has dropped capabilities, a 32 MiB temporary volume, and
a 512 MiB memory limit. The application client refuses redirects, bounds
streamed responses, validates the page/text envelope, and reauthorizes
immediately before sending bytes. Production never mounts or uses a Docker
socket. The worker uses `@happyvertical/pdf` only for embedded-text inspection.

After text extraction, the service resolves the standard `cheap` Bifrost AI
profile with the `resume-import` usage tag. Configure a working site AI profile
and provider credentials. The feature obeys `IOLAUS_AI_DISABLED`,
`IOLAUS_AI_USER_LIFETIME_CAP_MICROS`,
`IOLAUS_AI_USER_MONTHLY_CAP_MICROS`, and writing-pricing configuration. A
disabled, unconfigured, unavailable, or budget-refused provider never applies
anything automatically.

Interpretation first identifies the ordered starts of role and non-role blocks.
The server derives each end from the next start, accounting for every source
line once without model-owned overlapping ends. Role blocks retain their
headings, projects and bullets. The source is supplied in full only to that
indexing call.
Each indexed role then receives one request containing only its own source spans
and minimal employer/role context. A separate request handles education, explicit
standalone skills and profile content from non-role spans. Requests have bounded
concurrency and a global interpretation deadline inside the native analysis lease.
No unsuccessful role is silently dropped to produce a partial import. A named
section that exactly matches a standalone heading with a literal HTTP(S) project
URL in the validated role source becomes a linked project. Generic headings stay
as responsibility sections. Same-heading section/project duplicates are
reconciled, retaining distinct bullets once and preserving the source URL.

Every call uses the standard cheap profile, freshly rechecks authorization, and
reserves its own bounded AI budget. Configure costs for the index, non-role
request and one request per supported role, rather than three repeated copies
of the full resume. Strict `json_schema` is required; there is no unconstrained
JSON fallback. Nullable optional wire fields normalize to absence; required
facts remain typed and server validation is authoritative. Unsupported spans,
missing citations, truncated responses, and incomplete interpretation reject
the whole proposal. The role model cites a validated source-line number for
each skill use and emits a concise usage description. The server derives the
exact quote and page from that role line, avoiding repeated quotations in model
output. A skill observation is omitted unless its cited line names the skill or
a controlled alias. Unsupported usage dates are removed rather than borrowed
from employment dates; either adjustment produces a visible review warning. Role links and context are resolved server-side during the same owned
apply transaction. Skill evidence is stored privately on the candidate's skill
group and included in account export/deletion with that group.

The model's completeness declaration and structural checks cannot establish
that every semantic claim is correct; the user must still review the result.
An explicitly requested new import uses a stable request-generation identity,
so a fresh import of the same PDF does not reuse a previously applied receipt
and a repeated request of that generation does not duplicate it. Applied imports
also offer **Start a new import**, retaining the original private upload.

## PaddleOCR for scanned or flattened PDFs

The networkless Docker worker uses `@happyvertical/pdf` only to inspect
embedded page text. If a page lacks text or native extraction flattens substantial
page content into one line, the application host reauthorizes the private receipt
directly before sending its bytes once to PaddleOCR-VL. Role indexing requires
usable line boundaries; flattened text is not sent to the language model. The
response's ordered page Markdown becomes the source evidence for the existing
Luna interpretation; optional image URLs and image content are ignored. Calls
are serialized per process, fail explicitly while a call is already active, run
for at most 120 seconds to accommodate an expected 64-second cold wake, and
never retry automatically. PaddleOCR permits 50 MiB inputs, but Iolaus still
enforces the 10 MiB upload, 20-page, and 120,000-character application limits.

For local tailnet access, set `HAVE_PDF_PADDLEOCR_URL=http://paddleocr-vl`.
This is a direct private service URL and uses no Bifrost key. A future cluster
deployment uses `http://paddleocr-vl.paddleocr-vl.svc.cluster.local`. The
self-hosted web and task-worker manifests set that endpoint and label the
Iolaus namespace `happyvertical.com/paddleocr-client: 'true'`. Iolaus does not
deploy PaddleOCR-VL: operators must provision that private Service in the
`paddleocr-vl` namespace and enforce the matching namespace-label allowlist
before enabling the self-hosted manifests.

## Dependency provenance

The local compatibility repack is
`vendor/release/happyvertical-smrt-ingestion-0.55.17-iolaus-0559.tgz`, resolved
by `apps/site/package.json` and `pnpm-lock.yaml`. Its SHA-256 is
`44dbc3de5b384f2a8dbb768c93a5c33e2f2ef3d892597e9383ffdb2f38acf5d0`.

The audited provenance sidecar
`vendor/release/smrt-ingestion-0.55.17-iolaus-0559.provenance.json` records its
source as SMRT commit `af25b95b6d91067752275089f5203db0396380ad` and identifies
the published `@happyvertical/smrt-ingestion@0.55.17` tarball with SHA-256
`543d66a55989e1d8a78530ec66354d53b79174372bbdfcd22da044f7e2be12dc`. The local
bundle pins its ingestion dependency on `@happyvertical/pdf` to `0.65.9`; the
site independently uses `@happyvertical/pdf` `0.66.0`. It also rebinds the SMRT
package family to `0.55.9`, SDK dependencies to `0.103.1`, OCR to `0.61.4`, and
Sharp to `0.35.3`. Native SQLite and PostgreSQL integration passed against this
bundle. This is local compatibility evidence only, not a published-release
closure; reconcile the archive with the upstream release before shipping.

## Validation before deployment

Run focused transport, host, domain, extraction, and browser tests before the
repository validation sequence. Exercise a real private asset store, AI profile,
text PDF, and representative scanned PDF locally. Verify invalid or oversized
PDFs, omitted consent, revoked access, stale apply, provider failure, deletion
during work, and repeated retry do not silently create resume entries. Run the
database migration and status checks for the selected engine.

Experience extraction keeps introductory role summaries separate from ordered achievement bullets. Bullet-only roles may have a blank summary. Reviewers can edit, add, and remove individual bullets before applying; the existing import saves them as ordered resume bullet records.

Named projects under an employer/role are proposed as private Project records,
not additional jobs. Their achievements are stored once as Duty records linked to the project and
its parent experience, and rendered beneath one project heading. General role
bullets remain separate. Projects can be created, merged, or skipped separately.
Selecting the parent links a project to the created/merged experience; skipping
the parent creates an unlinked project (an existing merged project keeps its link).
Only reviewed project changes are saved, with normal owner and revision checks.

## Processing feedback

Upload and retry acknowledge a retained, queued receipt before parsing or AI
processing. The native ingestion worker performs the processing; status GETs
only read the authorized receipt and its current revision's native job stage.
The page polls automatically and shows reading PDF, reading page layout
when OCR is needed, extracting details, then preparing review. It does not
turn elapsed time into a completion percentage. A lost connection is shown
and polling reconnects without re-uploading the file. The receipt URL permits
returning later. The native task worker must be running; status reads never
execute extraction as a fallback.

Model output truncation is reported separately from PDF byte/page/text limits.
No partial AI output is accepted, and retry never applies entries automatically.
