# Opportunity skill matching

Scoring now recognizes exact skill aliases (for example Postgres/PostgreSQL and
Node.js/nodejs) and avoids substring matches such as Java/JavaScript and C/C++.
The scoring evidence matrix remains authoritative during subsequent evidence
and quality steps, so those steps cannot undo an alias or semantic match.

## Optional semantic decisions

Enable typed skill decisions to evaluate extracted requirements against the
candidate's resume skills and experience before deterministic scoring gates.
Each unmatched requirement sends two independent questions over the same
candidate context: a support predicate and a supporting-source choice. Both
must reach 0.85 before a semantic match counts as supported. This initial
threshold is conservative policy, not a measured accuracy guarantee.

Each question quotes its requirement explicitly and candidate sources retain their
evidence kind. Declared skills can establish capabilities directly provided by
that technology. The exact-label shortcut applies only to bare capabilities;
requirements that state years, production, operations, leadership or scale go
through the decision path. A skill label alone cannot prove tenure, leadership
or production experience.
The prompt distinguishes named technologies from merely related technologies
and instructs the model to disregard instructions inside source text. A
confident negative may become a gap; disagreement, low confidence or omitted
candidate context remains uncertain and routes to research rather than an
automatic rejection. Model output is advisory and never records Apply/Reject
on behalf of the owner.

Configuration (server/worker environment):

- `OPPORTUNITY_SKILL_DECISIONS_ENABLED=true` enables the provider. Default is off.
- `TYPESAFE_API_KEY` is the provider credential; store it as a secret.
- `OPPORTUNITY_SKILL_DECISION_MODEL` defaults to `jev-latest`. Pin a concrete
  model for reproducible evaluation where the provider supports it.
- `OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION` and
  `OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION` must describe the
  decision provider's actual token pricing. Chat pricing is not reused.
- Existing opportunity-intelligence enablement, circuit, crawl and run budgets
  still apply. Allow room for one decision batch plus any extraction/scoring
  requests already in the run. The decision request caps input at 64,000 tokens and output at 4,096;
  input estimation and reservation conservatively use the actual UTF-8 byte
  length of the request, rather than reserving the entire input cap.

A batch evaluates up to the existing eight selected posting requirements, with
up to 80 candidate sources, prioritizing resume skills, and 180 characters per
source. Truncated context cannot establish a confident negative. Positive
results retain source IDs and the same bounded evidence that was evaluated.
Transport/capability errors, malformed results, and missing usage accounting
fail the scoring step; they never produce a fabricated negative match.

The app uses SDK/AI's public `decide()` contract directly inside its existing
server workflow. SMRT database context and the governed request reservation
remain unchanged. SDK/AI and its workspace override are pinned to 0.94.1;
no SMRT upgrade or schema migration is required for this integration.

## Evaluate and roll out

1. Before enabling, assemble labeled real postings covering synonyms, related
   but distinct technologies, seniority/tenure requirements, negation, missing
   evidence and clearly unrelated roles. Include previously rejected good fits.
2. Run the focused contract suite:
   `pnpm --filter @willgriffin/iolaus-site exec vitest run src/lib/server/skill-matching.spec.ts src/lib/server/skill-decision-provider.spec.ts src/lib/server/opportunity-scoring.spec.ts src/lib/server/opportunity-intelligence.spec.ts src/lib/server/opportunity-intelligence-governance.spec.ts`.
   These fixtures validate application behavior, not live model accuracy.
3. Enable for a bounded manually selected sample using the existing opportunity
   Score action. Compare requirement-level judgments against human labels,
   false positive recommendations, missed good fits, uncertainty, latency and
   spend. Inspect `reasonJson.scoring.input.skillMatching` and the governed
   `opportunity-skill-match` request records for provenance and provider answers.
4. Re-score existing machine-owned opportunities after enabling. Stored scores
   are not rewritten merely by deployment; fresh scoring fingerprints include
   matcher version, candidate input and semantic results. Material freshness also
   includes all semantic candidate inputs, so changing a skill used only by
   semantic matching invalidates cached scores and in-flight writes. Human-owned scores
   and review decisions remain authoritative. Then refresh triage.
5. Broaden only after reviewing the labeled results. To disable, unset the
   enable flag and re-score the affected machine-owned sample using the
   deterministic/chat path. Existing historical evaluations remain available.

Extraction still supplies atomic required/preferred skills. This change does
not automatically infer unextracted qualification requirements or replace
extraction, application prose generation or user approvals.

### Live canary

With `TYPESAFE_API_KEY` injected through the environment, run:

```bash
pnpm --filter @willgriffin/iolaus-site exec tsx scripts/skill-matching-live.ts
```

This explicitly invoked script makes 14 paid decision requests against synthetic
fixtures, testing 34 judgments across original and reversed requirement/source
inputs. It checks capability equivalence, distinct technologies, duration,
negation and absent evidence; any unexpected support result or provider failure
exits nonzero. Negative labels allow uncertainty, because insufficient evidence
must not become an invented positive. It prints synthetic judgments and usage,
never the credential or raw provider errors. These canaries catch regressions;
they do not replace the labeled real-posting evaluation above. Matcher v2 binds
each question to its quoted requirement and invalidates earlier fingerprints.
