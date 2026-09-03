# ATS auto-submit — design

Status: **dry-run implementation landed; live submission remains blocked**.
This is the agreed spec for the application-flow P4 work. It governs a feature
that submits real applications to real employers, so the safety section is
normative, not advisory.

## Flow

```
Approve ─► canAutoSubmit?
            │
   ┌────────┴─────────┐
  yes                 no / unsupported ATS
   │                   │
 enqueue ATS submit    "Pending submission" (submitting)
 job (worker, API)     + submit_application task
   │                   │  (Hermes — a facilitated user type — or you)
 success → submitted    └─► submitted  /  can't → manual_submission
 hard-fail → manual_submission
 missing answers → awaiting_user + answer-collection CTA  ◄─┐
                                                            │
        user answers (via chat/email agent) ───────────────┘
                       └─► re-evaluate → auto-submit
```

Known-ATS submission is an **HTTP API call, not browser automation** — Greenhouse
and Ashby accept applications via documented POST endpoints. So the
iolaus.localhost **worker** performs the submit for supported ATSes; the browser
path (Hermes) is only the fallback for unsupported flows.

## Authorization & safety (normative)

- **Final approval is the per-application human authorization.** It is a
  dedicated, authenticated record (`final_submission`, timestamp, and user),
  separate from material review and human-readable approval notes. Generic
  admin/API/MCP updates cannot write it. The packaged CLI is a client of those
  same authenticated API routes, so it cannot bypass that guard. Auto-submit
  changes *who executes*, not *whether it was authorized*.
- **Material review is not submission authority.** Each review record is bound
  to an artifact fingerprint; a regenerated or changed artifact is shown as not
  reviewed until it is reviewed again. Final approval persists a separate
  snapshot of every current material fingerprint; automatic submission fails
  closed if any material no longer matches it. At execution, it also compares
  the selected resume's freshly read PDF SHA-256 against that snapshot before
  a payload is built. This verification is read-only: it never repairs or
  replaces a missing application-owned artifact. A matching completed
  final-approval audit is also required before downstream submission work can
  proceed.
- **Conservative eligibility.** When unsure, fall back — never guess.
- **Never fabricate answers.** A required question with no known answer routes to
  the answer-collection CTA, never an invented value.
- **Never bypass** CAPTCHA, 2FA, or bot-detection → `manual_submission`.
- **Evidence or it didn't happen.** Mark `submitted` only with captured evidence
  (ATS confirmation id / response). No optimistic status.
- **Idempotent.** Never submit twice; an already-submitted/attempted application
  is never re-sent.

## `canAutoSubmit` predicate

All must hold, else route to CTA / Pending / manual:
1. `applyMethod`/`applyUrl` resolves to a **supported ATS** (reuse
   `detectJobBoard()`).
2. **All required ATS questions answered** (requires the fetched form schema —
   see below).
3. **No account/login/2FA** needed (`accountStatus ∈ {none_needed, active,
   logged_in}`).
4. A **resume artifact exists** (PDF on S3).
5. **Feature flag on** and not already submitted.
6. A dedicated **final application approval** is present and its saved material
   fingerprint snapshot still matches the current packet, resume, cover letter,
   and answers, with a matching completed approval audit record.

## Outcome → status (uses the P3 statuses)

| Situation | Status |
| --- | --- |
| eligible, enqueued | `submitting` ("Pending submission") |
| worker POST success + evidence | `submitted` |
| **missing required answers** | `awaiting_user` + answer-collection CTA |
| CAPTCHA / 2FA / account / unsupported & Hermes can't | `manual_submission` |
| unsupported ATS, Hermes can try | `submitting` + `submit_application` task |

`manual_submission` is reserved for genuine blockers — **missing answers are not a
dead-end**, they are a collection loop (below).

## Answer-collection CTA (decision #2)

When a required ATS question has no answer:
- Application → `awaiting_user`; create a **`collect_application_answers`** task
  (new task type) listing the unanswered questions.
- An **agent surfaces it as a CTA over chat or email**, collects the answers,
  writes them to the application's `requiredAnswersJson`, and the flow **re-evaluates
  and proceeds** — no manual hand-off for a merely-missing answer.
- Changing answers, question schema, apply URL, resolved ATS URL, or any selected
  material invalidates final approval. The user must review and take the
  dedicated final-approval action again.

## ATS mechanics (pin exact endpoints at build time, do not hardcode)

- **Greenhouse (first):** read the job's question schema (Job Board API), then POST
  a multipart application (identity fields, resume file, custom answers mapped by
  the fetched field ids).
- **Ashby (dry-run landed):** Ashby has **no** unauthenticated public form-schema
  API — the public posting API carries metadata only, and the documented
  `jobPosting.info` form definition requires the employer's API key. The
  required-question schema is instead read from the hosted posting page's
  embedded SSR payload (`GET jobs.ashbyhq.com/{board}/{jobId}` →
  `window.__appData.posting.applicationForm.formDefinition`), the same
  unauthenticated board data their frontend hydrates from. The board's internal
  `non-user-graphql` endpoint is deliberately avoided: its `applicationForm`
  field is a `FormRender` type that does not expose the form definition. Payload
  shape mirrors Greenhouse; `submit()` is a guarded stub (live endpoint + wire
  format unpinned — a live-blocker).
- **Lever (dry-run landed):** like Ashby, Lever's public postings API
  (`api.lever.co/v0/postings/{site}/{id}?mode=json`) is unauthenticated but
  metadata-only — it does not expose the application questions. The
  required-question schema is parsed from the rendered apply page
  (`GET jobs.lever.co/{site}/{jobId}/apply`): each
  `<li class="application-question …">` block yields one field (label, a
  `<span class="required">` marker, and the wire `name`, incl.
  `surveysResponses[<id>][responses][fieldN]` for custom questions). The parser
  segments by the block start marker, not `</li>` (checkbox blocks nest their
  own `<li>`s). This HTML parse is more brittle than Greenhouse/Ashby — any
  structural change degrades to a safe parse miss → manual fallback. `submit()`
  is a guarded stub (live endpoint + wire format unpinned — a live-blocker).
- **Schema pre-fetch belongs in packet generation:** fetch the ATS form schema
  when building the packet and persist the required-question list, so the
  "all answers present" check is real and missing answers surface *during review*.

## Architecture

- New worker job `auto_submit_application` (smrt-jobs), enqueued on Approve when
  eligible.
- An `ats/` submitter module, one adapter per ATS behind a common
  `submit(application) -> {ok, evidenceUrl} | {ineligible|failed, reason}`.
- Reuses `detectJobBoard`, the S3 resume, and `recordApplicationSubmission`
  (already does evidence + approval validation + the `submitted` transition).

## Rollout (staged)

1. **Both flags off by default** — fully dark. With neither `AUTO_SUBMIT_ENABLED`
   nor `AUTO_SUBMIT_DRY_RUN` set, auto-submit is dormant and the lifecycle is
   unchanged (no auto-enqueue, no status changes).
2. **Dry-run is opt-in** (`AUTO_SUBMIT_DRY_RUN=true`, `AUTO_SUBMIT_ENABLED` still
   off): do everything except the final POST; persist the exact payload as an
   `AgentRun` for inspection. Proves the field-mapping without sending. (How many
   dry-runs before going live is an operational call, not a design constant.)
3. **Live** requires `AUTO_SUBMIT_ENABLED=true` (and the live-blockers below).
4. **Greenhouse first** (decision #3), then **Ashby**, then **Lever** — all
   certified for dry-run today; live submission remains gated for all three.

## Scope boundaries

- **Hermes is a facilitated user type** (an actor role), out of scope for this
  repo's PRs. We only produce the `submitting` state + `submit_application` task;
  Hermes (or you) consumes it. (Decision #4.)
- Browser-based submission (Hermes) is not implemented here.

## P4 implementation notes (first slice)

The first slice (Greenhouse, dry-run only) landed with these decisions; the
items flagged **(live-blocker)** must be settled before `AUTO_SUBMIT_ENABLED` is
ever turned on. It ships fully dark: both `AUTO_SUBMIT_ENABLED` and
`AUTO_SUBMIT_DRY_RUN` default to false, so an operator opts into dry-run
explicitly.

- **Persisted shape.** `Application.requiredQuestionsJson` holds the whole
  fetched `AtsFormSchema` (ats + board/job ids + questions); structured answers
  live in `Application.requiredAnswersJson` keyed by ATS question id. The legacy
  free-text `requiredAnswers` stays as the human summary.
- **Approval is mandatory.** `canAutoSubmit` requires the dedicated final
  submission marker and a matching material snapshot, independent of status,
  so a manually-enqueued job can never act on an unapproved or changed
  application.
- **Stale-schema guard.** The persisted schema must parse with non-empty
  ats/board/job ids and match the currently-detected ATS, else it is treated as
  absent (re-fetch required).
- **Idempotency.** Three layers: an active-job unique index (no concurrent
  jobs), the `already_submitted` eligibility check, and the material-locked
  post-submission statuses (no re-approval). A completed dry-run job may be
  re-enqueued on re-approval — harmless, as it only records another AgentRun.
- **Answer changes require re-approval.** The structured answer and question
  fields are part of the final material snapshot. Changing either invalidates
  final approval before a submission can proceed.
- **Answer collection is reviewable.** Missing required answers route to the
  collection task, and recorded answer changes return the application to a
  reviewable, not-finally-approved state.
- **Application-approved resume.** Eligibility and the payload resolve only
  the application's selected resume asset (`resumeAssetId`) and preserve the
  stable ATS filename `resume.pdf`. Missing or unreadable selected assets fail
  closed; a global published resume is never substituted after approval.

## Reusable candidate answers (profile seeding + answer library)

The candidate profile stores verified contact/identity facts (legal name
components, email, phone, location, canonical LinkedIn/GitHub URLs, and a
work-authorization preference) and a private `CandidateAnswer` library holds
answers the user explicitly marked "save for reuse".

- **Seeding happens when the schema is fetched**, during packet generation:
  known profile facts and reusable answers fill the application's missing
  `requiredAnswersJson` entries so the user never re-types known contact data.
- **Conservative mapping only.** Profile facts map by exact normalized
  question-label match against a fixed alias table (first/last/full name,
  email, phone, location, work authorization, LinkedIn, GitHub); library
  answers match by the exact normalized label saved with them. Label
  normalization percent-encodes all punctuation, including suffixes, so labels
  that differ in any symbol never collide. No fuzzy matching, no inference: unknown or
  role-specific questions stay unanswered and become the only collection
  prompts.
  Legacy rows stay compatible by deriving the same canonical key from their
  stored human label; a missing label is never inferred.
- **Precedence.** The application's own stored answer always wins; then an
  explicitly saved reusable answer; then a profile fact. A missing profile
  value seeds nothing. The library is scoped to the same profile whose facts
  seed applications (the `isDefault` profile, else profileKey `default`),
  so facts and reusable answers can never come from different profiles.
- **Database identity.** The library's natural key is `(profile_key,
  label_key)`, rather than the framework's generated slug. This preserves
  punctuation-distinct questions such as `C++` and `C#`, while allowing each
  candidate profile to retain its own answer for the same question.
- **Clearing is deletion.** The review editor prefills every field with the
  stored answer, so a submitted blank means the user cleared that answer: the
  stored key is removed and approval re-approval follows like any other
  answer change. Fields that are not submitted at all are ignored.
- **Revocation.** Saved reusable copies stay removable for their whole life
  ("Remove" in the saved-reusable-answers list), including after every
  matching application has been submitted — the revoke action is a
  profile-library decision with no application status gate and never writes
  an application.
- **Per-application copies are the audit trail.** Seeding writes the copied
  values onto the specific application's `requiredAnswersJson`; later profile
  or library edits never retroactively mutate an existing application.
- **Reuse is explicit.** The review page's Answers tab is the primary human
  editor: labeled fields with source state (profile-prefilled, saved reusable
  answer, application-specific, missing), a save action, and a per-answer
  "save for reuse" checkbox that upserts the private library. The raw ATS
  schema stays available only as collapsed diagnostic detail.
- **Approval semantics are unchanged.** Answers (seeded or typed) are
  approval-scoped material; changing them still clears final approval and the
  user re-approves before submission. The reusable library itself is not
  application material, so saving a reusable answer never invalidates any
  approval.
- **Privacy.** The profile contact fields and the `CandidateAnswer` library are
  excluded from WebMCP and other broad read surfaces (see
  `docs/webmcp-audit.md`).
