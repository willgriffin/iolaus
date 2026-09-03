# Source crawl accounting

Source crawl reporting is derived from durable attempt rows, not optimistic
in-memory counters. Each provider candidate has one `SourceCrawlItem` natural
key, `(sourceCrawlId, attemptKey)`, and begins with `outcome=pending`.

A pending attempt may finalize exactly once:

| Outcome | Meaning |
| --- | --- |
| `created` | A new opportunity transaction committed and its durable id is recorded. |
| `reused` | An existing durable opportunity was reused without a relist. |
| `relisted` | The candidate resolved through a provider alias or relisting. |
| `duplicate` | Global canonical dedupe selected an already-attributed record. |
| `skipped` | Policy or validation deliberately rejected the candidate. |
| `failed_persistence` | Persistence retries were exhausted without a durable opportunity. |

Terminal outcomes are immutable. Repeating the same finalization is
idempotent; attempting to replace it with another outcome fails. `created`
requires the committed opportunity id, and the existing
`source_crawl_items.opportunity_id` foreign-key guard remains authoritative.
The database also rejects `failed_persistence` rows that carry an opportunity
id. Generic admin, REST, CLI, and MCP resource surfaces expose crawl accounting
as list/get only; only the internal accounting workflow may create or mutate
these records.
Attempt creation locks and rechecks the running parent crawl, so a watchdog
cannot be followed by a new pending item. Failure, timeout, and interruption
terminalize pending items and reconcile aggregates in the same transaction.
Normal success likewise holds the parent lock from final reconciliation
through the terminal parent update. A worker that loses that fence refreshes
and reports the watchdog-owned terminal state as a failed execution instead of
returning success or overwriting it.

Before Opportunity persistence, the crawler durably records the final resolved
identities and the exact intended success outcome (`pending_created`,
`pending_reused`, or `pending_relisted`) bound to the exact Opportunity UUID.
New Opportunity persistence, created-attempt finalization, and aggregate
reconciliation share one parent-locked database transaction. A watchdog either
wins the parent fence before any insert or observes the committed `created`
outcome; it cannot be followed by a late unattributed Opportunity save.
Final detail, root, alias, and external-id identities are retained with the
pending attempt. If the worker disappears after the
Opportunity commit but before terminal accounting, the watchdog resolves those
identities under the parent lock and restores the intended outcome only when
the attributed Opportunity id committed. A later crawl's same-identity record
cannot be credited to the interrupted attempt. Multiple matching Opportunities,
or a match without an
explicit intent, fail closed and leave the crawl retryable instead of inventing
an outcome. `failed_persistence` is used only when no durable Opportunity can be
resolved.

`skipped` and within-crawl `duplicate` decisions also persist their exact
intended outcome and status before the terminal write. An uncertain write or
worker loss therefore retries or restores that decision instead of silently
reclassifying it as `failed_persistence`. Recovery checks every persisted alias
for ambiguity before restoring any outcome. URL identities are global across
sources, while external ids remain source-scoped; provider JSON that collides
with the accounting-owned recovery envelope is ignored unless the identity
member is an object.

Opportunity dedupe acquires advisory locks for every normalized identity used
by the lookup (final, root, canonical, posting, and discovered URLs plus the
source-scoped external id). Keys are sorted before locking so overlapping alias
sets serialize without deadlocking.

The aggregate invariant is:

```text
attemptCount = terminalCount + pendingCount
terminalCount = created + reused + relisted + duplicate + skipped + failedPersistence
```

`resultCount` mirrors terminal count. `newOpportunityCount`,
`duplicateCount`, and `skippedCount` remain the compatibility-facing counters;
the other outcomes have dedicated fields. A crawl may be declared terminal
only after reconciliation succeeds with `pendingCount=0`.

Database migration installs a partial unique attempt index so legacy rows with
empty attempt keys remain readable, plus validated outcome vocabulary and
outcome/opportunity-reference constraints. Check both guards with:

```bash
pnpm --filter @willgriffin/iolaus-site db:status
```

## Board reconciliation and posting freshness

A crawl of a listable board is the only trustworthy signal that a posting is
still listed, so freshness is derived from the crawl rather than from first
discovery.

- Every opportunity a crawl matched or created is re-stamped in one batched
  update: `last_seen_at = now`, `freshness = 'fresh'`, `missed_crawls = 0`,
  `last_missed_at = NULL`. Before this, only the create path stamped
  `last_seen_at`, so it tracked first-seen and every long-lived posting looked
  unseen.
- Every reconcilable opportunity of that source the board did not list counts
  as one consecutive miss: `freshness = 'stale'`, `missed_crawls += 1`,
  `last_missed_at = now`. Listing the posting again resets the counter.
- After three consecutive misses the posting is archived through the existing
  closed-posting transition (`freshness = 'stale'`,
  `human_review_status = 'archived'`, `status = 'archived'`) with
  `archive_reason = 'not_listed'`. Postings are archived, never deleted.
- Archiving a posting also closes every open `review_recommendation` task
  pointing at it, inside the same transaction (issue #434), so no task survives
  against a posting the board has stopped listing. The count is audited as
  `reviewTasksClosed`.
- That archival is an inference, not an owner decision, so it is reversible: if
  a later crawl lists the posting again it is restored to `status = 'found'`,
  `human_review_status = 'needs_input'`, `freshness = 'fresh'`, a cleared
  `archive_reason`, and a zeroed miss counter. Only rows carrying
  `archive_reason = 'not_listed'` are eligible — a posting archived by the owner
  or by the closed-posting preflight leaves that reason empty and is never
  resurrected.
- Only `found` and `recommended` rows participate. A posting carrying an owner
  decision is never re-stamped, missed, or archived.
- The two halves are gated separately, because they need different evidence.
  The re-stamp only needs the crawl to have matched the posting, so it runs for
  every non-dry-run crawl with a source binding — every provider, including one
  truncated by `limit` or carrying an unrelated per-candidate error.
- Absence accounting (miss, stale, archive) needs the crawl to be a complete
  enumeration of the board, so it runs only when *all* of the following hold:
  not a dry run; no crawl error; no unidentifiable board item; no failed
  persistence; no `limit`; at least one candidate; the durable accounting path;
  and a provider
  whose adapter enumerates the complete board in one authoritative response —
  Greenhouse, Ashby, and Lever. Every other adapter returns a capped,
  paginated, or relevance-filtered subset (`WORKDAY_MAX_CANDIDATES`,
  `MICROSOFT_CAREERS_MAX_CANDIDATES`, the 50-item aggregator caps,
  `candidateMatchesSource`), so a live posting is routinely absent from a
  successful crawl of one and absence there is not evidence of delisting.
  A skipped item is a posting the board *did* list, so it must not count as
  absent either. A whole-company board always lists roles the crawl skips as
  irrelevant, so those skips are resolved to their existing opportunity and
  recorded as seen rather than treated as an incomplete crawl — otherwise
  archival would be permanently inert on every real board. The same holds when
  only the per-posting detail fetch fails: the board still listed it, and every
  allowlisted adapter supplies the canonical URL and external id the identity
  lookup matches on — Lever, and Ashby on the SSR path, resolve every detail
  per posting, so treating those as incomplete would make archival inert for
  the whole source. Only a board item carrying no identity at all, an
  unresolved relist alias, or an ambiguous identity match makes the enumeration
  incomplete and suppresses absence accounting. A failed or partial crawl is therefore
  neutral, and a reconciliation failure is reported as a crawl error rather
  than archiving on incomplete evidence.
- Each reconciliation records an `AgentRun`
  (`run_type = 'source_board_reconciliation'`) carrying the source, the source
  crawl id, whether absence was counted, and the seen / refreshed / missed /
  archived / archive-failed counts.
- The re-stamp, the absence accounting, the archive transition and that audit
  are **one transaction** (issue #433). They commit or roll back together: an
  audit failure rolls the archive and the miss counters back, and a mutation
  failure aborts before any audit is committed, so a rolled-back crawl can
  never leave a `completed` audit behind. A rollback is itself recorded, as a
  separate `failed` audit written outside the aborted transaction with
  `rolledBack: true` in its output; the original failure is then rethrown.
- A posting that cannot be archived (a legacy row that fails to persist, see
  issue #431) is archived inside its own savepoint, so it is counted, rolls
  back alone without poisoning the surrounding transaction, does not abort the
  rest of the batch, keeps its miss counter, and stays archivable on the next
  crawl. That outcome commits with status `completed_with_errors`.

## Quarantining one ambiguous pending item

An operator may quarantine one explicitly selected pending item when recovery
cannot prove a terminal persistence intent. Inspection is read-only by default
and returns only bounded identifiers, status, eligibility, and the SHA-256 of
the complete crawl/item before state:

```bash
pnpm --filter @willgriffin/iolaus-site db:quarantine-source-crawl-item -- \
  --crawl-id <exact-crawl-id> --item-id <exact-item-id>
```

The command only permits a parent that is exactly `running`, unfinished, and
has a valid `started_at` at or beyond the application crawl timeout. It fails
closed for active/recent crawls or missing and malformed parent state. It also
refuses terminal items, attributed Opportunities, and statuses that contain a
recoverable success, duplicate, or skipped intent. Applying the plan requires
the exact fingerprint, a verified backup and digest, an operator reason, and an
explicit target. Production also requires the independent
`--allow-production` acknowledgement:

```bash
pnpm --filter @willgriffin/iolaus-site db:quarantine-source-crawl-item -- \
  --apply --target production --allow-production \
  --crawl-id <exact-crawl-id> --item-id <exact-item-id> \
  --reason "durable match is ambiguous and has no persisted intent" \
  --expected-plan-sha256 <plan-sha256> \
  --from <verified-backup-directory> --backup-sha256 <dump-sha256> \
  --recovery-plan-sha256 <attested-source-crawl-plan-sha256>
```

Apply locks the exact parent and item in one transaction, rechecks the stale
parent predicate and full before-state fingerprint, and archives both complete
rows plus repair metadata in `data_repair_audit`. It records only
`outcome=failed_persistence`, `status=persistence_error`, and a null
Opportunity attribution, then rebuilds the parent counters with the canonical
accounting reconciliation primitive. It never guesses `created`, `reused`, or
`relisted`. Repeating the exact applied plan returns the recorded repair result
without another mutation.

`--recovery-plan-sha256` selects a source-crawl recovery plan attested by the
verified backup restore; it proves that the backup is current, restorable, and
bound to the target database. `--expected-plan-sha256` independently binds the
quarantine mutation to the exact selected crawl and item before state.

## Recovering one stale legacy parent crawl

Older crawls can have a nonblank job id but a blank or zero `job_attempt`.
When every item is already terminal, the job failed (or the referenced job was
removed), and the parent was left `running`, the normal watchdog deliberately
fails closed because it cannot prove a positive attempt owner. Do not weaken
the watchdog ownership predicates to clear this state. Inspect the one exact
parent with the dedicated operator command instead:

```bash
pnpm --filter @willgriffin/iolaus-site db:recover-source-crawl-parent -- \
  --crawl-id <exact-crawl-id>
```

Inspection is read-only and prints only bounded identifiers, counts,
eligibility, and a SHA-256 fingerprint. The fingerprint covers the complete
parent row, the referenced job row (or its absence), and every item row in
deterministic id order. Eligibility requires all of the following:

- the parent is exactly `running`, unfinished, and older than the application
  timeout;
- `job_id` and `source_id` are exact nonblank bindings and `job_attempt` is
  blank or zero;
- no item has `outcome=pending` or a null `terminal_at`;
- the referenced job is absent, or is exactly source/queue/object/method-bound
  to the parent and exactly `failed`.

Before production apply, create a fresh production backup and fully restore it
with the exact crawl selected for separate parent-plan attestation:

```bash
pnpm --filter @willgriffin/iolaus-site db:verify-backup -- \
  --from <backup-directory> --database-url <isolated-local-url> \
  --allow-reset-local \
  --source-crawl-parent-recovery-id <exact-crawl-id>
```

Apply requires both the verified dump digest and that separately attested
parent-plan digest:

```bash
pnpm --filter @willgriffin/iolaus-site db:recover-source-crawl-parent -- \
  --apply --target production --allow-production \
  --crawl-id <exact-crawl-id> --reason "legacy failed job left parent running" \
  --expected-plan-sha256 <live-plan-sha256> \
  --from <verified-backup-directory> --backup-sha256 <dump-sha256> \
  --recovery-plan-sha256 <attested-parent-plan-sha256>
```

Apply takes an advisory transaction lock plus row locks on the exact parent,
referenced job (when present), and every item. It then rechecks the complete
fingerprint and eligibility, archives every complete before row in
`data_repair_audit`, and runs canonical accounting reconciliation. Only after
reconciliation proves `pendingCount=0` does it set the parent to `timed_out`
with an operator reason and finish timestamp. It never changes item outcomes,
assigns an Opportunity, attributes success, or mutates the job. An exact retry
returns the recorded repair result without another mutation.
