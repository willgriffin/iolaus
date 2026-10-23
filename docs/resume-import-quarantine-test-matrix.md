# Original PDF quarantine behavior matrix (#227)

All persistence uses the supplied native executor. Ledger insertion is one atomic
INSERT ON CONFLICT DO NOTHING with a database composite unique key; no parent FK.
No background writer marker expires. Node 26, native SQLite and PostgreSQL are
supported; root integration owns PostgreSQL execution and full native lifecycle.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Executor/transaction | Runtime/dialect | External edge | Test level / command |
|---|---|---|---|---|---|---|---|---|
| First revocation deadline fixed | native resolver delete | day5->35, expiry day30->60 even with a delayed sweep | repeated callback and purged callback never extend | native private tenant | single unique INSERT; durable deletion created_at | SQLite + PostgreSQL | evidence redaction/restart | quarantine integration spec; root PG/native host integration |
| Immediate read/write denial | resolver operations | active original allowed | expired visibility, tombstone, foreign URI denied | asset tenant + exact configured store | supplied db, live native state | both | late writer already in flight remains uncertain | quarantine integration + storage specs |
| Original only | native delete | root Resume.pdf PDF retained | derived evidence physically deleted | exact native evidence ownership | supplied db | both | deleted metadata replay uses durable tombstone | quarantine integration + native host |
| Account deletion survival | account deletion after native expire | scalar identity and tombstone survive | no FK/cascade, missing provenance fails closed | deleted owner | ledger commits before metadata redaction | both | #225 drain unchanged | quarantine integration + root account/native integration |
| Purge independent of profiles | worker interval | due object physically deleted, tombstone retained | provider failure retries; missing object succeeds; unresolved writes prevent finality | system retention | supplied db, marker checks before/after I/O | both | raw provider DELETE through SDK | quarantine integration; root native/Garage |
| Explicit recovery authority | service exact ledger ID | tenant+actor+destination authorized, checksum matches | foreign tenant, refusal, expired/purged, bad checksum, failed audit deny | operator only; no account reactivation | audit INSERT before I/O, verified outcome before return | both | raw provider read only | quarantine integration; root PG |
| Ledger rollback | transaction abort | committed identity visible | aborted insertion leaves no row | native executor | native rollback | both | N/A: SQL only | quarantine integration; root PG |
| Cluster HTTP opt-in exact | hosted config load | exact service + flag + garage region + path style | arbitrary HTTP/near-match/missing flag rejected | protected runtime config | N/A: pure validator | Node | Garage plaintext inside constrained cluster network | storage spec |

Run narrow checks from apps/site with Node26:
`pnpm exec vitest run src/lib/server/resume-import-quarantine.integration.spec.ts src/lib/server/resume-import-storage.spec.ts`.
SQLite execution is in process. PostgreSQL/native lifecycle and disposable Garage
qualification remain integration gates; no production fault injection is used.

Worker evidence (Node 26.10.0, in-process SQLite; no service containers):

- Focused native/application set: 8 files, 91 passed, 37 opt-in cases skipped.
  Includes real native account deletion retaining/recovering originals, independent
  later physical purge, marker-drain checks and receipt replay behavior.
- Final focused checks after deadline/bounded-sweep changes: 7 files, 68 passed,
  12 PostgreSQL cases skipped. Covers exact/malformed configuration, private model
  exposure, runtime entrypoints, schema readiness and account copy.
- `git diff --check` passed; targeted Biome formatting completed. The host spec's
  existing non-null assertion warnings remain unchanged.
- Root integration must execute the 12 PostgreSQL contract cases using
  `RESUME_QUARANTINE_POSTGRES_TEST_DATABASE_URL` with the isolated
  `/iolaus_resume_import_qa` database, full native PostgreSQL lifecycle and the
  disposable actual Garage qualification, followed by integrated checks/review.

The resolver's source classifier uses the host's normalized `partId: 'Resume.pdf'`
plus root evidence and PDF media type. Original user filenames are arbitrary;
the recovery fixture uses `CV-final-2026 (reviewed).pdf` as its asset name.
