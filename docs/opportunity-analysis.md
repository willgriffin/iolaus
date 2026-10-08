# Public opportunity analysis

Analysis uses the canonical `sourceContentJson` snapshot only, after recomputing its source fingerprint. Human edits, candidate profiles, application decisions and owner skill labels are not extraction inputs. A separate digest binds exact raw text to citation offsets even when whitespace normalization leaves the source fingerprint unchanged.

The deterministic path publishes a source-derived title, seniority, posted compensation with its original hourly/yearly unit, explicitly cited skills, and quoted requirements. Unknown values remain unknown. Negated skill mentions do not prove a requirement. Source descriptions and citation spans are not exposed by the public catalog view; requirement projections include only their semantic fields.

`ensureOpportunityAnalysis(id, { enrich, budgetMicros, windowId })` always establishes deterministic coverage first. Optional enrichment is pinned to `openai/gpt-6-luna`, consumes the existing global/provider governor and a bounded analysis window, and accepts only bounded structured source citations. Invalid quotes, contact PII, unsupported summaries, provider refusal and exhausted budgets retain the deterministic artifact. A live paid sample is still required before claiming the target cost per posting.

Publication uses one pinned database transaction for the artifact, skill junctions, current pointer and the search triggers. It locks the current source row on PostgreSQL and serializes SQLite writers using the existing operation lock. Stale source workers cannot replace the current artifact. Source edits invalidate the pointer in database triggers, including raw-text-only changes. Retries do not duplicate artifacts or downgrade enriched artifacts.

## Operations

Run migrations before analysis. The migration seeds the fixed public skill vocabulary; aliases are exact synonyms, while related edges are weaker relevance only. Operator correction uses `promoteSkillTerm`; candidate rows do not enter the synchronous canonical lookup until confirmed. Server consumers explicitly refresh the immutable lookup with `refreshSkillVocabularyLookup`.

```sh
pnpm --filter @willgriffin/iolaus-site opportunities:analyze --backfill --max 100
pnpm --filter @willgriffin/iolaus-site opportunities:analyze --backfill --max 100 --cursor TOKEN
pnpm --filter @willgriffin/iolaus-site opportunities:analyze --backfill --max 100 --enrich --budget-micros 2000
pnpm --filter @willgriffin/iolaus-site opportunities:analyze --prune
```

The CLI emits aggregate counts and an opaque resume cursor. Enrichment remains opt-in; a requested cap never raises configured governor caps. Source creation and material refresh enqueue native analysis work and establish deterministic coverage immediately. Pruning retains current analyses and analyses referenced by retained requirement decisions; superseded unreferenced artifacts become eligible after 30 days.

## Focused verification

```sh
pnpm --filter @willgriffin/iolaus-site exec vitest run src/lib/server/opportunity-analysis-source.spec.ts src/lib/server/opportunity-analysis.spec.ts
ANALYSIS_TEST_POSTGRES_URL=postgresql://postgres@localhost:55597/analysis pnpm --filter @willgriffin/iolaus-site exec vitest run src/lib/server/opportunity-analysis-store.integration.spec.ts
VOCABULARY_POSTGRES_TEST_DATABASE_URL=postgresql://postgres@localhost:55597/vocabulary pnpm --filter @willgriffin/iolaus-site exec vitest run src/lib/server/skill-vocabulary.integration.spec.ts
```

Use disposable test databases: the analysis integration suite creates and drops its catalog fixture tables. It exercises both SQLite and PostgreSQL native executors, separate connections, rollback, stale workers, retry identity, exact-source invalidation and the public view boundary. Full migrated-schema validation and the existing governance regression suites remain release gates.

## Acceptance coverage and remaining measurements

| Area | Automated coverage | Limit |
| --- | --- | --- |
| P1 vocabulary | Fixed career terms, canonical aliases, separate bounded related edges, SQLite/PostgreSQL uniqueness and persisted lookup | Catalog clustering is optional and is not enabled; corrections are operator-authored |
| P2 artifacts | Both database executors: concurrent connections, rollback after a partial junction insert, duplicate retry, stale source/version refusal, raw-text invalidation, enriched downgrade prevention, sanitized public view | Full production rollout and retained-history volumes require operational observation |
| P3 enrichment | Exact quote/span and PII rejection, provider refusal and deterministic fallback, pinned model/caps, durable retries and ledger settlement, bounded backfill/prune, native job guards | Live cost per posting has not been measured; optional embeddings are disabled and have no configured route |

The release also verifies publication against the actual migrated PostgreSQL model schema, including UUID foreign keys, source opt-out and the transactional search document. Synthetic fixtures alone do not establish that compatibility.
