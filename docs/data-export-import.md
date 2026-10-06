# Database export and import

Database maintenance is an advanced PostgreSQL capability, not part of the
first local-install promise. Configure your own database explicitly. Never use
someone else's production database, cluster or credentials.

`pnpm --filter @willgriffin/iolaus-site db:export` creates a backup from the
configured current database. `db:verify-backup` verifies its contents before
`db:import -- --from <backup-directory>` imports it. Read each command's help
and keep backups outside Git. Local-only and explicit-production confirmation
guards remain enforced by the maintenance tooling.

Backups are bound to the local data directory or hosted public origin that
created them. When deliberately moving a verified backup to a replacement
machine, data directory, or public origin, pass `--allow-installation-rebind`
to `db:import` or `db:reset-local`. Without that explicit recovery flag,
cross-installation restores fail closed.

The predecessor application's cluster-specific production pull command is
intentionally not distributed. Restore and backup procedures for a hosted
deployment belong to that deployment's private operational documentation.

The one-time willgriffin.dev → Iolaus migration completed on 2026-09-22
(willgriffin/iolaus#33). Its logical, asset, reconciliation, preservation, and
synthetic-rehearsal tooling was removed afterwards; recover it from Git history
(before willgriffin/iolaus#88) if a historical run ever needs to be reproduced.

## Hosted account export and deletion

Hosted users manage their own data without operator help. Both features act only
on the signed-in user's own tenant, owner, and profile; neither takes an id from
the request.

### Self-service export

`/admin/account` offers **Download my data**, backed by
`GET /api/account/export`. The response is an `attachment` named
`iolaus-export-YYYY-MM-DD.json` (no personal data in the filename) with
`cache-control: no-store`. It is available in `private` mode (the owner exports
their own workspace) and `shared` mode.

The document has `format: "iolaus-account-export"` and `version: 1`, and these
parts:

- `sections.profile`: candidate profile, links, resume profile and links.
- `sections.evidence`: achievements, experience, education, projects, skills,
  attachments, facts and the tags and links between them.
- `sections.preferences`: preference rules and reusable candidate answers.
- `screeningQuestions`: saved screening questions, split out of the preference
  rules that store them.
- `sections.applications`: applications and application material comments.
- `sections.materials`: generated resume assets, variants and tailoring.
- `sections.decisions`: decisions, their tags, and evaluation scores.
- `sections.assessments` and `sections.activity`: opportunity assessments and
  intelligence results, tasks, agent runs, and assistant turns.
- `assets`: a manifest of every generated file (kind, storage path, whether it
  currently exists) and, for resume and application PDFs, an authenticated
  download link on the app's own origin
  (`/admin/resume-assets/<id>/pdf`). The links need a signed-in session and stop
  working once the account is deleted, so save the files first.
- `counts`: records per class.

Excluded on purpose: the platform AI-spend ledger and the derived opportunity
ranking cache (platform records, not workspace content).

### Account deletion and retention

`shared` mode only. The user opens the confirmation, ticks the acknowledgement,
and types their email address and `DELETE MY ACCOUNT`; the server re-checks all
three against the verified session. Operators can run or finish the same deletion
with `account:delete` (below). It is irreversible.

| Data | Outcome |
| --- | --- |
| Candidate-owned workspace rows (every table in the ownership manifest, plus assistant turns, ranking cache, per-user AI cap override) | Deleted |
| Generated resume and application-package files (`generated-resumes/<asset-id>/`, `application-packages/<application-id>/`) and attachment files recorded in the user's rows | Deleted from storage (S3 or local). Only files named by the user's own rows under the user's own prefixes; the published/current resume is never touched |
| Sessions, CLI auth requests and device tokens, MCP/data-surface preview tokens, queued and finished jobs and job events for the tenant | Deleted. MCP OAuth tokens live at the identity provider; they stop working because the user, membership, tenant and invite are gone |
| Identity: user, profile and OIDC links, membership, grants, private tenant, tenant facts | Deleted |
| `ai_user_spend_entries` (platform AI spend ledger) | **Retained, anonymized**: tenant becomes `deleted`, owner becomes `deleted:<random id>` (random, not derived from the user), the provider request id is blanked. Amounts, period and feature are kept for platform cost accounting |
| Profile `audit_logs` | Deleted with the profile (they are bound to it by a required foreign key and can carry free-form metadata) |
| `hosted_invites` | **Retained, revoked**: the normalized email stays as the admission key so the address cannot silently re-enter. An operator can reinstate it with `invite:add` |
| `account_deletion_records` | **Retained** non-PII audit record: timestamps, who initiated it (`self` or `operator`), the random ledger id, and aggregate row counts. Its tenant and user ids are nulled in the same transaction that completes the deletion |
| Database backups | Not rewritten by the application. Deleted data leaves backups when they expire, which is the operator's backup period promised in the privacy policy |

Not covered: `data_surface_idempotency` rows hold an opaque apply-key hash and
outcome and are not addressable per user, so they are left to routine retention.

#### Ordering and partial failure

The deletion runs in three phases so a crash never leaves a half-visible
account, and every statement is keyed by tenant and user so re-running converges:

1. **Lock.** Write a `started` audit record, revoke the invite, deactivate the
   membership, user, and tenant, cancel queued jobs, and delete sessions and CLI
   tokens. From here
   the account is unusable: login is refused by the invite gate and live sessions
   fail revalidation. All data is still present.
2. **Files.** Delete the files named by the user's rows. The rows remain as the
   manifest. If any delete fails, the run stops with the account locked.
3. **Rows.** One database transaction deletes every row, anonymizes the ledger,
   and marks the audit record `completed` with its ids nulled. Either all of it
   commits or none of it does.

A tenant that has any other member is refused, so a self-service deletion can
never reach another user's tenant.

#### Recovering from an interrupted deletion

A failed or crashed run leaves a locked account and a `started` audit record.
The user sees an error saying the account is locked and the operator can finish
it. Operators:

```bash
pnpm --filter @willgriffin/iolaus-site account:deletions
pnpm --filter @willgriffin/iolaus-site account:delete -- --tenant-id <id> --user-id <id>
pnpm --filter @willgriffin/iolaus-site account:delete -- --resume-all
```

`account:deletions` lists unfinished deletions. `account:delete` (also accepts
`--email`) is idempotent: re-run it until it reports `deleted`; once finished it
reports `already-deleted`. A file-storage failure (`files` error) is retried the
same way once storage is reachable. If a deletion is refused as
`tenant-not-exclusive` or `scope-mismatch`, stop and investigate: the ids do not
describe one hosted user workspace. In `private` mode these commands refuse to
run.

Run the integration suites with `pnpm --filter @willgriffin/iolaus-site exec
vitest run src/lib/server/account-deletion.integration.spec.ts` (SQLite) and set
`ACCOUNT_DELETION_POSTGRES_TEST_DATABASE_URL` to a disposable PostgreSQL server
to add the PostgreSQL run.
