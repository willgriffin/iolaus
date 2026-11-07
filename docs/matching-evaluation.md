# Offline matching evaluation

The [normalized matching contract](matching-evaluation-contract.md) separates
source facts, private candidate evidence, eligibility and ranking. This study
compares retrieval and ranking when those facts are supplied. It also measures
how often a raw text shortlist contains an explicit conflict or unresolved
requirement.

## Run the comparison

```sh
pnpm --silent matching:evaluate
pnpm --silent matching:evaluate --benchmark
pnpm matching:evaluate:test
```

The comparison and tests use the checked-in fictional cache without a model
install, network access, application database or credentials. The JSON report
includes input and cache fingerprints, split summaries, retrieved and displayed
IDs per scenario, and the eligibility confusion matrix over all judged pairs.
A cache with missing IDs, malformed vectors, a mismatched model revision or a
stale input fingerprint fails the run.

To regenerate the cache, use [uv](https://docs.astral.sh/uv/) with Python 3.12.
The first run downloads the pinned model and Python dependencies. The temporary
directory keeps the model input and regenerated copy outside the checkout.

```sh
evaluation_dir="$(mktemp -d)"
pnpm --silent matching:evaluate --emit-inputs > "$evaluation_dir/inputs.json"
uv run --python 3.12 --script scripts/matching-evaluation/embed.py \
  "$evaluation_dir/inputs.json" "$evaluation_dir/vectors.json"
```

This uses [all-MiniLM-L6-v2 at revision 1110a243](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/tree/1110a243fdf4706b3f48f1d95db1a4f5529b4d41)
under Apache 2.0. The 384-dimensional cache contains base64-encoded,
little-endian float32 vectors of fictional text. The encoder uses the same
checkpoint for both roles. It reads Unicode NFKC text with collapsed whitespace,
right-truncates to 256 tokens including special tokens, and applies
attention-mask mean pooling and L2 normalization. Its output reports how many
inputs were truncated per role. The input fingerprint covers the exact bytes of
the exported IDs, roles and text. The fixture fingerprint covers the separate
judgments and normalized facts as well. The fixture was frozen before scoring
(SHA-256 `c15f48fee6b72248a73e8953c1c72b9178179b015ed2643c6daf1130e3b0828d`).

The committed cache SHA-256 is
`2d2110af87631bd395767143ac1a255a0e49039fbcfceb6457fc5792d64edfc9`.
Three independent cache-warm CPU processes reproduced those bytes on the
reported executor. Cross-platform floating-point results may differ slightly.
The encoder pins the primary libraries in an isolated script environment and
loads the immutable checkpoint through SafeTensors. Model weights stay in the
local model cache.

## Method

All arms consider the same complete set of three to six opportunities per
scenario. Each retrieves three before eligibility decisions and displays up to
two. Scores and cutoffs were fixed before the first comparison.

| Arm | Retrieval order | Admission and display order |
| --- | --- | --- |
| Structured | 75% supported hard checks, including role and location, plus 25% supported preferred groups | Shared eligibility gate, then structured order |
| Raw cosine | Cosine similarity between the two text embeddings | Admit the full shortlist in cosine order as a diagnostic |
| Gated cosine | Same cosine shortlist | Shared eligibility gate, then cosine order |
| Hybrid | Same cosine shortlist | Shared eligibility gate, then equal weights of structured score and cosine scaled to [0, 1] |

A listing without preferred groups contributes zero preference score under
this simple baseline. Ties break on listing ID. The gate abstains when a
hard requirement is unknown and rejects a known hard conflict. The exhaustive
gate confusion matrix includes pairs outside every shortlist.

Retrieval recall counts judged eligible listings in the shortlist divided by
all judged eligible listings. Admission precision counts eligible listings
among all admitted shortlist entries. Known conflicts and unresolved admissions
are counted separately. Decision coverage is the fraction of retrieved entries
with a positive or negative decision, with abstentions removed from the
numerator. Raw cosine's full coverage reflects its unconditional admissions.
Displayed recall applies the same eligible denominator to the displayed two.
Graded nDCG@2 uses gains 0, 1 and 3 for the three relevance grades and compares
the displayed order with the best possible order from the whole scenario.
The count-based rates are micro averages. nDCG is averaged over scenarios with
at least one eligible listing. Zero denominators produce null.

## Results

The development split contains 26 judgments and 10 eligible listings across
five scenarios. The held-out split contains 25 judgments and 9 eligible
listings across five different scenarios. Both retrieve 15 listings per arm.

| Split and arm | Retrieval recall | Admission precision | Conflicts admitted | Unresolved admitted | Abstentions | Decision coverage | Displayed recall | nDCG@2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Development structured | 10/10 | 10/10 | 0 | 0 | 2 | 13/15 | 10/10 | 1.000 |
| Development raw cosine | 8/10 | 8/15 | 4 | 3 | 0 | 15/15 | 7/10 | .725 |
| Development gated cosine | 8/10 | 8/8 | 0 | 0 | 3 | 12/15 | 8/10 | .890 |
| Development hybrid | 8/10 | 8/8 | 0 | 0 | 3 | 12/15 | 8/10 | .890 |
| Held-out structured | 9/9 | 9/9 | 0 | 0 | 2 | 13/15 | 9/9 | .919 |
| Held-out raw cosine | 6/9 | 6/15 | 6 | 3 | 0 | 15/15 | 4/9 | .491 |
| Held-out gated cosine | 6/9 | 6/6 | 0 | 0 | 3 | 12/15 | 6/9 | .812 |
| Held-out hybrid | 6/9 | 6/6 | 0 | 0 | 3 | 12/15 | 6/9 | .812 |

The gate agreed with the authored judgments on all 51 pairs (19 eligible,
16 conflicts and 16 unresolved). Raw cosine ranked topical but geographically
or technically incompatible listings above eligible listings. The gate removed
those unsafe admissions while three held-out positives remained outside the
cosine shortlist. The hybrid rerank had the same measured scores as gated
cosine at this cutoff.

As a sensitivity check, the report also gives every gated arm the entire
scenario as its pool and keeps the display cutoff at two. All three arms now
display all eligible listings in both splits. Development nDCG@2 is 1.000
structured and .959 for each cosine-based gated arm. Held-out nDCG@2 is .919
structured and .959 for each cosine-based gated arm. The small-pool recall loss
therefore depends on shortlist depth, and the full-pool ranking result warrants
a broader evaluation of semantic reranking after eligibility filtering.

All opportunity facts, candidate facts and judgments are agent-authored. Labels
were authored before seeing the model scores and have a rationale per pair.
The fixture construction favors clean vocabulary coverage and has small
denominators. One changed held-out positive would move recall by 11 percentage
points. The study leaves extraction accuracy, real-world relevance, ambiguity
frequency and serving performance unmeasured. Five held-out contexts and one
encoder do not establish a population estimate or an architecture winner.

## Costs

On an Apple M4 Max (arm64), Python 3.12.12, Torch 2.8.0 and Transformers 4.56.2,
three cache-warm offline runs used one Torch thread and batches of 16. Median
load time was 52.13 ms. Tokenization, length checks, inference and extracting
normalized vectors took 21.66 ms for 10 candidate inputs and 54.98 ms for 51
opportunity inputs. No fixture input required truncation. A separate synthetic
overlength input exercised the truncation path. Timings exclude package and
model downloads, process startup, imports and writing the output file.

On the same machine, Node 26.10.0 prepared the structured fixture in 1.10 ms and
read and validated the cache in 2.29 ms in the benchmark run. The scoring
benchmark cycles 10 candidate queries across 20,000 catalog rows, repeating
51 distinct fictional listings. Each row is scored for a single candidate per
iteration. Each method gets five warmups and 30 measured iterations.

| Pair scoring work per 20,000-row scan | Median | p95 |
| --- | ---: | ---: |
| Structured score and gate | 1.34 ms | 3.25 ms |
| 384-dimensional cosine | 4.99 ms | 5.14 ms |
| Structured and cosine scores on every row | 6.48 ms | 6.64 ms |

The third row measures the upper-work scenario of computing both scores on
every pair. The hybrid evaluation's shortlist can apply structured work to
fewer rows. These are in-process arithmetic timings with favorable memory reuse
on repeated data. They omit extraction, sorting, filtering at the storage
layer, indexes, I/O, concurrency, pagination and browser rendering. The
benchmark does not estimate production throughput or latency.

## Architecture decision and follow-on work

Start with structured eligibility as the authority and an indexed structured
retrieval and ranking baseline. Keep embeddings as an experimental input to
retrieval expansion or ranking within eligible results. The full-pool
sensitivity supports testing that option after filtering, while the top-three
results caution against using a tight cosine-only shortlist. Defer choosing a
vector index or service until a representative evaluation shows a gain at an
acceptable cost. The existing handwritten rules and assessment paths are
comparison baselines.

1. **Normalize and backfill versioned facts.** Store shared posting facts once
   per source snapshot and private evidence and explicit preferences once per
   candidate revision. Keep provenance, original requirements, role and
   geographic intent, and structured qualifiers. Distinguish missing or
   incomplete analysis from a current analysis that explicitly found no hard
   requirements. Compare old and new facts on a fresh, representative judged
   corpus. Include extractor errors, alternate phrasings, hard negatives and
   unknowns. Use separate development and held-out groups and independent
   relevance judgments.
2. **Build a current, queryable discovery projection.** Index current analysis,
   role and geography for filtering and canonical concept membership for
   retrieval. Carry complete AND/OR and evidence semantics through the final
   gate. Join only a candidate's own evidence or results within the
   authenticated ownership scope. Hide pending, stale and unresolved hard
   evaluations from automatic discovery. Preserve a private reason for
   unknown evidence or rejection. Treat explicit user dismissal or rejection
   as a separate workflow decision. Order deterministically and use indexed
   cursor pagination across the full authorized catalog. Measure query plans
   and end-to-end pagination past 10,000 rows.
3. **Reconcile automatically.** Emit work after committed opportunity analysis
   and after relevant candidate evidence or preference changes. Backfill the
   initial backlog in resumable batches. Schedule repair for missed events
   and stale or failed projections. Key retries by source, candidate,
   vocabulary, extractor and policy versions. Check the expected versions
   before publishing so delayed work cannot restore stale discovery results.
   Keep one versioned result contract for eligibility, ranked evidence and
   private explanations across discovery surfaces.
4. **Evaluate semantic changes in shadow mode.** Derive embeddings separately
   for each changed posting or candidate revision, with zero pairwise model
   calls. Keep posting vectors within their source visibility boundary and
   candidate vectors within the private scope. Compare structured retrieval,
   retrieval union and gated reranking across realistic pool sizes and
   catalog distributions. Set release criteria for eligibility errors,
   recall, ranking, abstention, preprocessing cost and end-to-end latency
   before replacing the baseline.
