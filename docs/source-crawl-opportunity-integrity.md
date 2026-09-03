# Source crawl opportunity integrity

`SourceCrawlItem.opportunityId` is a nullable reference to `Opportunity`.
Deployed SMRT databases retain text Opportunity primary keys, so PostgreSQL
references a deterministic generated text form of that key and enforces
`ON DELETE RESTRICT`: generic Opportunity deletion fails while any crawl item
preserves provenance for that row.

The schema migration deliberately adds the foreign key as `NOT VALID`.
PostgreSQL still enforces it for all new inserts, updates, and parent deletes,
while existing dangling references remain available for an explicit audited
repair. The migration normalizes the historical empty-string sentinel to null
and refuses non-empty, non-UUID-shaped values instead of guessing how to repair
them.

Canonical URL deduplication is the only destructive merge path. It locks the
alias and survivor, retargets every linked crawl item, deletes the alias in the
same transaction, and verifies that no crawl reference remains on the alias.
Any failure rolls the whole merge back.

## Inspect a repair cohort

Inspection is read-only, keyset-paginated, and bounded to 500 rows:

```bash
pnpm --filter @willgriffin/iolaus-site db:repair-source-crawl-opportunities -- \
  --limit 100 --json
```

For another page, pass the last returned row ID as `--after-id`. Record the
exact plan SHA-256 before applying. Each applied row is moved to the explicit
`reconciliation_status=error` and `status=persistence_error` state, its invalid
reference is cleared, and its full pre-repair row—including `raw_json`—is
archived in `data_repair_audit`. The repair never creates or edits an
Opportunity or a user decision.

## Apply

Application requires the exact inspected fingerprint and the repository's
verified backup/recovery evidence. Before the first cohort, choose the batch
size and attest every page from one restored backup:

```bash
pnpm --filter @willgriffin/iolaus-site db:verify-backup -- \
  --from <verified-backup-directory> \
  --database-url <isolated-local-verification-url> --allow-reset-local \
  --source-crawl-limit 100
```

The verifier records the ordered digest for every resulting source-crawl page
separately from the tag-integrity plan. Local repairs verify those digests from
a dedicated composite evidence table, so later pages never require another
restore that would undo earlier cohorts. Production apply additionally
requires an explicit production flag:

```bash
pnpm --filter @willgriffin/iolaus-site db:repair-source-crawl-opportunities -- \
  --apply --target production --allow-production --limit 100 \
  --expected-plan-sha256 <plan-sha256> \
  --from <verified-backup-directory> --backup-sha256 <backup-sha256>
```

Each bounded plan has a stable audit identity, so retrying the exact applied
plan returns the recorded result without changing rows again. When the final
cohort reaches zero dangling references, the transaction validates the foreign
key. Confirm with:

```bash
pnpm --filter @willgriffin/iolaus-site db:status
```

`db:status` reports the key's validation state and exact dangling count. A
present but unvalidated key is the expected deploy-to-repair state; a missing
key fails status. Production repair and its post-deploy zero-dangling query are
an operations step; merging application code does not authorize a data mutation.
