# Local Jev posting QA

The local publisher prepares selected public posting captures with the existing
Jev SDK and commits the resulting proof through the matching source worker.
The source digest, fingerprint, capture revision, listing revision, and worker
lease are checked before publication. The proof carries the preparation,
provider, model, and deployment revision. It is reused only for the same
capture, ontology, and strategy.

The proposal distinguishes mandatory and preferred conditions, groups
alternatives, retains supported tenure and use context, and links to the exact
source unit. An independent typed verification pass can decline any part.
The report separates unasked, declined, failed, and verified units. The
publication state `complete` means the worker stored the proof. It does not
mean each source unit was verified or that a profile qualifies. Current
matching and ranking remain provider-free and use the existing owner-scoped
candidate evidence. New candidate preparation still follows its configured
path when a current verified candidate cache is unavailable.

## Use the isolated clone

Provide `DATABASE_URL` for the approved loopback PostgreSQL QA clone in the
operator environment. The script checks the exact host, port, and database
name and refuses URL query overrides. Put 1–40 distinct current public posting
UUIDs in a private JSON array outside the checkout. Verify that the operator
may send the selected public source excerpts to the chosen provider.

```sh
pnpm --silent --filter @willgriffin/iolaus-site matching:source-jev-publish \
  --cohort /private/path/ids.json
```

Set `IOLAUS_SOURCE_DECISION_PROVIDER=typesafe`,
`IOLAUS_SOURCE_DECISION_TRANSPORT=direct`,
`IOLAUS_SOURCE_DECISION_MODEL=jev-1.14.0`,
`IOLAUS_SOURCE_DECISION_REVISION`, `TYPESAFE_API_KEY`, and the verified input
rate `IOLAUS_SOURCE_DECISION_JEV_INPUT_COST_MICROS_PER_MILLION` in the operator
environment. A separately verified Bifrost route may use the explicit Bifrost
settings in [the decision evaluator guide](matching-source-decision-evaluation.md).
The publisher does not select any other route on failure.

```sh
pnpm --silent --filter @willgriffin/iolaus-site matching:source-jev-publish \
  --cohort /private/path/ids.json --apply --max-calls 1300 --max-cost-micros 480000
```

The command writes only selected current source interpretations and invalidates
the corresponding matching projection revisions. It does not update candidate
data or preferences. Use the existing provider-free local matching worker to
refresh the projection, then open the local authenticated matching list.
Refreshes read prepared data. Keep the operator report private. It contains
per-posting indexes and counts, no source quotes, profile data, endpoint URL,
or raw error details.

## Verification batch limits

Independent verification runs metadata separately and groups at most three
source units of the same audit type. In a controlled Jev replay, the
original 12-unit batch declined both short employer-benefit controls at
0.37 and 0.49. Inlining their quotes in the same batch produced 0.49 and
0.50. The three-unit replay confirmed the two controls at 0.81 and 0.72
and declined the mandatory-condition negative control at 0.05. The wiring
test checks request boundaries. Those observed model scores do not guarantee
future outcomes, and the verification threshold remains unchanged.

Standalone labels from the closed title and heading grammars have no extra
clause to interpret. Role and geography judgments are separate. Source
units with mailboxes can enter the context audit only when the captured line
passes the existing applicant-condition check. The provider receives a
mailbox placeholder. The proof and citations remain bound to the unmodified
capture. Residual personal contact details and unclear restrictions leave the
unit unresolved.

## Local quality status

A 31-posting comparison plus two later captures produced zero new visible
Jev matches for the unchanged local QA profile. The existing visible control
still loaded with cited support and gaps. An authenticated browser run
measured a warm full-list p95 of 254 ms over 11 loads and observed the shell
before the matching payload.

On a representative 39-unit posting, successive diagnostic runs increased
verified coverage from 22 to 25 to 30 units. A later run assessed every unit
and verified 31, but the worker retained the preceding proof after the
geography judgment regressed. One isolated audit per source unit still
declined several employer-only sentences and the explicit remote geography.
That result identifies a verification-quality blocker even when all of the
source text was read. The isolated audit did not publish any proof.

The local QA did preserve a verified three-year requirement, reject unrelated
role and geography cases, and keep unsupported clauses out of qualification.
The result does not establish that this preparation path can yet produce a
useful matching list from the sampled real postings.
