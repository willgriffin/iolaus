# Agent-first coordinated release

Status: executable design; implementation and acceptance evidence are tracked separately. Scope is Iolaus #194 P1–P11 plus every remaining #135 acceptance item, coordinated with SDK, SMRT and IaC. The current user request authorizes implementation and supersedes #194's original planning-only wording; it does not itself prove production or external-host acceptance.

## Baseline and decisions

Work in sibling checkouts `/Users/will/Work/_trees/agent-first-release/{sdk,smrt,iolaus,iac}`, branch `codex/agent-first-release`, starting from each repository's fresh origin/main. Epic: Iolaus #195. Claimed children: SDK #1367, SMRT #3659, IaC #2210, Iolaus #196 analysis, #197 search, #198 matching, #199 integration. Root coordinates claims and release; workers own only assigned files. Never revert another worker's edits. Record actual source commits and installed package hashes with final evidence.

On 2026-10-07, `reflect-domain-knowledge` and `smrt-architecture` ran against the Iolaus sibling. Source scanner found 73 objects; freshness was OK with zero issues. This is source context, not build, database, or production evidence. Read root and site AGENTS and project.yaml; apply the test-design-contract matrix below before implementation.

Defaults: public catalog only in shared-hosted mode; compensation only when posted; pinned extraction `openai/gpt-6-luna` with existing prices and caps; no budget increase; no cluster pgvector/image change; vectors disabled unless an embedding route is explicitly configured. Source opt-out is mandatory. Candidate data, including the owner's decisions, never trains global priors or public skill graphs. Directory submission remains a separate owner action.

Integration prerequisites discovered during local validation: SDK file-backed SQLite connection recovery after native lock contention; the upstream AI JSON-schema response-format type contract previously carried as an Iolaus declaration patch; and SMRT #3660, an explicit qualified table binding to keep the transitive messages Attachment separate from Iolaus's existing attachments. These remain in the same coordinated release and receive their own regression evidence. Node 26.10.0 and pnpm 11.25.0 are required by the selected upstream source snapshots.

Measured public-search capacity on the synthetic 10,000-posting fixture meets the repeated-query p95 target (about 41 ms on local PostgreSQL). A cold complete search plus facets is about 870 ms across multiple SQL statements; the largest measured statement is about 318 ms under the actual restricted role's 500 ms statement timeout. These measurements do not establish a cold-request or production latency SLA.

Corrections to issue #194:

- `packages/auth` in SDK currently implements client/provider adapters, not a reusable authorization server. Add the protocol upstream there. SMRT owns persistent user/session/grant integration; Iolaus owns consent and application policy.
- Current `mcp-oauth.ts` checks external issuer mappings and active membership. A local issuer needs live grant/session revocation checks as well as JWT validation; configuring local JWKS alone is insufficient.
- `canonicalSkill()` is synchronous and widely reused. Preserve its signature with an explicitly loaded immutable vocabulary lookup; do not introduce hidden database I/O or process-global cross-workspace candidate state.
- A missing skill or unknown requirement is not a proven conflict. Count only explicit contradiction in `mustHaveConflictCount`; expose missing/unknown coverage separately.
- Do not fabricate probabilistic calibration. A deterministic coverage score is a score until a held-out private evaluation validates calibration. Cold-start weights are authored public constants, never trained on owner's private labels.
- SQL generated columns cannot join Company/Opportunity/SkillTerm. Materialize a sanitized search document transactionally, then generate/index its tsvector. A partial index cannot predicate on another table's status. Enforce current source visibility and active opportunity at every query, including cache invalidation.
- Public-only import rules cannot include a private `/me/matches` implementation. Put private logic outside `public-search`; public-namespaced authenticated routes are explicitly private and `no-store`.
- Do not invent a 30-day JobPosting expiry or salary conversion. Omit unknown optional fields, preserve explicit expiry, remove inactive listings, and label summaries as derived. Do not claim Google rich-result acceptance from schema validation.
- #194 throughput, cost, dataset counts and quality numbers are hypotheses until measured. New independent analysis windows still consume existing global/provider budgets; a new queue cannot bypass the gateway cap.

## Ownership and sequence

| Lane | Owned paths | Deliverable/dependencies |
| --- | --- | --- |
| SDK auth | `packages/auth/src/server/**`, public exports/build metadata and auth tests/docs | Portable OAuth server protocol and injectable transactional persistence contract; no SMRT imports |
| SMRT users/auth | `packages/users/src/{objects,collections,services}/OAuth*`, users exports/tests; `packages/smrt-app-mcp` auth adapter | Durable clients/codes/grants/refresh families bound to live user/session, reusable MCP resource adapter; consumes SDK packed auth |
| Iolaus analysis | new `SkillTerm`, `OpportunityAnalysis`, `OpportunitySkill` objects/collections, `lib/opportunity-analysis-contract.ts`, `lib/server/opportunity-analysis*`, skill vocabulary/discovery integration, analysis scripts/jobs | P1–P3; coordinate shared Opportunity, Source, object registry, db migration and package.json edits through root |
| Iolaus search | `lib/public-opportunity-contract.ts`, `lib/server/public-search/**`, `routes/api/public/v1/**` except `me/**` | P4; owns schemas and read-only reader, re-exports anonymous P6 matcher owned by matching lane |
| Iolaus match | `lib/server/opportunity-matching*`, `lib/server/public-search/match.ts`, `RequirementEvidenceDecision`, `MatchModel`, private matching route and evaluation script | P6–P7 including pure public anonymous match.ts through search reader; root coordinates rank object/projection and private resource registry edits |
| Iolaus public UI | public page components, root page shared-hosted branch, opportunities/companies/skills pages, sitemap/opensearch/robots | P5; consumes search contract, preserves private-mode home and authenticated board |
| Iolaus MCP/auth | `mcp-app-server.ts`, `mcp-oauth.ts`, MCP routes, OAuth routes/consent/account grants, manifests and MCP test matrix | P8–P9 and #135; consumes search and upstream auth exports; preserves existing owner workflows |
| IaC | jobgeni manifests, tenant postgres role and ACL, relevant tests/docs | P10–P11; public role, explicit trusted-client-IP capability, deployment ordering; no cluster image change |
| Root integration | shared registries/migrations/package manifests/lockfiles, tarball closure, reviews and release evidence | Serializes overlapping edits, independent review and final ship |
| Plan | this document only | Contract coordination; no implementation |

Sequence: freeze DTO/service contracts → implement SDK plus independent analysis/IaC work → build/pack SDK auth → SMRT auth → pack full SMRT closure → integrate Iolaus auth; in parallel analysis → search → UI/MCP and deterministic matcher → private Stage 3/reranker. Run local contract/integration checks throughout. Do not wait on intermediate remote CI; run CI and required approvals at final shipping, as requested. No source is silently dropped because another lane is incomplete.

## Shared TypeScript contract

The following exports are the coordination baseline. Implementers may reconcile names once with root before changing consumers. Browser-safe schemas/types live in `lib/`; neither public schema module imports a private server module. Zod schemas generate REST/OpenAPI and MCP input/output schemas. Public output parsing strips unknown fields; input parsing rejects unknown fields and enforces bounds.

```ts
// lib/opportunity-analysis-contract.ts
export type AnalysisStatus = 'pending' | 'deterministic' | 'enriched' | 'failed';
export type Seniority = 'intern' | 'junior' | 'mid' | 'senior' | 'staff'
  | 'principal' | 'manager' | 'director' | 'exec' | 'unknown';
export interface AnalysisRequirement {
  hash: string; text: string; kind: 'must' | 'should' | 'nice';
  category: 'skill' | 'experience' | 'education' | 'credential'
    | 'location' | 'authorization' | 'other';
  years?: number; skills: string[];
  evidence: Array<{ start: number; end: number }>;
}
export interface OpportunityAnalysisSnapshot {
  id: string; opportunityId: string; sourceContentFingerprint: string;
  sourceContentVersion: number; analysisVersion: 'opportunity-analysis/v1';
  status: AnalysisStatus; normalizedTitle: string; seniority: Seniority;
  function: string; workMode: string; employmentType: string;
  skills: Array<{ slug: string; label: string; kind: 'required' | 'preferred';
    confidence: number; evidence: Array<{ start: number; end: number; quote: string }> }>;
  requirements: AnalysisRequirement[]; summaryBullets: string[];
  eligibility: { remote: boolean | null; countries: string[]; regions: string[];
    timezones: string[]; flags: number;
    workAuthorization: { required: string[]; sponsorship: 'yes' | 'no' | 'unknown' } };
  compensation: { currency: string; min: number | null; max: number | null;
    period: string; equity: boolean | null; source: 'posted' } | null;
}
// lib/server/opportunity-analysis.ts — trusted writer connection only
export function ensureOpportunityAnalysis(opportunityId: string,
  options?: { enrich?: boolean; budgetMicros?: number }): Promise<OpportunityAnalysisSnapshot>;
export function getCurrentOpportunityAnalysis(opportunityId: string): Promise<OpportunityAnalysisSnapshot | null>;
```

Analysis storage additionally carries provenance/model/prompt/token/cost/request fields and optional configured embedding. Public projections omit evidence quotes/spans, internal request IDs, raw descriptions, human overlays and any private identifiers.

```ts
// lib/public-opportunity-contract.ts — snake_case wire names
export interface PublicSearchInput {
  q?: string; skills?: string[]; seniority?: Seniority[]; function?: string[];
  work_mode?: string[]; employment_type?: string[]; country?: string[];
  remote_ok?: boolean; posted_since?: string; salary_min?: number;
  company?: string; source?: string; sort?: 'relevance' | 'newest' | 'salary';
  cursor?: string; limit?: number;
}
export interface PublicOpportunitySummary {
  id: string; title: string; normalized_title: string;
  company: { id: string; name: string; slug: string } | null;
  location: { text: string; countries: string[]; remote: boolean | null; timezones: string[] };
  seniority: Seniority; function: string; employment_type: string; work_mode: string;
  skills: { required: Array<{ slug: string; label: string }>;
    preferred: Array<{ slug: string; label: string }> };
  compensation: OpportunityAnalysisSnapshot['compensation'];
  posted_at: string | null; updated_at: string;
  analysis_version: string; source_content_version: number;
  posting_url: string; url: string;
}
export interface PublicOpportunityDetail extends PublicOpportunitySummary {
  summary_bullets: string[];
  requirements: Array<Omit<AnalysisRequirement, 'evidence'>>;
  eligibility: OpportunityAnalysisSnapshot['eligibility'];
}
export interface PublicSearchPage {
  items: PublicOpportunitySummary[]; next_cursor: string | null; total_estimate: number;
}
export type PublicFacets = Record<'skills' | 'seniority' | 'function' | 'work_mode'
  | 'employment_type' | 'country', Array<{ value: string; label: string; count: number }>>;
export interface PublicMatchInput {
  skills: string[]; seniority?: Seniority; countries?: string[];
  remote_ok?: boolean; years?: number; opportunity_ids?: string[];
}
export interface PublicMatchResult {
  items: Array<{ opportunity: PublicOpportunitySummary; score: number;
    matched_skills: string[]; missing_skills: string[]; eligibility_notes: string[];
    requirements: Array<{ hash: string; decision: 'meets' | 'partial' | 'no' | 'unknown';
      confidence: number; submitted_skill_indices: number[] }> }>;
  model_calls: 0;
}
// lib/server/public-search/index.ts — read-only catalog DB; no private imports
export function searchPublicOpportunities(input: PublicSearchInput): Promise<PublicSearchPage>;
export function getPublicOpportunity(id: string): Promise<PublicOpportunityDetail | null>;
export function listPublicFacets(input: PublicSearchInput): Promise<PublicFacets>;
export function matchPublicSkills(input: PublicMatchInput): Promise<PublicMatchResult>;
// lib/server/opportunity-matching.ts — explicitly private
export function refreshOpportunityMatches(subject: WorkspaceSubject,
  options?: { enrich?: boolean; limit?: number }): Promise<PrivateMatchRefreshResult>;
export function getMyOpportunityMatches(subject: WorkspaceSubject,
  input: PublicSearchInput): Promise<PrivateMatchPage>;
```

Private result types contain requirement decisions/evidence refs and owned projection provenance; define them in the private matching module, never widen PublicOpportunitySummary. Runtime `WorkspaceSubject` comes from verified request context, never body/query parameters. GET `/api/public/v1/me/matches` reads current ranks and is private/no-store; costly refresh is explicit POST or authorized scheduled job. Public `explain_match` accepts submitted skills only; private explanations are a distinct authenticated tool/path to prevent caching ambiguity.

Bounds: q 200 characters/eight terms; default limit 20/max 50; list filters max 50 values; submitted skills max 100 bounded strings; opportunity_ids max 500; anonymous catalog scan max 500; cursor max depth 20 and one-hour expiry. Bind signed cursor to normalized filters, sort, visibility generation and stable tie-breaker `(rank, postedAt, id)`. Reject tampering, expired and query-mismatched cursors with RFC9457 problem responses. Require a configured stable cursor secret in shared mode; do not generate per-process secrets. Salary comparisons require compatible currency/period; do not rank incompatible units as comparable salaries.

## Complete delivery requirements

P1: persist public SkillTerm vocabulary; idempotent seed from CAREER_SKILL_TERMS and existing aliases, optional governed catalog-only clustering, candidate/confirmed promotion and operator correction. Keep skill-discovery and matching consistent; bounded public skill graph, with synonyms distinct from related-skill weak relevance. Related technologies never prove proficiency, tenure or credentials.

P2: unique analysis version per opportunity/fingerprint/version; deterministic coverage for all active postings; current pointer and junction/search update atomically with fingerprint compare-and-swap. Stale worker must not replace newer analysis. Hook creation/source material changes, provide resumable backfill, preserve last deterministic projection on model failure, prune superseded rows after 30 days without breaking retained decision references.

P3: dedicated queue/window and operator `opportunities:analyze --backfill --max N --budget-micros M`; global governance rows, candidate-free prompts, strict bounded schema, exact raw-text offset/quote validation, PII removal, provenance/accounting, retries inside existing governor, deterministic fallback under disabled/exhausted provider. Existing global/provider/gateway caps still apply; measured target cost <= $0.002/posting is acceptance pending a live sample.

P4: PostgreSQL materialized safe document + tsvector GIN and SQLite FTS5 equivalent. Safe dialect-aware query parser (phrases, punctuation, aliases); no unescaped user SQL/FTS operators. All filters, ranking/recency, facets, pagination, public OpenAPI 3.1 and RFC9457 errors. Read-only DB connection required in hosted public paths, pool max five, 500ms statement timeout and no parallel query workers. Shared cost limiter plus bounded concurrency; bounded 60-second server response caching and five-minute facet caching, both fenced by live visibility generation. Public GET ETags require HTTP revalidation (`max-age=0, must-revalidate`) so source opt-out cannot remain visible in an unvalidated downstream cache; public SSR stays private/no-store because the shared layout carries session state. Anonymous match contains user-submitted input: no shared HTTP cache, request logs or durable profile; any 60-second in-memory keyed result must remain bounded and avoid recording input. Public responses independent of cookies/private data. API-key onboarding, if included, reuses verified identity and stored revocable credential primitives; never assume it exists to claim quota coverage.

P5: shared home and results use one search field with additive, removable skill filters chosen through a searchable, categorized modal catalog spanning multiple industries; no separate keyword, skill-search or matching forms. Detail and company/skill landings, sitemap/OpenSearch/robots. Anonymous matching remains available through the API/MCP contract. Shared listing cards show available location, work arrangement, employment type, level, posted compensation, date, skills, and direct original-posting links; missing facts are omitted. Original links use `_blank` and `noopener noreferrer`; safe HTTP(S) URLs. The detail/triage view includes normalized plain-text posting descriptions and qualifications from source-enabled public postings. JSON-LD only grounded values and escaped derived summaries. Preserve private home and authenticated board; responsive browser tests. Source opt-out removes pages/API/MCP/sitemap and invalidates caches.

P6: Stage 0 authoritative eligibility/preferences; retain unknown/conflicting states for explanation instead of accidental exclusion. Stage 1 bounded union of skill/FTS/configured vector candidates (top 300); Stage 2 per-requirement weighted coverage including dated experience, education and seniority; Stage 4 private regularized model using only owner's labels and held-out time split. Persist rank v3 with source/candidate/contract/model provenance; update existing query freshness fences without pretending deterministic ranks have assessment receipts. Incremental analysis/profile refresh must invalidate all affected users, including no-overlap candidates whose previous rank becomes stale. Anonymous path has zero AI calls and no persistence. Owner-scoped `match:evaluate` outputs aggregates only: NDCG@10, P@10, apply recall@50, Brier, Spearman, spend/cache hit rate. Quality targets: S2 >= 0.8 baseline NDCG@10; S2+3 >= baseline; S4 improves held-out P@10; these remain unverified until owner evaluation.

P7: @TenantScoped sensitive RequirementEvidenceDecision cache includes full owner tuple plus requirement/evidence/contract/model hashes. Requirement hash includes normalized semantic qualifiers/negation, not just skill label. Bound Stage 3 to 25 postings per refresh plus existing call/token/cost caps; pick 1–3 relevant evidence items; reuse governed calls and user reserve/settle ledger. Cache only valid structured provenance-backed results; malformed/ambiguous results stay unknown. Budget refusal keeps deterministic ranking. Revalidation/transaction affinity applies at every private write; never share decisions across owners.

P8: anonymous search/get/facets/explain tools and optional public UI resource with identical REST schemas. Public tool allowlist is exact; null principal never unlocks generated CRUD, private board, application tools or private resources. Explicit invalid/revoked credentials must fail rather than downgrade to anonymous. Existing ordinary MCP/CLI/WebMCP and no-UI fallback continue. Public manifest targets jobgeni.us; keep reproducible local profile separately and prove no credential crossover.

P9: SDK owns OAuth authorization-code/PKCE S256, resource audience, ES256/JWKS, DCR validation, expiry, refresh rotation/reuse rejection, errors and storage transaction contract. SMRT persists clients, one-use hashed codes, grants, refresh families and live session/user mapping; code consume and refresh exchange are atomic across replicas, revoke cascades, tokens never stored plaintext. Iolaus supplies issuer/keys/allowed redirect policy, session-authenticated CSRF-protected consent, requested-scope display, granted-scope enforcement, account grant listing/revoke and magic-link return-to. Client identity is never trusted as user identity. Strict redirect matching/HTTPS (explicit local development exception), no open redirect, no secret/code/token logs. Metadata/protected resource discovery and linked account adapter coexist with external OIDC, cookies and CLI credentials. API scope is intersected with current user permissions; `applications:prepare` never grants approve/submit.

P10: shared durable request limiter, global query-cost budget before trusted IP availability, principal quotas for linked users/keys. IaC #2183 integration remains gated on verified end-to-end real addresses; never trust arbitrary X-Forwarded-For or enable proxy parsing at only one hop. Test spoofed headers and multiple replicas. Production nginx address evidence remains pending deployment.

P11: managed `jobgeni_prod_public` credential, CONNECT/USAGE and SELECT only on explicit public catalog tables/columns or vetted views. No default grants on future tables, no private table access, no write privileges. Prefer column/view restriction where base Opportunity/Source contain forbidden overlay/configuration fields; allowlisted serializers remain mandatory even with DB roles. ACL job waits for migrations and is repeatable; rollout web public enablement only after role/grants succeed. Remain on stock CNPG image, document optional in-process vectors and memory bound. No pgvector migration in this release.

#135 continues to require real browse → inspect → prepare materials → dedicated authenticated human review. Embedded resource/navigation/host confirmations cannot approve or submit. Retain atomic material/revision checks, rollback and stale-hydrated-save behavior on SQLite and PostgreSQL; foreign resource/file IDs and profile switches must deny. Install docs, local marketplace/tunnel prerequisites and `smrt mcp-apps validate` are required. A synthetic host is not actual ChatGPT acceptance.

## Test design matrix

Every row is required current-revision evidence. `I` below means `pnpm --filter @willgriffin/iolaus-site`; new focused test scripts must be added when named, not assumed to exist. SQLite and PostgreSQL entries mean actual database executors, not mocks. Root captures exact runnable commands and outcomes in release evidence.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level and validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Vocabulary | Seed/discovery | aliases stable, repeated seed safe | unknown/negated/different skill does not become proficiency | public catalog | unique upsert transaction | SQLite + PG | malformed clustering result | unit + DB; I exec vitest run vocabulary specs |
| Analysis currentness | save/backfill concurrent worker | deterministic row and index pointer agree | old fingerprint, retry, rollback, partial junction write | platform | same tx + CAS | SQLite + PG | unknown enums/missing optional/provider failure | unit + DB analysis specs |
| Governance | enrichment/retry | reserve/settle correct cost once | budget disabled/exhausted, retry duplicate, malformed spans/PII | platform then private owner | ledger transaction | SQLite + PG | Luna mocked failure; live sample separately | governor regression + analysis specs |
| Search parity | API/MCP query | filters phrases synonyms stable order | malformed query, incompatible salary, missing analysis, injection | anonymous/shared only | read-only query, index update tx | SQLite FTS5 + PG GIN | unknown params/missing optional | search integration + 10k benchmark |
| Cursors/cache | second page/source change | page no duplicates, ETag conditional | altered/expired/filter-mismatched token; opt-out stale cache | anonymous vs signed-in | read-only generation fence | both + two replicas | HTTP 304/400/429 | service + route specs |
| Public isolation | search/get/facets/match/pages/MCP | catalog-only output identical with/without two private users | sentinel in private rows/human overlay inaccessible | anonymous, owner A/B | public DB role denied private SELECT/any write | SQLite boundary + real PG ACL | unknown output fields stripped | golden isolation + import boundary + ACL test |
| Anonymous match | POST submitted skills | bounded useful score, zero provider calls | >bounds/malformed/PII-bearing input never persisted/logged | anonymous | read only; no user DB mutation | both | optional years/unknown enums | service/API/MCP parity specs |
| Registered match | profile/analysis refresh | private ranks fresh, unknown distinct from conflict | other owner, revoked membership, stale fingerprint/rollback | owner A/B x resource A/B x active/revoked | verified subject and owned tx | both | missing evidence/provider refusal | private matcher integration specs |
| Cache and Stage 3 | same requirement repeated | own cache reused, spend settled once | cross-owner hit impossible, retry/error/quote invalid | billed owner | reservation + owned cache tx | both | timeout/unknown model output | matcher + governance DB specs |
| Private reranker/eval | owner command | deterministic time split, aggregates only | insufficient labels leaves authored defaults | verified owner | private reads/model write | both | model quality thresholds pending | fixture metrics + actual owner run |
| OAuth protocol | register/authorize/token/refresh | code+S256, audience/scope, rotate | replay, wrong verifier/redirect/client/resource, unsupported enum | anonymous client, signed-in consent | injectable atomic store | SDK supported Node runtime | OAuth/JWT/JWKS errors | SDK auth unit + protocol tests |
| OAuth persistence | concurrent exchange/revoke | one exchange, revoke visible cross-replica | rollback, replay refresh family, disabled user/session | owner A/B x grant A/B | real DB tx/CAS | SQLite + PG | storage interruption | SMRT users integration |
| OAuth app policy | consent and linked tool | magic-link return, narrow scopes | CSRF/foreign grant/invalid bearer never anonymous downgrade | anonymous/active/revoked owner | live session and membership | site Node + both DBs | external OIDC/local issuer/CLI | route/MCP auth integration |
| MCP surface | tools/resources list/read/call | public tool no auth, private authorized, no-UI fallback | forged IDs, other tenant, profile credentials crossover | all actor/resource/context combinations | runAsOwner live authorization | local/self-hosted/shared | optional/forged host capabilities | I test:mcp-apps + CLI/WebMCP regressions |
| Human review | actual browser link click | own review renders; draft/material flow works | anonymous/foreign deny; navigation no approval; stale CAS rollback | owner vs foreign/anonymous | real approval tx | browser + SQLite/PG | foreign embedding/referrer/opener | I test:browser + affected approval DB tests |
| Public UI/SEO | search/detail/mobile | summary only; safe original link; grounded JSON-LD | opt-out/inactive page missing; unsafe URL/XSS rejected | anonymous/shared/private | read-only SSR | browser/mobile + both DB | Google validator pending real host | browser + JSON-LD fixture validation |
| Quotas/IP | burst across replicas | shared counter/refusal Retry-After | spoofed XFF/global budget exhaustion | anonymous/key/session | atomic limiter tx | PG + local fallback explicit | real proxy chain pending | limiter integration + IaC contracts |
| Deployment ACL | migrate then ACL then web | public role valid, private deny | missing secret/schema fails closed, no broad defaults | operator/public runtime | idempotent grants after migration | real PG | Flux order/secret refs | IaC scripts/ci/run-contract-tests.sh |
| Install closure | clean install packed dependencies | actual copies resolve coherent exports | stale transitive registry copy detected | developer/local host | N/A no database operation | pinned Node/pnpm | tarball integrity/exports | build/import smoke + mcp-apps validate |

## Local closure and release gates

1. Root records clean baseline commits and claims prerequisite issues in each repo. Workers report affected package exports and dependency changes before installation.
2. Build SDK auth and its transitive workspace dependencies using repository scripts. Pack every changed or workspace-resolved dependency into an external session artifact directory; record package name/version/source commit and SHA256. Do not publish or manually bump published versions.
3. Install SDK tarball overrides into SMRT integration checkout; build users and smrt-app-mcp plus full dependency closure. Pack SMRT users/core/tenancy/app-runtime/app-mcp/mcp-apps/mcp-openai and any other packages actually required by their manifests; calculate closure from package manifests, not this illustrative list.
4. Install full coherent SDK+SMRT tarballs into Iolaus. Verify `pnpm why`, actual resolved package.json/export paths and package identities, including duplicate nested copies. Run import smoke for server/auth, Svelte/browser resource and CLI. Do not treat root override presence as proof of installed closure. Temporary local tarball paths stay out of final release manifests/lockfile; archive reproducible integration manifest and hashes.
5. Run narrow tests first, then Iolaus `pnpm format-check`, `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build`. Hosted PostgreSQL uses `I db:migrate` and `I db:status`; these application scripts require a pinned PostgreSQL session. Local SQLite uses `I exec smrt db:migrate`, a repeat `--dry-run`, and the built-server smoke. Both dialects also run their native behavior suites. Run affected migrated data-surface tests if those SQL statements change. Upstreams run their AGENTS/package documented gates; IaC renders and runs full contract suite.
6. Build fresh knowledge, use SMRT review workflow and actual diff review, then check-domain-knowledge. Independent reviewers see matrix evidence and named high-risk triggers: authorization-server protocol, authenticated tenant access, public/private database separation, embedded-browser isolation and human approval. Missing applicable evidence is EVIDENCE_GAP, not a pass.
7. At final ship only, replace local artifacts with valid coordinated release dependency references under repository release policy, rerun affected resolution/build tests, open ready PRs, attach them, hand off claims, and watch required CI/reviews/mergeability. No merges or publication without current-session authorization. If upstream versions are not published yet, report the specific release blocker instead of committing unresolvable production dependencies.

### Reproducible local closure procedure

After the SDK and SMRT source worktrees are clean at their recorded release
commits, generate the Iolaus integration closure from the application entry
manifests:

```bash
node scripts/agent-first-release-closure.mjs \
  --source /Users/will/Work/_trees/agent-first-release/sdk \
  --source /Users/will/Work/_trees/agent-first-release/smrt \
  --seed package.json \
  --seed apps/site/package.json \
  --seed packages/cli/package.json \
  --seed packages/resume/package.json \
  --output vendor/release
```

This emits tarballs plus `release-closure.json`, `pnpm-overrides.json`, and
`manifest-proposal.json`. The root applies the proposal deliberately using
repository-relative `file:vendor/release/...` references, regenerates
the lockfile, and runs a clean frozen install. It then verifies every root and
pnpm-virtual-store copy against the recorded version, tarball SHA-256/SHA-512,
and lockfile file-resolution; the manifest retains the clean source commits
that produced those tarballs:

```bash
node scripts/agent-first-release-closure.mjs --verify \
  --manifest vendor/release/release-closure.json --install-root .
```

The local closure is an integration pin only. At the coordinated publication
transition, replace those file references with the released immutable package
references, regenerate the lockfile, remove the closure overrides and vendor
tarballs, then repeat the frozen-install and import/build checks. Never commit
`file:/tmp` or another machine-local path.

## Pending acceptance ledger

The following cannot be claimed from this plan or unit fixtures: real ChatGPT host/version/auth/resource render and human-review flow; Google rich-results result; production source opt-out/cache rollout; public-role secret provisioning and real deny query; end-to-end nginx real-IP verification; live Luna cost per posting; 10k p95 <100ms search and <500ms registered refresh on declared hardware; owner's NDCG/P@10/Brier evaluation; production budget/traffic behavior. Record each actual command, date, revision, actor and redacted aggregate outcome when executed. Host login/workspace restrictions require a concrete blocked step. Directory submission and production change acceptance remain distinct from a reviewable implementation PR.

### Search-first triage extension — #200

The shared catalog starts with one search. A submitted natural-language search
becomes editable role, skill and supported preference filters, then opens a
triage deck. Interpretation is deterministic and exposes unsupported constraints;
it never adds skills to the candidate's profile. Explicit public API queries
retain their existing contract.

Pass, Later and Save persist independent shortlist decisions. Save does not
queue intelligence, research, tailoring or applications. Saved and All shown
views retain delivered opportunities; opening an original posting is distinct
from manually marking Applied. Guests retain bounded, versioned browser storage
with visible storage-failure handling. An account shortlist belongs to the
verified tenant/user identity, independent of candidate profile onboarding.
Guest import preserves existing account decisions and only clears acknowledged
browser entries. Stale postings remain in history with availability indicated.

Email-to-self opens an explicit email draft containing bounded public posting
links. No message is automatically sent and guest access does not introduce an
anonymous SMTP relay. Interactive cross-device guest restore remains a separate
feature requiring protected, expiring server snapshots.

Validation includes deterministic interpretation, browser storage failure and
cross-tab behavior, native SQLite/PostgreSQL revision/import atomicity and
ownership tests, and served Chromium checks at narrow and desktop sizes. The
owner authorized PR publication on 2026-10-10 after local testing. Merge,
package publication, and deployment remain separate steps. Release validation
and independent review must cover this extension, hosted resume profiles
(#201–#206), and the subsequent catalog/workspace UI work (#207–#209).
