# Role-scoped resume import — local implementation

Explicit user scope: one query per role, preserve responsibility/bullet sections,
accumulate evidence-backed skills; clear local resume content and import a fresh
set from retained owner PDF. No push, PR, deploy or remote tracking. Preserve
account, authentication, opportunities/applications, source PDF, and recovery copy.
New feature begins after prior readiness cycle completed clean at round6; this
review scope is the new role/index/sections/evidence contract, not a reset of
unresolved review findings. Previous code remains inherited baseline.

## Contract
- Index source-ordered role/global block starts once using source line IDs;
  server derives contiguous ends from the next start, preserving every line
  once without overlapping model-owned end boundaries; role requests receive only
  their validated spans plus minimal role context, never whole resume. No gaps,
  overlap, invented spans or silent role drops. Small bounded concurrency/calls,
  fresh authorization/metering per request; whole result fails if a role fails.
- `bulletSections` review field is JSON [{title,bullets:string[]}]. Keep existing
  unsectioned `bullets` compatible. Persist section titles with Duty.title; genuine
  projects retain Project records. Literal URL-backed standalone headings matched
  to a model section are source-grounded projects, with their URL retained.
  Same-heading section/project duplicates merge their distinct bullets once.
  Role labels/categories are not projects.
- Model skill evidence cites absolute role source-line IDs (no copied quote/page),
  with concise usage descriptions; server derives exact quote and page. Omit observations whose cited line does
  not name the skill or a controlled alias; strip dates absent from that line,
  and warn when either adjustment occurs.
  `skillEvidence` review field is JSON evidence observations, with
  proposalExperienceId, usage, depth (hands_on|leadership|mentioned), quote, page,
  optional skill-specific startDate/endDate. Do not borrow role dates as usage
  dates. Evidence is tied to supported source quotations and indexed roles.
  Store accumulated observations in owned SkillGroup.evidenceJson (new text field),
  resolve role labels/dates/owned actual experience IDs server-side at apply,
  deduplicate observations without summing overlapping durations or scoring expertise.
- Owner tuple, native review/apply transaction, stale checks, no inferred facts,
  private export/deletion, byte limits and bounded model spend remain enforced.

## Behavior-to-test matrix
| Invariant | Trigger / positive | Failure case | Context/executor/runtime/edge | Evidence |
| --- | --- | --- | --- | --- |
| Role isolation | Index multirole source; each role call only matching spans | Missing/overlap/out-of-bounds index, wrong role, role call failure | Authenticated native worker; Node26; metered strict Bifrost schemas | Extraction unit+actual fictional and owner QA |
| Sections vs projects | Omnium headings become labeled duties; named products genuine projects | Category promoted to project, lost/duplicated bullets | Source evidence -> review -> owned transaction -> HTML | Extraction, domain native SQLite/Postgres, browser/render tests |
| Skill evidence | Same skill from two roles accumulates quoted uses | Unsupported quote/depth/dates, foreign role, duplicate apply, absent usage dates | Owned SkillGroup; same transaction and ownership fences | Unit/native rollback/stale tests; actual review |
| Review UI | Edit section titles/bullets, inspect skill observations | Invalid JSON internals, unmount/errors, escaping | Svelte browser, server validation, rendered resume | Browser+SSR/render tests |
| Local reset | Snapshot exact owned resume rows, clear only candidate resume; fresh import | Foreign ownership/account/opportunity touched; failed reset | Isolated local PG; explicit user authorization; recovery copy | Scoped transaction+before/after counts+real browser QA |

Validation: narrow tests then root format/lint/check/test/build; migrated local DB
and status; independent review on current local hashed sources. Base failing
Omnium classification is captured in prior applied receipt (6 category projects).
Do not send private resume text to reviewers or logs. Owner re-extraction through
previously approved local PDF/Paddle and Bifrost Luna only. No publication.

Validated extraction pitfall: org PDF 0.65.9 unpdf reader joins page text
items with spaces; preserveFormatting is declared but not honored. The retained
PDF produced six single-line pages (18,649 characters), so line-based role spans
necessarily overlapped. Substantial flattened pages now enter the existing
authorized Paddle path before indexing; structured native pages keep the fast path.
