# Employment Search Workflows

This document records the current automatic and agent-invoked workflow behavior
for the SMRT-backed employment-search app.

Source-crawl provenance and Opportunity deletion/repair invariants are
documented in [Source crawl opportunity integrity](source-crawl-opportunity-integrity.md).

## No-Autosend Boundary

Agents may research, score, draft, prepare application packets, fill local
records, and create tasks. They must not submit applications, send emails,
message recruiters or founders, create external accounts, bypass CAPTCHA/2FA,
or share files externally unless Will explicitly approves the external action.

The app enforces this in application status transitions and task copy:

- Material review is scoped to an exact artifact fingerprint; reviewing a resume,
  packet, cover letter, or answers never authorizes submission.
- `approved` and `submitting` require recorded Will approval. External submission
  additionally requires the dedicated final-application approval record
  (`kind`, timestamp, user, and material-fingerprint snapshot), not approval
  notes or scope text. The snapshot and its completed system audit must still
  match when recording submission and at automatic submission; verification
  never repairs a missing application-owned artifact.
- `submitted` requires submission method, timestamp, actor, evidence, and final
  application approval. Recording a completed submission never creates approval;
  it must already have been recorded by the dedicated final-approval action.
- Submission blocker tasks route CAPTCHA, 2FA, credential, missing answer, and
  judgment-call blockers back to Will.

## Agent Field Contract

Agent-written list fields are stored as newline-delimited text, one item per
line, with blank lines removed and duplicate items collapsed in first-seen
order. The write contract applies to admin forms, REST API writes, and MCP
tools. API and MCP callers may send `string[]`; the app serializes the array
into the same newline-delimited storage shape.

Current newline-delimited list fields:

- `Opportunity.locations`
- `Opportunity.requiredSkills`
- `Opportunity.preferredSkills`
- `Opportunity.domainTags`
- `Opportunity.roleTags`
- `Company.industryTags`
- `Decision.decisionTags`
- `ResumeVariant.emphasizeTags`
- `ResumeVariant.excludeTags`
- `ResumeVariant.includePositionIds`
- `ResumeVariant.excludePositionIds`

JSON-string fields are stored as canonical JSON text with stable object key
ordering. Admin forms still edit text; REST API and MCP callers may send a JSON
object or array directly and the app serializes it before saving.

Common agent-facing JSON-string fields:

- `PreferenceRule.ruleJson`
- `Task.artifactRefsJson`
- `SourceCrawl.tagsJson`
- `SourceCrawl.filtersJson`
- `SourceCrawl.preferenceSnapshotJson`
- `SourceCrawlItem.rawJson`

Relationship references remain SMRT ids, but admin fields should prefer
validated pickers where a local app-owned resource exists. Opportunity
`companyId` resolves against `Company.name` and can create a missing company;
`sourceId` resolves against existing `Source.name` and does not create sources
implicitly.

## Automatic Workflows

These side effects run after records are written through admin, REST API, MCP,
or source jobs:

- Source create/update syncs `_smrt_agent_schedules` from `refreshCadence`,
  `isActive`, and source id, and creates account handoff tasks for login/signup
  blockers.
- Source delete removes that source's recurring crawl schedule.
- Manual source crawl enqueues a `SmrtJob` on `source-crawls`.
- Scheduled source crawl runs through `_smrt_agent_schedules`; the scheduler
  emits jobs on `agents`.
- Source crawl jobs call `Source.crawl`, create `SourceCrawl` and
  `SourceCrawlItem` provenance, reconcile duplicates by canonical URL, posting
  URL, and source external id, then update `Source.lastCheckedAt` and
  `Source.nextCheckAt`.
- Every discovered candidate first creates one idempotent `SourceCrawlItem`
  attempt. Only a committed opportunity write may finalize that attempt as
  `created`; retries and global matches use `reused`, provider relistings use
  `relisted`, canonical duplicates use `duplicate`, deliberate rejections use
  `skipped`, and exhausted persistence conflicts use `failed_persistence`.
  `SourceCrawl` totals are rebuilt from these committed terminal items, with
  `attemptCount = terminalCount + pendingCount` and `terminalCount` equal to
  the sum of the six terminal outcome counters. See
  [Source crawl accounting](./source-crawl-accounting.md).
- Source crawling ends after deterministic fetch, normalization, persistence,
  eligibility evaluation, and a bounded queue insert. It never waits for
  opportunity extraction or scoring. Eligible new or materially changed source
  content is fingerprinted and queued on `opportunity-intelligence`; unchanged
  and ineligible content is not queued.
- Intelligence jobs carry source crawl, source crawl item, source, opportunity,
  source-content fingerprint, and source-content version provenance. Active
  jobs are deduplicated by opportunity and content fingerprint, and stale jobs
  skip model work when a newer fingerprint has superseded them.
- Source crawl ingestion resolves relistings and alternate URLs before saving
  opportunities. `Opportunity` stores the resolved company or ATS root posting
  as `postingUrl`, `canonicalUrl`, and direct `applyUrl`; `SourceCrawlItem`
  stores the discovered alias/relist URL plus the resolved root canonical URL.
  Unresolved relistings are recorded as `skipped_relist_unresolved` without
  creating an opportunity.
- Hacker News Who is Hiring extraction uses the complete anchor `href` as the
  posting URL and discards display-only URLs ending in an ellipsis. Per-item
  extraction failures retain provider/item context in bounded crawl diagnostics
  while valid sibling listings continue through provenance and ingestion.
- Source crawl ingestion can create or update `Company` records and add public,
  crawlable `company_careers` sources from reliable company metadata found on a
  relisting, root posting, or company careers page.
- Opportunity create/update syncs recommendation review tasks: recommended
  opportunities get one active Will decision task, and stale review tasks are
  canceled when the opportunity is no longer recommended.
- Application create/update validates lifecycle transitions, clears final
  approval when approved materials change, and syncs application workflow tasks.
- Final approval creates a system-authored `AgentRun` audit record with the
  approver, exact material fingerprints, and timestamp. Those records are
  read-only through the admin, REST, CLI, and MCP surfaces. The generated
  schema fields are applied with `pnpm --filter @willgriffin/iolaus-site db:migrate`;
  existing approval records without the dedicated marker intentionally fail
  closed until reviewed again.
- Final approval, background status changes, and completed-submission recording
  use the same optimistic-concurrency fence over application-scoped materials
  and approval fields. A stale writer cannot restore cleared approval or move a
  concurrently edited application forward. Generic admin, REST/CLI, and MCP
  writes also cannot modify or delete application-owned `ResumeAsset` records;
  those artifacts are changed only by the application workflow before renewed
  review.
- Completed submissions are recorded only through the application-review
  workflow action. Generic admin, REST/CLI, and MCP updates cannot transition
  an application into a post-submission status or write submission provenance,
  so they cannot bypass the final material snapshot check or its audit record.
  The dedicated recorder compares the just-verified final-approval state while
  committing the submitted transition, so a concurrent material invalidation
  wins and leaves the status unchanged.
- Application material approval scope includes `resumeVariantId`; changing the
  selected variant invalidates existing approval before submission work can
  continue.
- Application status `draft` or `application_drafting` creates a packet prep
  task.
- Application status `awaiting_will` creates a Will approval task.
- Application status `approved` or `submitting` creates a submission task that
  still stops before external submission unless final approval is recorded.
- Application status `submitted` marks the opportunity applied and creates
  follow-up/status-check tasks.
- Application status `interviewing` creates an interview prep task.

## Agent-Invoked Workflows

These are explicit operations an agent or Will can request:

- `pnpm --filter @willgriffin/iolaus-site opportunities:crawl` crawls active sources
  from the command line. Generic crawling remains opt-in; direct Greenhouse and
  Ashby sources are the conservative default. Its per-source and total summaries
  report created, reused, relisted, duplicate, skipped, and failed-persistence
  counts; pass `--json` for the same complete summary as machine-readable JSON.
- `pnpm --filter @willgriffin/iolaus-site opportunities:crawl-status` reports queued,
  active, completed, failed, timed-out, and stale-running crawls. Add
  `--reconcile` to terminally mark only overdue `running` crawls as timed out;
  it never deletes crawl evidence or marks a crawl successful.
- The admin source "Crawl now" action enqueues one manual source crawl job on
  `source-crawls`.
- The jobs worker (`pnpm --filter @willgriffin/iolaus-site jobs:worker`) runs
  `TaskRunner` and `ScheduleRunner` for manual and scheduled source crawls and
  one-attempt opportunity-intelligence jobs.
- The task board recommendation action calls `processRecommendationTask` to
  record a `Decision`, update opportunity status, and create application or
  research/re-score tasks as needed.
- Application package actions create or refresh draft applications, packet
  assets, resume assets, cover letter assets, resume variants, and related
  workflow tasks.
- Tailored resume package generation creates or updates a `ResumeVariant`
  linked to the `Application`, `Opportunity`, and `Company`, uses the variant's
  tailoring config/overrides as resume generator input, and writes generated
  Markdown, text, HTML, and PDF paths back to the variant. The generated variant
  remains preparation material; it does not approve or submit the application.
- Submission and blocker actions record the outcome in `Application`, `Task`,
  and `AgentRun` without bypassing final application approval.
- Posting preflight fetches a known ATS posting without credentials, classifies
  closed/error/list-page redirects conservatively, and records bounded evidence
  in `AgentRun`. Acceptance, draft creation, and packet generation run a fresh
  preflight immediately before they proceed. A conclusively closed role becomes
  stale/archived; an inconclusive result needs an authenticated owner’s typed
  reason and a separate override audit. It never submits an application or
  accesses a browser session.
- One-at-a-time triage is a **modal deck over the opportunity list**, opened
  from the list toolbar's Triage button and seeded with the list's *current*
  filters: the list is the context and owns the filter. The deck is a native
  `<dialog>` inside the admin shell, so it never has to break out of the shell's
  left nav and right dock — the verdicts live in the dialog's own footer, the
  card scrolls in the dialog body, and the page behind is scroll-locked. Esc and
  the close button leave; closing refreshes the list, so decided rows drop out.
  `/admin/opportunities?triage=1[&triageSort=newest][&filters]` is the deep
  link, and the retired `/admin/opportunities/triage` route redirects to it, so
  old bookmarks and the agent docs still land in the deck.

  The queue is the undecided ("unseen") backlog under the triage preset, with
  archived, expired, and no-longer-seen postings excluded. It is read through
  the list route's own `triageQueue` action — `loadTriageQueue` verbatim, the
  same preset the agent-facing read uses — a window at a time, prefetched ahead
  of the operator. The advance is optimistic, so the read steps past both the
  rows the operator passed on and the verdicts still in the air: until a write
  commits the server still counts that row as undecided and still serves it at
  the front. For the same reason a short window only means end-of-queue when
  nothing is still in flight, and a window that came back entirely already-seen
  is retried once those writes land.

  The dialog header carries exactly two things: a **sort chooser** and the close
  button. The chooser is a segmented **Match %** / **Newest** control — score
  descending or posted-date descending, the deck's only two orderings, both of
  them sorts the shared filter model already supports. Anything else the
  operator carried in from the list (salary, rating, best) normalises back to
  Match %. The choice is remembered per viewer in `localStorage`, a deep link
  overrides the remembered one, and `job_search_next_triage_candidate` takes the
  same `sort` argument so an agent and an operator work the queue in the same
  order. Changing the ordering restarts the session, because the cards in hand
  were chosen by the old one — and the restart claims the deck, so a read still
  in flight for the ordering just left behind is discarded rather than filling
  the new session with the previous order's window. The first session likewise
  waits for the remembered preference to be read, so no window is ever ordered
  by something the chooser does not say.

  The deck shows **no counts**: no position, no remaining total, no session
  tally. A backlog in the thousands is discouraging as a number and useless as a
  decision input; the card in hand is the whole job. When the queue runs out the
  deck says "Nothing left to look at" and offers Close — but only when the queue
  actually came back empty: a failed read renders as a failure with a **Try
  again**, because "nothing left" is a claim about the backlog and a read that
  failed makes no claim about it.

  **Triage decides what deserves a deeper look, not what to apply to.** There is
  no apply path in the deck at all: applying happens from the shortlist or the
  opportunity's own record page.

  Nothing is ever forced: Later is the cheap default, there are no confirmation
  dialogs anywhere, and every verdict is already recorded per card, so leaving
  mid-session loses nothing. The advance is optimistic — the next card is on
  screen before the previous write returns, and a write that fails puts its card
  back at the end of the queue with the reason shown.

  The three verdicts, in the dialog footer and on swipe:
  - **Nope** (left) posts `reviewOpportunity` with `reject`, exactly as the list
    toolbar does.
  - **Later** (middle) records nothing. The card stays undecided, so it stays in
    the server queue; the session only steps its offset past it.
  - **Dig deeper** (right) posts `digDeeper`, which records `maybe` through the
    same `updateOpportunityReview` writer **and** queues the agentic follow-up in
    the same request: the opportunity intelligence job
    (`enqueueOpportunityIntelligenceWithStatus`, which reuses an active job for
    the same content fingerprint rather than duplicating it), one bounded posting
    preflight recorded as its own `AgentRun`, and the company's
    `research_company` task through `ensureCompanyResearch` (keyed on
    `company-research:company:<id>`, so an open task is reused). The verdict is
    written **first** and each queue step then runs under its own guard: a step
    that fails is reported on the card as a failed step and never unseats the
    decision.

  Both verdicts also carry a **rating**, because a verdict is a rating in
  everything but name and an empty column throws that signal away: Nope writes
  2, Dig deeper writes 8, and Later writes nothing at all. They are defaults
  only — a rating the owner already set on the record (from the list, the
  record page, or an earlier pass) is a finer judgement than a button press and
  is always preserved verbatim. The card shows neither the rating nor the
  posting check; both ride on the verdict. Nothing weights or learns from
  these; they are just the rating the shortlist and every later pass already
  sort by.

  The posting preflight is the only step that leaves this system on the request
  path, and keyboard triage can put several right swipes per second through it
  against one employer's host. So it is throttled: a recorded verdict younger
  than `DEEP_DIVE_PREFLIGHT_MAX_AGE_MS` (15 minutes) is reused and nothing is
  fetched, reported in the step strip as `recent` rather than `queued`. The
  card's own **Verify** action (`v`) is an explicit operator request and is
  deliberately not throttled.

  Both the queue read and both verdicts are actions of the *list* route, so
  triage can never become a second, less audited write path.

  The **Shortlist** toolbar link, beside Triage, opens the list at
  `review=maybe` sorted by score, so the deep-dive results land where an
  application is actually started. The review-reason box is seeded from the
  notes the card already carries, so a decision keeps them unless the operator
  edits them. Undo re-posts a snapshot of the previous review fields (status,
  rating, notes) and waits for the optimistic write it undoes before landing;
  because nothing in the deck creates an application, an undo is always
  complete — work the deep dive already queued simply keeps running.
  Keyboard: `←`/`h`/`x` nope, space/`s` later, `→`/`l`/`d` dig deeper, `z` undo,
  `v` verify posting, `o` open posting. The keys belong to the deck alone: they
  are inert while the dialog is closed, while a field has focus, and for the key
  a focused button or link activates with — so
  the Space after clicking a button presses that button again rather than
  passing on the card. For the same reason the deck takes the dialog's initial
  focus onto an inert anchor: `showModal()` would otherwise leave it on the
  header's first sort chip, and a focused button owns Space, so the cheapest
  documented key would press the chooser instead of passing on the card. Pointer and touch swipes are a convenience on top: left is
  Nope, right is Dig deeper, past a fixed threshold and only when the drag is
  dominantly horizontal (a vertical drag is the operator scrolling the posting).
  The card is pointer-captured for the duration, and every way a drag can end
  without a release — `pointercancel`, a lost capture, the dialog closing under
  it — resets it with no verdict and no tilt left behind. A release that left a
  text selection behind commits nothing either: a drag across the facts or the
  fit copy is a native selection as much as it is a swipe, and the same travel
  that arms a verdict selects a line, so reading the card can never decide it.
  `prefers-reduced-motion` stops the card moving without stopping the verdict.
  `job_search_next_triage_candidate` is the agent-facing read of the same queue,
  and `job_search_dig_deeper` is the agent-facing right swipe; a plain reject or
  apply verdict still goes through `job_search_record_decision`.
- The deck's first load is one `?/triageQueue` read of three cards (issue
  #452). The session key returns `null` until the remembered ordering has been
  read out of `localStorage`, so a stored preference — the default included —
  can never cost a second read against a provisional ordering. The window is
  three rather than five because the deck shows one card and refills at two in
  hand, so the fourth and fifth cards were paid for on the paint the operator
  waits through. The hydration skips the `AgentRun`/`FactIntake` activity
  trail, which the card reads no field of and which is most of the payload.
  Measured on the dev mirror (8,772 undecided rows, local PostgreSQL), first
  window: 41.8 ms / 8 queries / 127.7 KB before, 22.8 ms / 6 queries / 53.6 KB
  after. The `latest.score` lateral the preset sorts by is already covered by
  `ensureOpportunityListQueryIndexes`
  (`idx_evaluation_scores_opportunity_fingerprint_updated`, an index scan at
  0.001 ms per row in `EXPLAIN ANALYZE`), so no index was added.
- The inactive-source sweep (`job_search_sweep_opportunities`, and the
  admin opportunities-list trigger) archives every `found`/`recommended`
  opportunity whose source is inactive and whose `last_seen_at` predates
  `notSeenDays` (default 30). It applies the same stale/archived transition as
  the closed-posting path plus `archiveReason: source_inactive`, records one
  `opportunity_sweep_source_inactive` `AgentRun` per apply, and is dry-run
  first: it reports the count and a sample and writes nothing until an explicit
  confirmation. Rows carrying a decision or application are never touched —
  the match excludes an `apply`/`maybe`/`reject` `human_review_status`, an
  existing `Application`, and an owner-authored `Decision` as well as the
  lifecycle status, because "Maybe" and an admin review both leave the row in
  `found`/`recommended`. Archived rows are hidden from the default listings but
  never deleted.
- The apply is two statements inside one transaction (issue #437). The first
  locks the candidate set with `SELECT … FOR UPDATE OF o SKIP LOCKED`, so a row
  another transaction is already writing is stepped over rather than waited on;
  the second archives exactly those locked ids and re-evaluates the whole match
  predicate against a fresh snapshot, so a row that gained a `Decision`, an
  `Application`, or an active source between the preview and the apply is
  skipped instead of archived. The counts are reported as `lockedCount` and
  `skippedCount` on the result, in the apply message, and in the audit. The dry
  run takes no lock and opens no transaction.
- Both automated archives — the sweep (`source_inactive`) and the board
  reconciler (`not_listed`) — close every open `review_recommendation` task of
  the postings they retire, in the same transaction as the archive (issue
  #434). The task moves to `canceled` in `rejected_archived` with a line
  appended to its description naming the archive reason, so the owner's task
  list never shows work against a posting that is already gone. Tasks of
  another type, tasks of other postings, and already-closed tasks are left
  untouched, and the count is reported as `reviewTasksClosed` on the sweep
  result and in both audits. That closure is a raw `UPDATE tasks`, and `tasks`
  is live-subscribed, so it bumps the `tasks` change feed with the ids it
  actually closed, inside the same transaction (issue #459) — otherwise a
  mounted task list keeps showing review work against a posting that is
  already archived, until it is reloaded.
- Every raw `UPDATE opportunities` writer — the sweep apply, the reconciler's
  re-stamp/absence/revive statements, the source-content fingerprint backfill,
  the two intelligence-status writers, and the six fenced
  `database.update('opportunities', …)` writers in the crawler, the details
  module, and the recommendation side effects — bumps SMRT's change feed
  through `bumpOpportunityChangeFeed()` after its statement (issues #436,
  #456). The bump mechanics live once in `change-feed.ts` as
  `bumpRowChangeFeed()`/`bumpTableChangeFeed()`; the per-table helpers
  (`bumpOpportunityChangeFeed()`, `bumpTaskChangeFeed()`) only name the table,
  so a second live-subscribed table records the same way rather than through a
  copy. Those writes go around `save()`, so nothing feeds the framework's
  change-feed interceptor and a mounted admin list kept its cursor and showed
  stale rows until a reload. The bump runs inside the same transaction as the
  write it describes, records the ids the statement actually returned,
  collapses a change of more than 100 rows into one table-level entry, and can
  never fail the write it follows. A fenced writer bumps only when its fence
  matched, because a bump for a row that did not change makes every poller
  refetch for nothing.
- Bumps only append; they never create the feed table (issue #458).
  `bumpChangeFeed()` is `ensureChangeFeedTable()` followed by `appendChange()`,
  and the ensure is memoized per database handle — but a bump inside a
  transaction gets a fresh transaction-scoped handle every time, so the memo
  was never warm there and the first bump after a deploy or a feed-schema
  migration ran `CREATE TABLE`/`CREATE FUNCTION` DDL inside the archive or
  reconciliation transaction. `db-migrate` now calls
  `ensureChangeFeedTableOnce()` alongside the other schema guards
  ("Ensured the SMRT change-feed table and append function."), and the bump
  path calls `appendChange()`, which issues no DDL — so no bump can put a DDL
  statement in someone else's transaction. Both the site and the worker
  deployment run `db:migrate` in an init container, so the feed exists before
  anything serves. That gate is load-bearing: `appendChange()` assumes the
  feed is there. On PostgreSQL it calls `_smrt_append_change`, and that
  function's PL/pgSQL exception handler only protects its own INSERT — it
  cannot protect a call to a function that does not exist. So on a database
  that never ran `db:migrate`, the append fails at the statement level and
  PostgreSQL marks the surrounding transaction aborted; the bump helper
  swallows the error, but the archive or reconciliation transaction it sits in
  then rolls back whole and is retried. That is fail-closed, not a stale list:
  no partial archive and no lost row, but the run does not complete until the
  feed exists. Run `db:migrate` before serving traffic on a fresh database.
- `change-feed-coverage.spec.ts` scans the server sources and fails
  when a raw `database.update('opportunities', …)` appears without a bump in
  its own function, naming the offending file and line. Add the bump rather
  than widening the scan.
- CLI and MCP CRUD commands can create/update the same records. Application and
  source writes through these surfaces run the same workflow sync hooks as the
  admin UI.

## Opportunity Intelligence Queue Operations

Automatic crawl-time intelligence fails closed. Full budget, key, circuit,
audit, canary, and incident procedures are in the
[opportunity intelligence runbook](./opportunity-intelligence-runbook.md).
The optional provider validation protocol and promotion gates are
in the [opportunity intelligence canary](./opportunity-intelligence-canary.md).
Opportunity extraction/scoring require an explicit `zai` or `openai` profile;
there is no automatic fallback, and application-writing remains on `good`.
The
`OPPORTUNITY_INTELLIGENCE_MAX_ENQUEUES_PER_CRAWL` environment variable defaults
to `0`, which is the deployment kill switch for new crawl-originated
intelligence work. The persisted control is a second, immediate request gate.
Set it to a small positive integer only for an explicitly approved bounded
rollout. Limit any cohort to the dedicated provider budget; no predecessor deployment quota is inherited.
The cumulative application request/token circuit thresholds may be set to zero
only when the dedicated gateway key has a reviewed calendar-month spend budget;
this preserves circuit telemetry and all per-run/per-crawl safety limits while
making that spend budget the sole global consumption quota.
The application clamps the value to an absolute maximum of 100 jobs per source
crawl. The limit is checked before each job is created; duplicate active jobs
do not consume the crawl's allowance. A slot is reserved before each queue
write and is released only when the queue confirms that no job was created.
Ambiguous failures retain the reservation, so a lost response after a commit
cannot exceed the hard cap.

Each opportunity keeps a canonical source snapshot in `sourceContentJson` and
hashes the intelligence-relevant source fields into `sourceContentFingerprint`.
Posting identity fields, including canonical/external URLs and IDs, are kept in
the snapshot and crawl provenance but excluded from the semantic fingerprint so
tracking parameters do not trigger paid work. A new or materially changed
snapshot is persisted with `sourceIntelligenceStatus=pending` before enqueueing.
If enqueueing fails, `enqueue_failed` is retried on a later unchanged crawl for
the same content version. `disabled` and `cap_exhausted` are terminal for that
crawl/content version; raising the cap does not create an automatic backlog.
Manual and recovery enqueues snapshot the opportunity's current fingerprint,
content version, and source before deduplication, so they use the same stale-job
contract as crawl-originated work.
Concurrent source writes allocate content versions with a fingerprint/version
compare-and-set, and delayed queue outcomes use the same fence so an older crawl
cannot overwrite a newer version's intelligence status.

Extraction and scoring overlay source-owned fields from `sourceContentJson`
instead of treating previously derived values as the posting of record.
Extraction persists `prepared-posting/v1`; scoring requires that exact payload
and sends only its bounded structured facts plus short attributable posting and
candidate-evidence excerpts. Deterministic gates handle configured clear cases
and missing evidence before the independently disabled optional model path.
Paid borderline scoring adds the scoring-input fingerprint to the transactional
reservation/idempotency/audit seam.
Unchanged crawls refresh source provenance without replacing extraction-owned
skills, responsibilities, qualifications, summaries, scalar enrichment, or
human workflow fields. Material changes refresh the source projection and reset
machine-owned enrichment before the replacement job runs. Missing company and
apply fields are backfilled separately only while those fields remain blank.
`EvaluationScore` rows retain source, crawl, crawl-item, fingerprint, and
content-version provenance. Stale historical scores remain auditable but are
excluded from current opportunity score views; evidence, quality, status, and
task side effects are fenced to the queued fingerprint. Automated status
transitions also compare the workflow status that was read, so concurrent human
decisions win. Automated research tasks carry the source fingerprint/version,
and both the task writer and material-change path conditionally cancel only
active automation tasks from strictly older content versions. Human-requested
tasks and concurrent tasks for the current or a newer version are preserved. A
material source change returns an unchanged,
automation-produced `recommended` status to `found` and closes its stale
recommendation-review task before the new version is scored.

To stop all new paid intelligence requests immediately and verify the persisted
gate in one action:

```bash
pnpm --filter @willgriffin/iolaus-site opportunities:intelligence-control stop
```

To disable new crawl enqueueing and drain safely as a longer deployment change:

1. Set `OPPORTUNITY_INTELLIGENCE_MAX_ENQUEUES_PER_CRAWL=0` in every process that
   can run source crawls, then restart or redeploy those processes. New
   `SourceCrawl` rows record an enqueue cap of zero, and eligible
   `SourceCrawlItem` rows record `intelligenceEnqueueStatus=disabled`.
2. Leave the jobs worker running to drain already-pending jobs. Verify the queue
   until both active counts are zero:

   ```sql
   SELECT status, COUNT(*)
   FROM _smrt_jobs
   WHERE queue = 'opportunity-intelligence'
     AND status IN ('pending', 'running')
   GROUP BY status;
   ```

3. Stop the jobs worker only after the query returns no rows if the intent is a
   clean drain. Stopping the shared worker also pauses source-crawl and
   auto-submit queues.

For an incident shutdown, apply the zero cap first, stop the worker, and cancel
only pending intelligence jobs after recording the operator reason:

```sql
UPDATE _smrt_jobs
SET status = 'cancelled',
    last_error = 'Operator cancelled pending opportunity intelligence during incident shutdown',
    completed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE queue = 'opportunity-intelligence'
  AND status = 'pending';
```

Do not rewrite `running` jobs to `cancelled`: the in-process queue cannot
preempt a handler that already started. The propagated abort signal and aligned
request/job deadlines from the request-safety baseline bound that in-flight
work. Before re-enabling, inspect failed/cancelled jobs and the originating
`SourceCrawl`/`SourceCrawlItem` provenance, choose a deliberately small cap, and
verify queued counts after one crawl.

## Resume Variant Agent Path

Agents can read and maintain variants through the discovered REST/CLI resource
`resumevariants` (REST also accepts the table-name spelling
`resume_variants`) and MCP tools named `resumevariant_list`,
`resumevariant_get`, `resumevariant_create`, and `resumevariant_update`.
Surface exposure is decorator-driven: the `api` / `cli` / `mcp` includes on
each `@smrt()` class decide what REST, the CLI, and MCP expose, so the resume
content classes (`ResumeProfile`, `ResumePosition`, `ResumeSkill`, ...) are
reachable the same way, and a class with an empty include stays off every
surface.

Typical tailored-application flow:

1. Create or update a `ResumeVariant` with `opportunityId`, `companyId`,
   optional `applicationId`, `tailoringConfigId`, `titleOverride`,
   `summaryOverride`, `emphasizeTags`, `excludeTags`, `includePositionIds`,
   and `excludePositionIds`.
2. Set `Application.resumeMode` to `generate_tailored` and, when preselecting a
   variant, set `Application.resumeVariantId` to that variant.
3. Run the application package action. It generates local artifacts only,
   records `Application.resumeAssetId`, and refreshes the variant artifact
   fields.
4. Keep the application in `awaiting_will` until Will approves the packet.
   Generated variants are never submission approval by themselves.

Archived variants are historical records. Package generation rejects an
explicitly selected archived variant and will not reuse archived variants when
choosing a fallback for the application or opportunity.

## Agent Contract Smoke

Use the CLI smoke check before closing agent contract changes:

```bash
pnpm --filter @willgriffin/iolaus-cli smoke
```

That command runs against a fake local SMRT API by default. It creates, updates,
and deletes a harmless `PreferenceRule`. For a live app, load `IOLAUS_TOKEN`
from an approved local secret source and pass only the server URL:

```bash
pnpm --filter @willgriffin/iolaus-cli smoke -- --server http://localhost:5173
```
