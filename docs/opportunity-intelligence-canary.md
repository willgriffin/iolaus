# OpenAI Opportunity Intelligence Canary

This canary evaluates only the bounded `prepared-posting/v1` extraction and
`opportunity-scoring-input/v2` scoring paths. It does not crawl, mutate
opportunities, write applications, or change the `good` application-writing
profile. The fixture corpus is deterministic, synthetic, and uses only
`example.invalid` URLs.

## Predeclared acceptance thresholds

The source-controlled `opportunity-intelligence-canary/v1` report is accepted
only when every gate passes in one complete seven-case run:

- at least 90% of all field checks and 75% of checks for every individual field
  pass across unique long, noisy, sparse, remote/hybrid, compensation, and
  ambiguous-seniority cases;
- at least 85% of cases agree with the declared scoring decision and
  recommendation, including at least two model-eligible scoring cases;
- model-request p95 latency is at most 90 seconds;
- every extraction/scoring payload is within its configured ceiling and the
  minimum measured context headroom is at least 20%;
- the case failure rate is 0%.

Do not loosen a gate in response to a failed run. Change a threshold only in a
separately reviewed commit with a product or operational rationale, then begin
a new canary series.

## Run the canary

The canary profile is pinned to `openai/gpt-5.6-luna` through Bifrost and uses
the dedicated opportunity-intelligence virtual key. Production
extraction/scoring ignores request-level profile hints; only the
operator-controlled deployment selector can choose OpenAI Luna, Z.ai, or the
explicit stop state. The historical internal profile name
`opportunity-intelligence-fallback` is an audited OpenAI profile name, not
fallback behavior. A provider error never changes the selected profile.

```bash
export OPPORTUNITY_INTELLIGENCE_PROFILE=openai
export BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY='<from approved secret source>'
export BIFROST_OPPORTUNITY_INTELLIGENCE_FALLBACK_MODEL='openai/gpt-5.6-luna'

pnpm --filter @willgriffin/iolaus-site opportunities:intelligence-canary preflight
pnpm --filter @willgriffin/iolaus-site opportunities:intelligence-canary run \
  > opportunity-intelligence-canary.json
```

The report contains case IDs, failed field names, expected/actual scoring
labels, token counts, headroom, latency, and classified failure modes. It does
not contain prompts, fixture text, model response bodies, credentials, resume
evidence, or provider error bodies. Store an accepted report in the approved
operations evidence system; do not commit transient run output.

## Rollout and monitoring

After an accepted fixture run:

1. Keep the persisted circuit open and crawl enqueue cap at zero while the site
   and worker receive the same OpenAI selector, pinned model, dedicated key, and
   #210 call/token/spend budgets.
2. Run database migration/status checks, then use the control command to enable
   a maximum five-opportunity cohort. Treat five as an upper bound: reduce the
   cohort so its worst-case call count fits the dedicated key's remaining
   request allowance. Do not enable application-writing or any other AI profile
   as part of this change.
3. Monitor the content-free request audit, run/crawl reservations, Bifrost key
   counters, p50/p95 latency, context headroom, failure modes, result reuse, and
   stale-work discards. Stop immediately on accounting drift, any ceiling
   violation, two consecutive failures/aborts, or p95 above 90 seconds.
4. Compare cohort field quality and scoring decisions with operator review.
   Record regressions by field and case ID, never by copying posting or resume
   content into logs.

## Rollback

To stop new intelligence without interrupting crawling or source-fact writes:

```bash
pnpm --filter @willgriffin/iolaus-site opportunities:intelligence-control stop
```

Also set `OPPORTUNITY_INTELLIGENCE_MAX_ENQUEUES_PER_CRAWL=0` to prevent new
queue work. Crawls continue to persist source snapshots and facts independently.

For the explicit Z.ai alternative, keep the circuit open, deploy
`OPPORTUNITY_INTELLIGENCE_PROFILE=zai` with `zai/glm-4.7-flashx`, verify #210
pricing/budgets, then run the enable command. There is no automatic
OpenAI-to-Z.ai fallback. Existing application-writing remains on `good` /
`openai/gpt-5.6-terra` throughout.

