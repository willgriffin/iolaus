# Issue 154: title pre-screen and JEV sizing

Local daily-use implementation; no release or expanded batch.

| Behavior | Trigger / actor | Positive | Negative | Executor / runtime | Edge / level | Validation |
|---|---|---|---|---|---|---|
| Title-only routing | Owned Run screening | Clear unrelated role skips full call | Ambiguous/related/low-confidence and missing target roles continue | Existing native owner lifecycle; SQLite test + PostgreSQL daily app | JEV typed choice; provider/service tests | targeted Vitest |
| Currentness and cache | Repeat or edit roles/source/questions | Exact receipt reused | Stale inputs, foreign owner, failed identity never reused | Existing native q/r/run joins; no schema changes | Service integration | targeted Vitest |
| Honest display | Skipped full assessment | Label title pre-screen, no percentage | Full screen retains normal score | Svelte and server projection | Component test + browser QA | targeted Vitest and daily browser |
| Token admission | US-only 72,913-byte fixture class | Conservative token estimate admits under actual context/run bounds | Oversized/non-ASCII/punctuation still blocked | Pure preparation; governance reservation | Unit regression | targeted Vitest |
| Accounting and history | New v4 request and old receipt | Byte-based financial reserve retained; actual usage settles | No caps raised; v1-v3 preflight replay unchanged | Native governance | Unit/service regression | targeted Vitest |

Provider documentation: https://docs.typesafe.ai/models (64K request; 32K state plus longest question). No documented exact JEV tokenizer found. The estimate is explicitly an estimate, with conservative headroom; provider remains the context authority. Financial reservation continues using UTF-8 bytes. Historical versions retain byte admission for exact receipt replay.

## Local verification, 2026-10-04

- Provider, service/SQLite receipts, governance, config, endpoint and projection/UI suites: 119 passed (`/tmp/iolaus-154-tests.log`). Mounted client action tests: 3 passed (`/tmp/iolaus-154-browser-tests.log`). Static Svelte check: 0 errors/warnings (`/tmp/iolaus-154-check.log`).
- SMRT deterministic review routed tenancy/relationship and generated-surface scrutiny; inspected native owner joins, fresh authority fences, unchanged model API and strict route override. Knowledge freshness: 0 errors/warnings. Independent worker review unavailable under current worker quota; no release claimed.
- Real daily PostgreSQL/native/browser proof (`/tmp/iolaus-154-live-receipt.json`): Junior Accountant stopped at title with 0.99 confidence, no full score. Support Engineer, VIP continued at 0.61 confidence, full screen returned Canada=No with explicit US residence/citizenship evidence, recommendation14.3%, coverage78.6%. Senior Software Engineer continued, full recommendation60.7%, coverage71.4%.
- US-only request: 72,913 bytes, estimated input47,413, actual input21,349. Prior byte+output admission80,999 exceeded80K; new55,499 total reservation fits. Byte-priced money reservation stayed3,063micros; actual897micros. No captured source or career evidence truncated.
- Five real JEV calls cost1,825micros ($0.001825); each title call22micros ($0.000022). No Sol calls. Overall basis$0.622923 / unchanged$0.75, small experiment$0.009642 / unchanged$0.02; active0, unsettled0. Human review state, history and ordinary queued job preserved.
- Current results invalidate with owned profile/roles, source, question revisions, or version. Exact successful receipts reuse without billing; prior failed identities stay blocked. Full review override is a same-origin boolean routing choice, never an owner/model/question override.
- Small live sample only. No source crawl or database-wide assessment resumed. Heuristic token admission remains intentionally conservative and is not an exact vendor tokenizer.

Final list/detail/query regression check: 110 passed, 2 pre-existing skips (`/tmp/iolaus-154-list-tests.log`). Total executed: 232 passed across provider/native/governance/UI/query and mounted client suites.
