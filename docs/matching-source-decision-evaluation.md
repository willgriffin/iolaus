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
the remaining attempted units unresolved.
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
no successful check. The concept question is independent of whether a unit
describes an applicant obligation or a duty. Advisory results remain separate
from the matcher. This benchmark does not publish them to the catalogue.
Confirmation asks whether the quote describes doing the selected capability.
The full citation still carries tenure and scope. Neither the selection nor
confirmation establishes that an applicant meets the posting's conditions.
`advisoryStages` counts normalized selection and confirmation outcomes by
reviewed category, including abstentions, declines, unavailable, and
not attempted. It includes no source text, concept IDs, or provider scores.

After measuring quality, a persistence follow-on can pair a canonical concept
ID with its exact cited source in provider-neutral prepared evidence. It must
preserve unknowns and the existing independent proof requirement for
matcher-consumable evidence.

## Bounded hosted Jev run

Use approved source excerpts and an explicit paid run. Set
`IOLAUS_SOURCE_DECISION_PROVIDER=typesafe`,
`IOLAUS_SOURCE_DECISION_TRANSPORT=direct`, a pinned model
(`jev-1.13.0` or `jev-1.14.0`), the deployment revision, and
`TYPESAFE_API_KEY` in the operator environment. To use Bifrost instead, set
`IOLAUS_SOURCE_DECISION_TRANSPORT=bifrost`, the gateway root and virtual key
above, and the gateway's namespaced model. The gateway must preserve native
TypeSafe metering. Use a dedicated route with no retries, paid fallback, or
long-context override, and confirm the applicable gateway rate and budget.
The adapter uses only the selected route.

Set `IOLAUS_SOURCE_DECISION_JEV_INPUT_COST_MICROS_PER_MILLION` to a verified
upper input rate. TypeSafe publishes 42,000 microdollars per million input tokens
with free output. Verify any gateway markup separately.
[TypeSafe pricing](https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost)

```sh
pnpm --silent --filter @willgriffin/iolaus-site matching:source-decision-evaluate \
  --mode jev --allow-live-jev --max-calls 24 --max-cost-micros 50000
```

The CLI limits submitted request bytes and reserves the provider's full normal
request context ceiling of 65,536 input tokens before each attempt. At the
published rate that holds 2,753 microdollars. It settles a successful receipt
using reported input tokens, rounded up per request, and releases the unused
reserve. A missing, invalid, or over-limit receipt halts further calls and
retains the unsettled reserve. The report separates the configured cap,
receipt-based cost and unsettled reserve. Provider invoices and gateway-side
retry counts are outside the client report.
[TypeSafe model limits](https://docs.typesafe.ai/models)

### First Jev diagnostic

A direct `jev-1.14.0` run on the eight built-in examples identified 3 of 7
reviewed required groups, compared with 2 of 7 in the code-path abstention
control. Both identified all three preferred groups. The run skipped both
positive concept examples because obligation classification gated the
separate concept question.

After separating the questions, a bounded diagnostic reused both positive
quotes and one related-only control. Jev checked both positives and produced
zero correct concept suggestions. The call cap blocked completion of the
related-only control. These reused examples establish that the gate opens
and the two positive mappings still fail on this diagnostic. They do not
qualify Jev to replace posting interpretation or measure held-out quality.
The historical aggregates could not distinguish selection from confirmation.
A separate synthetic batch gave the leadership choice a score of 0.94 and
the earlier entire-condition predicate a score of 0.34 on the same text.
Questions about performing the defined activity scored 0.98 and 0.96 on the
two positive paraphrases and 0.04 on observing only. This isolated a prompt
failure in the diagnostic. It does not measure the corrected evaluator's
quality on new postings.

The initial two runs and the prompt batch used 25 calls, reported 9,877 input
and 1,319 output tokens, and recorded zero client retries or provider errors.
At the configured TypeSafe input rate the receipt-based total was 427
microdollars, rounded up per request.

### Corrected excerpt diagnostic

The corrected evaluator checked three excerpts: one reused synthetic positive,
one previously unseen public posting excerpt, and one reused observing-only
control. It confirmed the two positive concepts and declined the observing
example at confirmation. All citations were exact. The reviewed three-year
requirement was still missing from matcher facts because the concept result
is advisory. One reviewed role was also missed. This is an excerpt diagnostic,
and publication still requires reviewed full-posting evidence.

The corrected run used 8 calls, 3,018 input tokens, 361 output tokens,
and 723 ms of measured provider wall time. Median provider latency was
74 ms and p95 was 183 ms. Receipt-based cost was 130 microdollars.
Across the four diagnostic runs, 33 calls reported 12,895 input tokens and
1,680 output tokens. The receipt-based total was 557 microdollars, with zero
client retries, provider errors, or unknown usage. Live Laya evaluation
remains pending.
