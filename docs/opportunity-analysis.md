# Public opportunity analysis

Analysis uses the canonical `sourceContentJson` snapshot only, after recomputing its source fingerprint. Human edits, candidate profiles, application decisions and owner skill labels are not extraction inputs. A separate digest binds exact raw text to citation offsets even when whitespace normalization leaves the source fingerprint unchanged.

The deterministic path publishes a source-derived title, seniority, posted compensation with its original hourly/yearly unit, explicitly cited skills, and quoted requirements. Catalog names and unambiguous aliases are extracted from visible canonical descriptions across professions. Description-only matches are `mentioned`; only evidenced structured source fields establish `required` or `preferred`. Markup, URLs, negation and word boundaries are checked, with exact source offsets retained. Ambiguous prose aliases such as “go”, “JS” and “TS” are deliberately excluded unless supported by explicit structured skills. Unknown values remain unknown. Negated skill mentions do not prove a requirement. Public detail responses include bounded plain-text descriptions and qualifications from the current canonical posting, with markup and contact details removed. Search/list responses omit that text. Raw canonical payloads, citation spans and private candidate/review fields remain excluded; requirement projections include only their semantic fields. Canonical location notes fill an empty location field.

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

## Deterministic skill-index repair

The extractor provenance is `deterministic-skills/v2`; the public analysis contract remains `opportunity-analysis/v1`. Older deterministic snapshots are refreshed on the normal analysis path. Compatible enriched snapshots are preserved.

For an existing catalog, use the explicit operator repair command (no model calls):

```sh
pnpm --filter @willgriffin/iolaus-site opportunities:reindex-skills -- --max 300
pnpm --filter @willgriffin/iolaus-site opportunities:reindex-skills -- --max 300 --apply
pnpm --filter @willgriffin/iolaus-site opportunities:reindex-skills -- --max 300 --cursor TOKEN --apply
pnpm --filter @willgriffin/iolaus-site opportunities:reindex-skills -- --max 300 --check
```

Dry-run is the default. Follow `nextCursor` until null for a complete scan; each invocation handles at most 300 public-eligible postings. `--check` is read-only, exits 2 for missing deterministic coverage, and cannot be combined with `--apply`. A failure stops before advancing past that posting; resume with `retryCursor` (or omit it when null). Logs contain aggregate counts and opaque cursors only. Apply atomically updates derived analyses and search indexes, preserving source fields and shortlist decisions. A subsequent full check should report zero gaps. The normal backfill governor and optional enrichment budgets are unchanged.

Search filters match any selected canonical skill. Relevance sorts by the number of distinct selected skills matched, then text relevance and stable date/ID ties. Aliases do not count twice. The public catalog and detail page distinguish mentions from required/preferred skills. Cards include all three kinds; requirement scoring does not treat a mention as a requirement.

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
