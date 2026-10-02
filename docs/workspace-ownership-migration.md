# Private workspace ownership migration

Run this only on an isolated copy of a legacy private installation, before the
normal schema migration strengthens its existing tables. It prepares that single-owner history
for the default private mode and for a later, explicit `shared` deployment;
it does not enable shared hosting, change identity-provider settings, or alter
prices, limits, provider configuration, source history, or candidate content.

The operator supplies the verified canonical tenant, authenticated User, and
CandidateProfile identifiers through protected local input. The tool does not
print them. It validates that there is exactly one candidate profile, every
candidate-owned table has the required ownership columns, and every row is
either completely unbound or already exactly bound to that tuple. A foreign or
partially written tuple, an extra profile, or a missing column makes the plan
ineligible. It never
chooses a first row, rewrites an historical target ID, or uses a missing legacy
opportunity/application reference as an error condition.

First take the normal verified backup and work on a restored isolated copy.
This upgrade has four ordered phases. Do not use this procedure for a fresh
installation: a fresh private or shared install runs the ordinary native
database migration, then creates records through the subject-bound workflows.

First add the ownership columns on the isolated legacy copy. This command adds
only nullable columns with the model's native scalar type and never creates unique keys, changes defaults, or
writes a row. It reports any model table absent from the legacy copy as a
native-empty-table requirement; that is expected for newly introduced models,
but is never silently treated as a backfillable legacy table.
It also adds nullable scalar fields for the current private assessment
projection; they stay unknown until the bounded, token-free preference rerank
writes a source/profile/preferences-current value.

```sh
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/prepare-workspace-ownership-schema.ts
```

Create only those reported absent tables with the native schema planner, then
rerun the nullable phase and require a successful receipt. This phase rejects
any planned alteration of an existing table, so it cannot apply new required
constraints to legacy rows before their reviewed ownership binding.
The create-only migration executes atomically because a new table's native
null-equal conflict index requires that mode; it never enables non-atomic
replacement or alteration of an existing index.

```sh
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/create-workspace-ownership-empty-tables.ts
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/prepare-workspace-ownership-schema.ts
```

Then produce a reviewable plan. The identifiers come only from the protected
canonical-subject receipt; do not place them in shell history, logs, or issue
comments.

```sh
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/backfill-workspace-ownership.ts \
  --tenant-id '<verified tenant ID>' \
  --owner-user-id '<verified user ID>' \
  --candidate-profile-id '<verified profile ID>'
```

The command reports aggregate per-table counts and a `planSha256`, without
printing IDs or private fields. It detects the configured PostgreSQL or SQLite
dialect before it reads schema metadata. Do not apply an ineligible plan. When
the reviewed plan is eligible, execute the exact digest against the same
isolated database:

```sh
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/backfill-workspace-ownership.ts \
  --apply \
  --expected-plan-sha256 '<reviewed planSha256>' \
  --tenant-id '<verified tenant ID>' \
  --owner-user-id '<verified user ID>' \
  --candidate-profile-id '<verified profile ID>'
```

Apply re-plans inside one transaction and uses compare-and-set updates. If any
row changes after review, no partial ownership binding is retained. The only
columns it writes are `tenant_id`, `owner_user_id`, and, for child records,
`candidate_profile_id`. Historical source and agent records retain their
original references even when an intentionally retired opportunity no longer
exists. Blank-tuple `OpportunityIntelligenceRequest` and
`OpportunityIntelligenceResult` rows are immutable operator/source ledger
history and remain blank; only future candidate-bound request/result rows are
stamped by the governed reservation workflow. A mixed-ledger partial or foreign
tuple is still ineligible and is never guessed.

Only after a successful reviewed apply, run the ordinary native migration on
the same isolated copy. This is the enforcement phase: the current model
schemas and CandidateProfile conflict key can now add their non-null and unique
requirements without encountering an unowned legacy row.

```sh
pnpm --filter @willgriffin/iolaus-site db:migrate
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/check-workspace-ownership-enforcement.ts
pnpm --filter @willgriffin/iolaus-site db:status
```

The final check is read-only and reports every missing or nullable ownership
column, a partial mixed-ledger tuple, and a missing CandidateProfile or
OpportunityAssessment conflict index without disclosing rows or identities. It
is a receipt that the native enforcement phase completed; it never drops an
unknown constraint or index.
