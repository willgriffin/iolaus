# Private candidate skill discovery

Issue #161 is local daily-use work under the root session claim. No migration,
release, public resume edit or worker provider call is part of this change.

Discovery uses `candidate-skill-discovery/v1-named-capability`, a separately
registered fixed `jev-1.13.0` typed decision contract. Existing screening V8 and
historical contracts are unchanged. The native global budget, quota reservation,
actual accounting and provider circuit remain authoritative.

The vocabulary is deterministic: available shared posting required/preferred
labels, explicit career skill labels and literal career occurrences of the finite
alias vocabulary. Career vocabulary is prioritized before unfamiliar posting
labels. Posting requirements never count as candidate evidence. All applicable
owned resume evidence, private verified skill-experience notes, private confirmed
skills and accepted facts targeting this CandidateProfile are included. Opportunity
facts and foreign/private rows are excluded. This is a vocabulary-scoped pass,
not unrestricted extraction of arbitrary new skill names.

Each action assesses at most one adaptive batch of eight labels, retaining every
career fact and exact group membership. The UI exposes assessed and remaining
counts and continuation. It never silently truncates the career catalog. A
context that cannot accommodate even one label fails closed. Completed batches
persist and resume. Native request idempotency allows recovery after provider
success followed by profile persistence failure without another provider call.

Private review state is stored in `preferencesJson.skillDiscovery`; provider
context strips it. Confirmation stores exact `user_verified` records in
`factsJson.facts.confirmedSkills`, including direct/introductory classification and
original citations. It never infers years, seniority or public resume changes.
Unknown proposals cannot be confirmed. Explicit human dabbling prevents a direct
classification from upgrading that skill. A confirmed introductory skill remains
introductory in active matching.

| Risk / behavior | Evidence |
| --- | --- |
| Alias dedup and literal vocabulary priority | Backend vocabulary fixture |
| All 201 complete facts retained in <=12 exact groups | Backend engine fixture |
| Direct vs introductory vs unknown; unchanged .85 support threshold | Typed score/witness fixtures |
| Primary TypeScript/Node vs dabbled Python/Java | Explicit verified-note fixture |
| Missing/invalid choices, distributions, scores | Fail-closed engine fixtures |
| Private pending state; no canonical changes until confirmation | Discovery and confirmation fixture |
| Exact native proof required at confirmation | Tampered proposal rejected after native re-resolution |
| Sibling confirmations remain current; repeated confirmation idempotent | Two confirmations and retry fixture |
| Stale career material, foreign owner and CAS race | No-write rejection fixtures |
| Evidence or permission changes during native proof await | Fresh authority/catalog re-entry at final write fence; title/project/revocation fixtures |
| Profile semantic field race after read | Native SQLite CAS additionally pins title/summary/name, with title-edit no-write regression |
| Unrelated basic/advanced onboarding save | Strict server-confirmed direct/introductory skills and exact private depth note survive; forged form and malformed legacy values cannot become confirmations |
| Shared 2606-posting vocabulary, candidate-only accepted facts | Complete posting/target fixture |
| One batch per action, explicit remaining scope, continuation | 31-label resume fixture |
| Exact SQL columns/bindings; atomic facts+preferences, owner/stale checks | Native isolated SQLite CAS fixture |
| Concurrent discovery/review and lock-session loss | Native profile-keyed lifecycle lock and short lock-checked transaction; real process-loss concurrency remains a manual scenario |
| Receipt authority | Native q/r/run ownership, fingerprints, contract, success and actual-accounting joins; malformed/tampered output fails re-resolution |

Worker verification: isolated snapshot backend plus config suites **67/67 passed**
(`/tmp/iolaus-discovery-tests.log`). These tests validate structure and safety;
actual model semantic quality is established only by root-controlled native QA.
No worker paid requests were made. The root's read-only preview loaded 151 career
evidence occurrences and 174 vocabulary entries without provider calls or writes.
Accepted review blockers were verified by the targeted onboarding/discovery suites:
31/31 passed (`/tmp/iolaus-discovery-blocker-tests.log`).

Remaining manual checks: native typed pilot direct/introductory outcomes; native
receipt confirmation; public resume hashes unchanged; combined UI/currentness
validation; interruption/resume and production advisory-session loss. Root owns
the budget-controlled real QA and issue handoff.

### Live daily-use verification (2026-10-05)

- Native read-only preview loaded 151 career evidence records and 174 vocabulary labels; shared posting pagination succeeded without introducing private ownership columns on Opportunity.
- Three governed JEV batches assessed 24 labels with actual usage accounting; total incremental cost was 2,090 micro-USD. No OpenAI request, budget change, or human confirmation was made.
- The browser Continue action advanced persisted progress from 8 to 16. The third bounded batch produced an evidence-backed standalone skill proposal; existing canonical skills stayed duplicates and unsupported skills stayed unknown.
- A native confirmation dry-run validated the real owned q/r/run receipt and fresh authority, then deliberately aborted at the injected persistence boundary. The proposal remained pending, preserving user confirmation authority.
- Phone-width browser inspection at 390×844 verified readable cards, evidence disclosure, and full-width review controls; viewport restored. Screenshot: `/tmp/iolaus-skill-discovery-mobile.png`.
- Final combined isolated validation: 168 tests and 3 browser tests passed; Svelte check 0 errors / 0 warnings. Targeted independent recall cleared onboarding preservation, audit-timestamp currentness, and post-proof permission/evidence/CAS races. Strict SMRT domain freshness: 0 issues.
- Local direct-dev delivery only, per user instruction; no production deployment, migration, or release PR. The scan remains partial (24/174), and no user skill was confirmed automatically.
