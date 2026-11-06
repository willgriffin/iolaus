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
  --cohort /private/path/ids.json --apply --max-calls 250 --max-cost-micros 50000
```

The command writes only selected current source interpretations and invalidates
the corresponding matching projection revisions. It does not update candidate
data or preferences. Use the existing provider-free local matching worker to
refresh the projection, then open the local authenticated matching list.
Refreshes read prepared data. Keep the operator report private. It contains
per-posting indexes and counts, no source quotes, profile data, endpoint URL,
or raw error details.

## Verification batch limits

Independent verification handles a requirement or a scope restatement in
its own request. Context audits group at most three units. A closed parse
can establish a title, work location, Boolean structure, or qualifier when
it consumes the entire relevant span. Typed audits separately assess
applicant strength, capability membership, and any additional condition. In a controlled Jev replay, the
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

## Multiline scope and assessed gaps

A verified block binds an exact anchor and adjacent source unit IDs from the
current capture. The host derives explicit AND or OR wording and inherited
strength from the exact source. Flattened lists need a clear next boundary,
and the independent audit verifies that boundary against the actual
neighboring units. Exact known branch identity can come from a closed
vocabulary alias. Unknown branches remain unknown. A supported OR branch
can satisfy the group if it carries no unresolved inherited qualifier.
A shared depth qualifier applies to every branch. Direct evidence for a
known branch may support a screened result while depth stays unproven.

An assessed capability gap preserves the exact requirement and qualifier
when the matcher cannot verify its full scope. It needs positive independent
classification and a separate non-capability restriction check. An unread
unit, failed audit, or unresolved eligibility clause still blocks screening.
The detail route resolves cited source gaps from the current source snapshot.
List responses carry summaries and matching reads remain provider-free.

## Local quality status

The fixed 33-posting cohort left 33 current local projections. The opening
list had two screened results. The final list had three, including one prior
control and two Jev-prepared proofs. One of those restored a previously visible
posting after a controlled comparison. The Staff Software Engineer result is
the net addition. Three postings had conflicts, 27 remained unflagged, and
none qualified. Across stored mixed-version proofs, 1,283 of 1,865 units had
complete verification.

The two Jev-prepared results accounted for the original three-year requirement
on one posting and the exact four-branch OR with inherited depth on the other.
Staff had 53 of 53 verified source units. Its recognized distributed-systems
evidence counts as partial while the depth and remaining conditions stay
open. The Backend control remained unflagged because work arrangement and
an export-license clause were unresolved. These cases do not establish
catalogue-wide coverage.

Repeated preparation and targeted diagnostics made 1,959 calls with
1,919,743 input and 349,975 output tokens. The configured input-token
rate and per-call rounding totalled $0.081606, with no SDK retries or unknown
usage. The final cached Staff reprojection used zero provider calls.
The actual profile and preferences were unchanged throughout.
