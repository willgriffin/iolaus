# Opportunity assessment test matrix

Issue [#137](https://github.com/willgriffin/iolaus/issues/137) adds a typed,
evidence-backed assessment contract. This matrix records the first executable
slice. Persistence and the governed provider invocation will add their own
database and transport evidence before they are enabled.

The contract separates reusable, source-attributed posting facts (sponsorship,
existing-authorization language, work arrangement, employment type, timezone,
and travel) from subject-scoped conclusions. Target-country availability,
domain and experience fit require both a posting passage and private candidate
evidence. Countries use an ISO alpha-2 code and display label; citizenship is
stored as context but never proves work authorization. A verified,
country-wide authorization can support a match. Employer-limited or conditional
authorization, undocumented residency, and any immigration pathway remain
unknown.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A posting claim has an exact source attribution | Typed result is resolved | High-confidence value and selected posting excerpt become a claim | Unknown source key, low confidence, missing provenance, or malformed answer is rejected | Posting assessment | Pure resolver; no write | Node | JEV predicate and choice result | Unit | `vitest ... opportunity-assessment.spec.ts` |
| Missing or truncated evidence does not invent a gap | Assessment preparation and resolution | Complete candidate evidence can support a role/experience claim | Truncated or absent candidate evidence resolves to `unknown` / `uncertain`, never a confirmed gap | Candidate profile | Pure resolver; no write | Node | Bounded JEV state | Unit | same |
| Each requirement keeps its own evidence pair | Typed requirement decisions | A required skill stores its posting clause and its supporting candidate passage | A gap is withheld if candidate evidence was trimmed, or if the model supplies a candidate source for a gap | Candidate profile | Pure resolver; no write | Node | Typed JEV per-requirement choices | Unit | same |
| Location is assessed for the intended work country, not citizenship | Personal compatibility projection | An explicitly allowed target location plus verified country-wide authorization is eligible | Citizenship, residence, a missing posting authorization statement, or unknown sponsorship never establish authorization; an authorization requirement with no proof remains unknown | Candidate profile | Pure resolver; no write | Node | No immigration-pathway inference | Unit | same |
| Sponsorship remains independent from location | Personal compatibility projection | Required authorization plus offered sponsorship is sponsorship-possible | Denied sponsorship only excludes a candidate who states sponsorship is required | Candidate profile | Pure resolver; no write | Node | Posting source assertions | Unit | same |
| Conflicting posting claims fail closed | Assessment resolution | A consistent answer is usable | An attributed `conflicting` decision or a conflicting persisted projection becomes an explicit conflicting outcome | Posting assessment | Pure resolver; no write | Node | Typed JEV choice / current-source validator | Unit | same |
| Cache material follows source/profile/contract/model, not preferences | Preparation and cache key | Changing candidate evidence or source changes request fingerprint; model changes cache key | Changing preference weights leaves prepared request and provider cache key unchanged | Candidate profile | Pure resolver; no write | Node | Provider idempotency key | Unit | same |
| Ranking is local and explainable | Ranking projection | Location bucket, domain and experience adjust score with active preference weights | Hard incompatible preference excludes without provider work | Candidate profile preferences | Pure resolver; no write | Node | `PreferenceRule.ruleJson` is malformed or unknown | Unit | same |
| User isolation | Persistence integration (pending #135 ownership audit) | A verified user can read only its own assessment/profile facts | Foreign profile or assessment id is denied | Authenticated user / tenant | Request-scoped DB transaction | SQLite + PostgreSQL | MCP/API identity switching | Integration | Pending #135 contract |
| Stale-safe persistence | Assessment refresh integration | Current source/profile identity commits once | CAS miss or concurrent profile/source change writes nothing | Refresh worker | Governed request then conditional update | SQLite + PostgreSQL | Retry/idempotence | DB integration | Pending provider/persistence slice |
| Native governed call | Five-posting bounded canary | One governed JEV request carries actual usage/provenance | Circuit, accounting, malformed provider result, or timeout produces no invented result | Owner-controlled run | Existing governance reservation | Production-like native runner | JEV `decide()` | Integration / operator | Pending root approval |

## Integrated-path additions

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Candidate-owned assessment mode | A queued workspace job requests `assessment` | Reads only the global posting plus subject-scoped candidate evidence and writes a private assessment/score | `all`, extraction, research, status updates, applications, and tasks are denied for a member-bound job | Verified tenant/user/profile | Job wrapper then processor | SQLite + PostgreSQL | TaskRunner runtime subject envelope | Integration | Job + intelligence spec |
| Subject material is queue-idempotent | Candidate enqueue derives the material fingerprint | Identical retries for one profile reuse a job/result | Equal resume/posting bytes for a different user/profile produce a different fingerprint and cannot dedupe | Verified workspace | Queue dedupe then private conflict key | SQLite + PostgreSQL | No caller-controlled ownership envelope | Unit + integration | input/job specs |
| Eligibility facts fail closed | Onboarding or direct private profile record supplies country data | Valid ISO code and label persist; verified country-wide authorization is usable | Free text, `CA` ambiguity, malformed JSON, missing labels, or conditional/employer-limited authorization cannot prove compatibility | Candidate profile | Scoped profile save | Node | Country code/display label contract | Unit + route | eligibility/onboarding specs |
| Provider preflight is bounded | JEV assessment is prepared | Request fits 64 KiB and reservation derives from typed response criteria | Oversized request or response reservation fails before a billable provider call | Governed AgentRun | Existing reservation/control history | Native JEV | `decide()` has no max-output option | Unit + operator | provider spec/canary |
| Current private projection parity | List API or triage action loads a bounded opportunity set | Both attach the same source-current private `assessmentProjection` for the session-hook-verified tenant/user/profile tuple | A supplied URL/form value never selects a profile; foreign, stale, malformed, or missing rows map to unknown and never leak raw assessment JSON | Verified workspace | Scoped batch projection lookup | SQLite + PostgreSQL | Admin + MCP view models | Route + integration | `admin-resource-route.spec.ts`, `opportunity-triage.spec.ts`, and admin route specs |
