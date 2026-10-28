# Public profile API behavior/test design (#235)

Risk: high — anonymous public privacy boundary. API tests use synthetic data only.
Each row uses the common execution context unless overridden: read-only resolver,
no API writes or transaction; Node/SvelteKit runtime; SQL is unchanged (existing
SQLite and PostgreSQL resolver suites cover persistence); API unit tests plus
existing service, projection, hooks, and in-process SQLite lifecycle tests.

Validation command for all rows: `pnpm --filter @willgriffin/iolaus-site exec vitest run src/lib/server/public-profile-api.spec.ts src/hooks.server.spec.ts src/lib/server/public-profile-service.spec.ts src/lib/server/public-profile-render.spec.ts src/lib/server/public-profile-store.sqlite.spec.ts`.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Data executor/transaction | Supported runtime/dialect | External contract edge | Test level | Validation command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Strict DTO/current snapshot only | GET handle | current immutable content, opaque revision, revision creation time, controlled links | extra private fields, bad URLs, unknown storage version, malformed fields rejected | anonymous/signed-in, foreign active workspace identical | read-only resolver; no write transaction | Node; unchanged SQL | missing optional contacts accepted; unknown fields fail closed | API + projection/service | common command above |
| Visibility and publication isolation | GET after private edit/publish | selected contacts/sections preserved; new publication replaces revision | unselected sections/contacts absent; private edit invisible; no foreign owner snapshot | owner A/B; anonymous and foreign signed-in | existing store join/current pointer; no new SQL | Node; SQLite lifecycle; PostgreSQL unchanged | published handle only, no source identifiers/history | API + existing SQLite/service/projection | common command above |
| Uniform unavailable | GET absent/invalid/withdrawn/deleted/disabled | typed bounded 404 | database/config failure is typed 503; no exception details | any actor/no active workspace | resolver read only; no rollback applicable | Node; SQL unchanged | malformed handle => unavailable; corrupted snapshot/operational failure => 503 | API + lifecycle | common command above |
| Anonymous transport | GET/HEAD/OPTIONS | same headers, HEAD no body; OPTIONS no lookup | invalid/expired Authorization ignored; cookies never extended | anonymous, session, malformed bearer, foreign workspace | session/tenant setup bypassed for exact endpoint only | Node/SvelteKit | no-store every response; wildcard credential-free CORS GET HEAD OPTIONS only | hooks + API | common command above |
| Grounded assistant admission and privacy | POST chat/voice | allow-listed origin streams a reply built from the snapshot; voice answers an audio offer with a bounded call | disabled/unknown handle 404; foreign origin 403; bad media 415; malformed body/offer 400/413; address, handle and concurrency windows 429; provider failure 502/503 with no internals | anonymous browser and server-to-server | read-only resolver; in-memory windows per replica; no writes | Node/SvelteKit | published snapshot is the only model context; links advertised only while enabled | API unit (`src/lib/server/public-profile-assistant.spec.ts`) | `pnpm --filter @willgriffin/iolaus-site exec vitest run src/lib/server/public-profile-assistant.spec.ts` |
| Discoverable contract | fixture/schema consumption | synthetic fixture validates | unknown API version, malformed values rejected | external static-site consumer | N/A: local JSON validation only | Node JSON Schema/Zod; no SQL | API version independent of storage; unavailable distinguishable from generic routing404 | schema + API | common command above |

No bug-fix base regression is applicable: this adds a new endpoint. Retry,
partial mutation failure, rollback, and idempotency are N/A because this endpoint
performs no writes. Existing resolver persistence behavior is unchanged; the
in-process lifecycle tests verify owner isolation and publication/withdrawal.
Full repository validation and independent review belong to integration.
