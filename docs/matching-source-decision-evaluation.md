# Posting source decision evaluation

Run the offline fixture benchmark from the repository root.

```sh
pnpm --silent --filter @willgriffin/iolaus-site matching:source-decision-evaluate
```

The built-in v1 fixture has four synthetic development examples and four distinct
held-out examples, all written for the benchmark. The reviewed answers encode
the source's required and preferred groups, AND and OR, duration and context,
role and geographic scope, exact source spans, and unresolved conditions.
Synthetic candidate preference probes exercise the existing matcher. They contain
no profile evidence. The held-out examples are a small regression set. Keep
operator-reviewed examples separate when making a decision about model quality.

The mock uses scripted choices and makes zero network calls. Its report is
labelled `scripted-plumbing-only`. Both modes compare the candidate path with
the same preparation code when every typed decision abstains. The separate frozen
abstention v1 control emits no positive claims or conflicts and leaves every
reviewed requirement and unresolved span unresolved. These controls show what
the typed choices add over code alone and over full abstention. A production
generative baseline would need comparable frozen outputs for the same sources.

## Bounded live Laya run

For Laya behind Bifrost, set these variables in the operator environment.

- `IOLAUS_SOURCE_DECISION_PROVIDER=laya`
- `IOLAUS_SOURCE_DECISION_TRANSPORT=bifrost`
- `IOLAUS_SOURCE_DECISION_BIFROST_BASE_URL` is the gateway root before any
  API route. Use the root without `/openai`, `/v1`, or `/typesafe`. An
  operator-configured reverse proxy prefix may be part of the root.
- `IOLAUS_SOURCE_DECISION_BIFROST_API_KEY` is the Bifrost virtual key authorized
  for the configured provider.
- `IOLAUS_SOURCE_DECISION_MODEL` uses `provider/model`, for example
  `laya/typed-decisions` if the custom provider is named `laya`.
- `IOLAUS_SOURCE_DECISION_REVISION` identifies the deployment. Change it when
  the checkpoint, routing, or deployment changes.

The Laya SDK adapter uses Bifrost's native `/typesafe/v1/systemone` ingress.
This route needs to preserve the native Laya response. Gateway setup and live
routing compatibility are verified separately from the fixture smoke.
[Bifrost self-hosted decision models](https://github.com/maximhq/bifrost/blob/ef964fffce6c65fb084427807bdb14bf77417566/docs/providers/self-hosted-decision-models.mdx)

For a directly exposed Laya endpoint, select `direct` (the default), set
`LAYA_BASE_URL` and optionally `LAYA_API_KEY`, and supply the checkpoint as the
model. The selected transport never falls through to the other one.

`IOLAUS_SOURCE_DECISION_MAX_LEN` sets the Laya window and the local UTF-8
request limit. The default is 512 for the English checkpoint and 1024
otherwise. `IOLAUS_SOURCE_DECISION_TIMEOUT_MS` sets the per-call timeout.

```sh
pnpm --silent --filter @willgriffin/iolaus-site matching:source-decision-evaluate \
  --mode laya --allow-live-laya --max-calls 24
```

The cap is an integer from 1 to 99. It covers all candidate attempts across both
splits, including attempts skipped by host request preflight. The synthetic
split runs first. Check `fullRunWithinBudget` and the per-split
`budgetBlockedRequests` before comparing results. An exhausted budget leaves
the remaining attempted units unresolved. The evaluator selects Laya only.
Use a normal System One endpoint that reports `usage.truncated` explicitly.
Strict JEV mode strips this metadata, and answers without an explicit
non-truncation signal are rejected.
[Laya HTTP API](https://github.com/NandhaKishorM/laya/blob/main/docs/http-api.md)

Use `--fixture /absolute/path/to/reviewed.json` for a separate reviewed fixture
with the structure in
[the built-in v1 fixture](../apps/site/scripts/matching-source-decision-evaluate-fixtures.json).
The evaluator accepts one to twelve cases per split, a maximum of 512,000
bytes, and no extra fields. Use posting captures approved for the selected
endpoint. Keep private fixtures outside the checkout. Only live mode sends
eligible description excerpts to the explicitly selected endpoint. The
evaluator uses the static matching vocabulary and performs no database,
profile, or catalogue operations. Output is aggregate JSON with no source
text, fixture paths, candidate preferences, endpoint URLs, or raw provider
errors. Built-in fixture, requested model, and provider configuration identity
are reported as fingerprints. Record the operator fixture revision privately
when comparing external fixture runs.

## Reading the report

- Required and preferred group comparisons treat groups as conjunctive and
  alternatives within a group as disjunctive. A group is correct when the
  canonical alternatives, duration, context, and exact citation match. An
  unmatched prediction counts as wrong and any unmatched reviewed group counts
  as missing. Role and geography comparisons likewise include their citations.
- Citation validity compares the exact text and UTF-16 offsets to the source.
  A textually valid span can still be wrong for the claim. Unresolved coverage
  counts exact reviewed unresolved spans represented, plus known requirement
  spans left unresolved.
- False conflicts count probes the matcher rejected despite the reviewed
  absence of a conflict. Missed conflicts count the inverse. These scores are
  limited to the included synthetic role and geography preferences.
- Latency is reported as total, median, and 95th percentile wall-clock time for
  preparation and for adapter attempts. The report separates provider calls
  from host preflight skips and lists truncation, timeout, invalid, and failure
  counts. Token subtotals are from reporting calls only. Missing usage is
  counted separately, including for failed calls. A null subtotal means no
  measurement was returned.
- The adapter makes zero client retries. Returned usage includes unsuccessful
  outcomes when the adapter receives valid metering. The benchmark has no
  visibility into server-side retries, compute, energy, utilization, or dollar
  costs. A missing token measurement is unknown. Hosted pricing and
  production traffic are outside the benchmark.

The bundled smoke run exercises the report and controls without model
inference. Live quality and cost comparisons require an operator-provided
endpoint and a complete run.

### Advisory semantic concepts

Each split includes a non-alias paraphrase for engineering team leadership, a
related-only activity, and an activity with no equivalent among the offered
concepts. The advisory scorecard compares the suggested canonical concept ID
and exact source span with the review. It counts successful checks in each
category, missed or wrong equivalents, suggestions on negative spans, and
suggestions outside the reviewed spans. A skipped or failed check contributes
no successful check. These are advisory outputs and remain unresolved in the
matcher. This benchmark does not publish them to the catalogue.

After measuring quality, a persistence follow-on can pair a canonical concept
ID with its exact cited source in provider-neutral prepared evidence. It must
preserve unknowns and the existing independent proof requirement for
matcher-consumable evidence.

The shared adapter also supports explicit hosted configuration with
`IOLAUS_SOURCE_DECISION_PROVIDER=typesafe`, `IOLAUS_SOURCE_DECISION_MODEL`,
`IOLAUS_SOURCE_DECISION_REVISION`, and `TYPESAFE_API_KEY`. The evaluator CLI
rejects hosted mode.
