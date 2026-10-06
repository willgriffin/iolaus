# Posting eligibility

Opportunity list and triage share an OR filter for **Canada eligible**, **Visa
sponsorship possible**, **US residence required**, **Unknown**, **Conflicting
evidence**, and **Canada work location excluded**. Remote is a separate filter.
Visa sponsorship and US residence can overlap: a role may require relocation
while offering sponsorship. Canada eligibility describes the posting's stated
work geography, not a candidate's legal authorization. EOR is retained as a
separate fact and does not establish visa sponsorship.

The initial classifier is deterministic and token-free. It recognizes captured
ATS role-location fields such as `Remote, Canada` and scans complete
bounded captured source text for explicit posting clauses, stores exact excerpts
and source lines, and withholds positives when geography or sponsorship facts
conflict. Semicolon-separated ATS locations are alternatives: Canada plus US
supports Canada geography, while US plus UK does not require US residence.
Bare country/city names and editable derived locations do not establish facts.
Captured field assertions retain `sourceField: locationNotes` provenance.
Conditions and Canadian province restrictions remain uncertain when
candidate region is unknown. Benefits/company boilerplate does not establish
role requirements. Historical scores and `visaOrEorPossible` do not establish
eligibility; candidate `workAuthorization` is never a posting classification gate.

Every Opportunity save rebuilds this projection after independently recomputing
the source snapshot fingerprint. Reads compare source version/fingerprint and
freshly extracted clauses with stored evidence. Missing, stale, or invalid
evidence becomes Unknown. The SQL list uses the source-bound projection and
accepts only coherent classifier flag states. Material source changes invalidate
the projection.

Current source assertions also enter the existing governed scoring pipeline's
typed input, bounded evidence, material fingerprint, and model prompt. This does
not add an independent provider call or change existing human decisions. The
initial bucket classifier itself is not model-backed.

## Bounded refresh

From the site package, with the intended application environment selected:

```sh
pnpm exec tsx scripts/refresh-opportunity-eligibility.ts --limit 500
pnpm exec tsx scripts/refresh-opportunity-eligibility.ts --limit 500 --apply --expected-plan <preview-planHash>
```

Dry run is the default. The command reports counts and a preview hash without
posting contents. Apply requires the same hash and independently compares the
source fingerprint, version, and JSON on each update. It writes only four
eligibility columns; human decisions, ratings, notes, scores, and timestamps stay
unchanged. `--after <nextAfter>` pages by text UUID order, identically on SQLite
and PostgreSQL. Maximum explicit batch size is 10,000; provider calls are zero.
Back up the selected database before an operator-controlled refresh.

Focused tests cover source clauses/negatives/conditions/contradictions, stale and
forged evidence, both SQL dialects with OR buckets/pagination/Remote, refresh
empty UUID cursor and nullable source CAS, preserved human notes, and browser
filter URL/reload behavior.
