# Normalized matching contract

The offline evaluation compares ways to retrieve and rank opportunities using
the same fictional source material and an independently authored set of
judgments. The contract separates eligibility from relevance. Eligibility
describes whether the available evidence satisfies the explicit hard
constraints. Relevance grades how well an eligible opportunity fits the
candidate's intent and demonstrated work. Neither is a hiring prediction.

## Inputs

| Field | Meaning |
| --- | --- |
| Opportunity ID, source, version | Stable listing identity and the provenance of the source snapshot used for evaluation. |
| Opportunity text | Source-derived text for retrieval and explanation. |
| Opportunity role and regions | Normalized role and allowed work locations. A null value leaves the corresponding fact unresolved. An empty regions array means the source explicitly allows work from anywhere. |
| Opportunity must and preferred groups | Atomic capability requirements. All must groups apply. Within a group any listed alternative satisfies the group. Preferred groups contribute to relevance. An empty group list encodes no constraints of that kind. |
| Candidate ID and text | Candidate-scoped identity and evidence text used for retrieval. |
| Candidate concepts | A concept value, its evidence state, and a supporting excerpt from the candidate text. The supported, absent, and unknown states describe what the evidence establishes. Omitted concepts are unknown. |
| Candidate target role and region | Explicit role intent and current work location. Either may be unknown. The role field describes the work sought, independently of titles previously held. |

Source-derived opportunity facts can be shared across candidates with access to
the same posting. Candidate text, evidence, intent, vectors derived from that
text, and match results belong to the candidate's private scope. A public
opportunity index contains only source material within its visibility boundary.
An explanation can link to the relevant source snapshot and candidate evidence
within the private result. It should retain the evidence and the versions of
the source, profile, extractor, and concept vocabulary used in the decision.

## Concepts and eligibility

Stable concept IDs are independent of display labels. A canonical ID or an
exact alias resolves to the same concept after trimming whitespace and folding
case. For example, Node, Node.js, and the canonical ID `nodejs` are equivalent
within this technology vocabulary. A bare “Node” outside that context may
need disambiguation. Punctuation remains meaningful.

A `narrower` relation points from the more specific concept to the broader
concept. Evidence of IP routing supports networking. General network design
does not establish IP routing. An explicit absence of a broad capability can
rule out its narrower capability when the absence genuinely covers that
scope. A `related` relation records an association useful for retrieval.
Experience in Node.js alone leaves TypeScript unknown, and mentoring alone
leaves responsibility for direct reports unknown.

A must group is supported when any alternative has evidence, absent when all
alternatives are explicitly absent, and unknown otherwise. A known conflict
in a must group, target role, or allowed region makes the pair ineligible.
An unresolved hard constraint makes the pair unknown unless another hard
constraint establishes ineligibility. With all hard constraints satisfied,
the pair is eligible. An unknown preferred group can affect evidence coverage
and ranking while leaving eligibility intact. Text similarity, a suggestive
title, and an optional capability provide no evidence that a hard constraint
has been met.

## Extraction and migration

Production normalization would extract structured opportunity facts once per
source version. Preserve the exact source wording alongside the interpretation
and preserve distinctions such as “A and either B or C,” “preferred,” and
“remote within Canada.” A source with ambiguous or missing restrictions
needs an unresolved fact rather than a permissive default. Empty groups in
this offline fixture describe complete, authored requirement lists. A
production extractor needs a separate way to mark incomplete extraction.

The production representation should support multiple target role families and
acceptable work locations, explicit relocation intent, and the distinction
between work location and employer geography. A listing may have different
onsite, hybrid, or remote geographic limits. The fixture uses one target role
and region per candidate to isolate how the hard gate handles each constraint.

A declared skill can establish a bare capability when its meaning is clear.
Claims about duration, recency, production use, scale, or supervisory duties
require supporting evidence scoped to those qualifiers. Keep dated evidence
and duration claims attributable to the applicable projects, duties, or intervals. These fixtures
exercise named capabilities and explicit role and region constraints.
Arbitrary screening questions may contain conditions or subjective judgments
that fall outside the vocabulary. Preserve their wording and context for
review. When an unresolved question is required, carry the uncertainty into
the decision instead of substituting a generic concept or similarity score.

The current system has posting extraction, public coverage, private evidence
matching, and assessment records with different purposes and versions. A
migration can begin by mapping their source facts and attributable evidence
into one versioned representation and comparing a shadow projection against
the current outputs. Re-extract current source snapshots when the old record
cannot preserve grouping or qualification scope. Bind computed results to the
source, private profile, and contract versions so a change cannot be served as
current. Keep user-owned application and rejection decisions distinct from
automated eligibility. Historical assessments retain their original
interpretation. The offline representation leaves persistence and migration
execution to subsequent work.

## Judgments

The [fictional corpus](../scripts/matching-evaluation/fixtures.json) contains
ten candidate scenarios across eight families and 51 exhaustively judged
candidate–opportunity pairs. Candidate and posting text, requirement
normalization, and labels were authored for the study. Judgments were
written before model outputs and store one explicit rationale per pair. The
relevance grades are 0 for ineligible or unknown, 1 for eligible and plausible,
and 2 for eligible with a direct match to the candidate's demonstrated work
or stated preferences. The separate eligibility labels distinguish unresolved
evidence from an explicit rejection even when both carry grade 0.

| Split | Families | Scenarios | Pairs | Eligible | Ineligible | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 4 | 5 | 26 | 10 | 8 | 8 |
| Held-out | 4 | 5 | 25 | 9 | 8 | 8 |

All cases in a scenario family stay in the same split, including the Node.js
and TypeScript confounders and the two directions of the networking relation.
The reported arms use fixed scores and cutoffs selected before scoring. No
threshold or weight was fitted. Use development cases for future policy
selection and a fresh held-out set after inspecting these results. Shared contract rules
occur in both splits. The corpus includes role-title ambiguity, mentoring
versus management, remote geography, explicit role intent, directional
capabilities, conjunctions, alternatives, and missing hard and optional
evidence.

The small, agent-authored corpus is useful for controlled comparisons and
failure inspection. It contains no owner profiles or production postings.
Its results characterize these fixtures and do not estimate performance on a
representative catalog, real applicants, or automatic extraction.
