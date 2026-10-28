# Surface parity matrix

Tracks willgriffin/iolaus#260: every capability of the authenticated UI must be
reachable through the generated agent surfaces — the `iolaus` CLI, the
`/api/[resource]` REST routes and the MCP tools — with the same authorization,
tenant scoping and workflow side effects, or carry a recorded reason to stay
UI-only. Update the `Status` column in the same pull request as any change to a
`@smrt()` surface include, an MCP tool registration, or an admin form action.

## Method

- UI capabilities: every form action and mutating `+server.ts` under
  `apps/site/src/routes/admin`, `apps/site/src/routes/api/admin*`,
  `apps/site/src/routes/api/job-search`, plus the authenticated non-admin
  routes (`/account/connections`, `/setup`).
- Agent surfaces: `listApiExposedResources()` / `listMcpExposedResources()`
  in `apps/site/src/lib/server/api-exposure.ts` (decorator-driven CRUD),
  `GET /api/_resources` discovery (CLI, mirrors the `cli` include), the
  workflow tools in `mcp-tools.ts` (legacy `/api/mcp/tools` + `/api/mcp/call`
  catalog, which `iolaus mcp tools|call` uses) and in `mcp-app-server.ts`
  (canonical `POST /api/mcp` catalog), and the WebMCP / `/api/job-search`
  tools in `apps/site/src/lib/webmcp.ts`.

## Surface topology (facts that shape the plan)

1. **Generated CRUD is decorator-driven and currently covers only the shared
   catalog.** Every candidate-owned class (`Application`, `Task`, `Decision`,
   `PreferenceRule`, `ResumeAsset`, `ResumeVariant`, the whole career model,
   …) carries `api/cli/mcp: { include: [] }` since the private-workspace
   isolation work (#138). The REST route and `callMcpTool()` still contain
   guards for `application_*`, `resumevariant_*` and `resumeasset_*` writes,
   but those tools are no longer generated; the specs assert they stay off.
2. **Generic REST is operator-only in shared-hosted mode.**
   `assertGenericResourceAccess()` (`workspace-resource-policy.ts`) returns
   403 for every `/api/[resource]` request from a non-operator on jobgeni.us,
   and the generic routes apply no per-owner `where`. Flipping a private
   class's decorator alone would therefore expose it tenant-wide to
   operators and not at all to owners. Opting a private class in requires
   the generic REST and MCP CRUD paths to apply the same
   `workspaceResourceWhere` / `workspaceRecordAllowed` /
   `workspaceResourcePayload` scoping the admin UI already applies in
   `admin-data.ts`, and the operator gate must then apply only to
   non-private classes.
3. **`MCPGenerator` list tools accept a caller-supplied `where`.** Any
   private class exposed through the generator must have its owner tuple
   merged over the caller filter, never trusted from arguments.
4. **There are three MCP catalogs.** Generated CRUD and the two bounded
   source-read tools live only on the legacy REST-shaped bridge
   (`/api/mcp/tools`, `/api/mcp/call`), which is what the CLI's `iolaus mcp`
   commands call. The canonical `POST /api/mcp` server (`mcp-app-server.ts`)
   carries the public search tools, `match_my_profile`,
   `refresh_my_matches` and five `job_search_*` workflow tools. The sixteen
   `job_search_*` tools are otherwise WebMCP + `/api/job-search/<action>`
   only. So a workflow tool is CLI-reachable only when it is in the legacy
   catalog; today none of the `job_search_*` workflow tools are.
5. **The owner principal allow-list derives from these catalogs**
   (`tool-catalog.ts`): the legacy MCP catalog, the WebMCP definitions, the
   DataSurface bulk-action names and the two app workflow tools. A new tool
   is authorizable only once it is listed in one of them, and its generated
   `(collection, action)` permissions must be declared in
   `workflow-operations.ts` / `mcpToolOperations()`.
6. **Admin UI generic CRUD skips two REST checks.** The `[resource]`
   create/update/delete form actions do not call
   `assertGenericResourceAccess()` nor the `@smrt({ api })` action-exposure
   check; they rely on the session guard plus workspace scoping. The
   agent surfaces must keep their stricter behaviour.

## Status legend

- `exposed` — reachable on CLI, REST and MCP with equivalent authorization.
- `partial` — reachable on some surfaces, or with a narrower contract; the
  `Notes` column says which surface is missing.
- `missing` — UI-only today with no recorded reason; scheduled for a tranche.
- `UI-only` — stays UI-only on purpose; the reason is recorded.
- `tool-only` — exists for agents but has no UI equivalent (listed for
  completeness; not a gap for #260).

CLI column: `crud` means `iolaus <slug> list|get|create|update|delete`
(discovered from `/api/_resources`); `mcp` means `iolaus mcp call <tool>`;
`—` means unreachable from the CLI without raw HTTP.

## A. Shared catalog CRUD (admin `[resource]` pages)

| Capability | UI route / action | CLI | REST | MCP | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Opportunity CRUD | `/admin/opportunities` create/update/delete | crud | `/api/opportunities` | `opportunity_list/get/create/update` | exposed | MCP omits `delete` by decorator choice; REST/CLI keep it. Hosted non-operators: operator-only on every surface, matching the UI's `assertWorkspaceResourceWritable`. |
| Company CRUD | `/admin/companies` | crud | `/api/companies` | `company_*` | exposed | Same operator rule. |
| CompanyResearch CRUD | `/admin/company-research` | crud | `/api/companyresearches`, `company_research` | `companyresearch_*` | exposed | |
| CompanyAttachment / CompanyTag CRUD | `/admin/company-attachments`, `/admin/company-tags` | crud | `/api/companyattachments`, `/api/companytags` | `companyattachment_*`, `companytag_*` | exposed | |
| Opportunity relations (OpportunityTag / OpportunityPlace / OpportunityRole / OpportunityCompany) | `/admin/opportunities/[id]` `createOpportunityRelation` / `deleteOpportunityRelation`; `/admin/opportunity-*` pages | crud | `/api/opportunitytags` etc. | `opportunitytag_*` etc. | exposed | UI asserts `<collection>.create` / `.read`+`.delete`; the generic surfaces assert the same generated permissions. |
| Source CRUD | `/admin/sources` create/update/delete, `/admin/sources/new` | crud | `/api/sources` | `source_list/get/create/update` | exposed | Side effects (`syncSourceSchedule`, `syncSourceAccountTasks`, `deleteSourceSchedule`) run on REST and MCP; `sourceWorkflowSyncOperations` grants them. |
| SourceTag CRUD | `/admin/source-tags` | crud | `/api/sourcetags` | `sourcetag_*` | exposed | |
| SourceCrawl / SourceCrawlItem read | `/admin/source-crawls`, `/admin/source-crawl-items` | crud (list/get) | `/api/sourcecrawls`, `/api/sourcecrawlitems` | `sourcecrawl_list/get`, `sourcecrawlitem_list/get` | exposed | Writes refused everywhere (system-authored). |
| OpportunityIntelligenceControl read | (no admin page; operator setting) | crud (list/get) | `/api/opportunityintelligencecontrols` | `opportunityintelligencecontrol_list/get` | exposed | Hosted: scoped-workflow-only (403 on REST), same as the UI. |
| Fact catalog read (`Fact`, `FactContent`, `FactEvidence`, `FactSource`, `FactSubject`, `FactTag` from smrt-facts) | `/admin/facts` (read), fact intake actions | crud | `/api/facts` etc. | `fact_*` | exposed | Hosted: scoped-workflow-only on REST, same as UI. |

## B. Career / résumé model (tranche a, #259)

All classes here are `@TenantScoped`, carry the `{tenantId, ownerUserId,
candidateProfileId}` ownership tuple and are read by `loadAdminResumeSource()`
through `NORMALIZED_RESUME_READ_PLAN`. The UI edits them through the generic
`[resource]` pages, `/admin/career` (`save`, `visibility`),
`/admin/resume` (`updateProfile`, `updateExperience`, `updateEducation`,
`setDefaultProfile`) and `/admin/candidate-profile-links` (`save`). Admin
writes invalidate the published-résumé cache and queue the canonical refresh
(`admin-data.ts` `queueResumeRefreshAfterSourceWrite`,
`career-management.ts`); the same side effect must run for agent writes.

| Capability | UI route / action | CLI | REST | MCP | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| CandidateProfile read/update (identity, contacts, summary, `useOnResume`, `isDefault`) | `/admin/candidate-profiles`, `/admin/career` `save` (profile), `/admin/resume` `updateProfile`, `setDefaultProfile`, `/admin/onboarding` `save` | — | — | — | missing | Tranche (a): list/get/update only, never create/delete (onboarding creates). Every field is `sensitive`; scoped to the verified owner's own profile. |
| CandidateProfileLink CRUD | `/admin/candidate-profile-links` `save`, `/admin/career` `save` (links) | — | — | — | missing | Tranche (a). |
| Experience CRUD | `/admin/experience`, `/admin/career` `save`, `/admin/resume` `updateExperience` | — | — | — | missing | Tranche (a). |
| ExperienceRole / ExperienceCompany CRUD | `/admin/experience-roles`, `/admin/experience-companies` | — | — | — | missing | Tranche (a). `companyId` references the shared `Company` catalog. |
| EmploymentRole / EmploymentRoleTag CRUD | `/admin/roles`, `/admin/role-tags` | — | — | — | missing | Tranche (a). |
| Project / ProjectTag / ProjectAttachment CRUD | `/admin/projects`, `/admin/project-tags`, `/admin/project-attachments`; `/admin/experience/[id]/edit` `createRelatedProject` / `updateRelatedProject` | — | — | — | missing | Tranche (a). |
| Duty / DutyTag CRUD | `/admin/duties`, `/admin/duty-tags` | — | — | — | missing | Tranche (a). |
| Achievement / AchievementTag / AchievementAttachment CRUD | `/admin/achievements`, `/admin/achievement-tags`, `/admin/achievement-attachments`; `/admin/experience/[id]/edit` `createRelatedProjectBullet` / `updateRelatedProjectBullet` | — | — | — | missing | Tranche (a). |
| Education / EducationTag CRUD | `/admin/education`, `/admin/education-tags`, `/admin/resume` `updateEducation` | — | — | — | missing | Tranche (a). |
| SkillCategory / SkillCategoryMember / SkillGroup / SkillGroupMember CRUD | `/admin/skill-categories`, `/admin/skills`, `/admin/skill-groups`, `/admin/skill-group-members` | — | — | — | missing | Tranche (a). `SkillGroup.evidenceJson` is sensitive. |
| Attachment CRUD (file metadata) | `/admin/attachments` | — | — | — | missing | Tranche (a) metadata only; the upload path stays UI/REST. |
| Résumé visibility toggles (`useOnResume`) | `/admin/career` `visibility` | — | — | — | missing | Covered by `update` on the classes above once exposed. |
| Public profile: prepare preview | `/admin/career/public-profile` `prepare` | — | — | — | missing | Tranche (a): `public_profile_prepare` on `preparePublicProfile()`; keeps the 20-per-48 h limit and artifact checks. |
| Public profile: publish prepared revision | `/admin/career/public-profile` `publish` | — | — | — | missing | Tranche (a): `public_profile_publish` on `publishPublicProfile()` (revision id + expected base revision). |
| Public profile: unpublish | `/admin/career/public-profile` `unpublish` | — | — | — | missing | Tranche (a): `public_profile_unpublish`. |
| Public profile: status / pending preview | `/admin/career/public-profile` load, `preview/[id]` | — | — | — | missing | Tranche (a): `public_profile_status` on `getPublicProfileManager()`; the preview PDF bytes stay on the admin route. |
| Legacy `Resume*` classes (`ResumeProfile`, `ResumePosition`, `ResumeAchievement`, `ResumeSkill*`, `ResumeEducation`, `ResumeLink`, `ResumeOtherRole`) | (read fallback only; no dedicated admin page) | — | — | — | UI-only | Legacy read-only fallback (`LEGACY_RESUME_READ_PLAN`) slated for removal; agents write the normalized model. |
| ResumeTailoringConfig CRUD | `/admin/resume-tailoring-configs` | — | — | — | missing | Tranche (b) with the other résumé-generation records. |
| Tag vocabulary lookup (`Tag` from smrt-tags, needed for every `*Tag.tagId`) | combo pickers on the tag pages | — | — | — | missing | Tranche (b): bounded read-only tag lookup; `exposablePackages` excludes smrt-tags today. |
| Résumé import (upload, review, apply, retry) | `/admin/career/import`, `POST /api/admin/resume-import*` | — | `/api/admin/resume-import*` | — | partial | REST only, by design of the multipart upload + reviewed-proposal flow; tranche (c) decides whether an MCP `resume_import_*` wrapper is worth it. |

## C. Private workspace model (tranche b)

The UI edits these through the generic `[resource]` pages with owner
scoping. They left the agent surfaces in #138; re-exposing them needs the
scoped CRUD path from the topology notes.

| Capability | UI route / action | CLI | REST | MCP | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Application CRUD | `/admin/applications` create/update/delete | — | — | — | missing | Tranche (b). The existing guards (`assertApplicationCreatePayload`, `commitApplicationIfCurrent`, no final approval / submission / `materialWriteLock` through generic writes) stay. |
| ApplicationMaterialComment CRUD | `/admin/application-material-comments` | — | — | — | missing | Tranche (b). |
| Task CRUD | `/admin/tasks`, `/admin/tasks/new` | — | — | — | missing | Tranche (b). |
| Decision / DecisionTag CRUD | `/admin/decisions`, `/admin/decision-tags` | — | — | — | missing | Tranche (b). |
| PreferenceRule CRUD (screening questions, preferences) | `/admin/preferences`, `/admin/preferences/screening-questions` `save` / `delete` | — | — | — | missing | Tranche (b). The screening-question store's optimistic `expectedRevision` becomes the generic revision guard. |
| ResumeAsset list/get/update/delete | `/admin/resume-assets` | — | — | — | missing | Tranche (b). Application-owned assets stay immutable (guards already in both generic paths). |
| ResumeVariant CRUD | `/admin/resume-variants` | — | — | — | missing | Tranche (b). Reservation / approval sync guards already in both generic paths. |
| CandidateAnswer (reusable answers) | `/admin/onboarding` `revokeReusableAnswer`, application `provideAnswers` / `revokeReusableAnswer` | — | — | — | missing | Tranche (b): list/get/update/delete; creation stays with the application workflow. |
| FactIntake / FactCandidate | `/admin/fact-intakes`, `/admin/fact-candidates` | — | — | — | missing | Tranche (b) read; writes go through the intake tools in D. |
| EvaluationScore / OpportunityAssessment read | `/admin/evaluation-scores`, assessment panels | — | — | — | missing | Tranche (b): list/get only (system-authored). |
| AgentRun read | `/admin/agent-runs` | — | — | — | missing | Tranche (b): list/get only; the audit surrogate `(agentruns, read)` already exists in `workflow-operations.ts`. |
| MatchModel, RequirementEvidenceDecision, OpportunityRecommendationRank | (no admin page) | — | — | — | UI-only | Internal matching state with no UI editor; `match_my_profile` / `refresh_my_matches` are the agent interface. |

## D. Workflow actions

| Capability | UI route / action | CLI | REST | MCP | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Review one opportunity (`humanReviewStatus`, rating, notes) | `[resource]` `reviewOpportunity` | — | `opportunity` update (fields only) | `opportunity_update` (fields only) | partial | Field update is exposed, but it skips `updateOpportunityReview()`'s audit/decision side effects. Tranche (c): `opportunity_review` tool. |
| Bulk review | `[resource]` `bulkReviewOpportunities`; DataSurface `review` | — | `/api/admin/opportunities/bulk-actions/*` | — | partial | REST-only by policy (bulk mutations preview-then-apply on the DataSurface adapter, see `apps/site/AGENTS.md`). Record as REST-only; CLI reaches it with raw HTTP. |
| Accept opportunity to apply | `[resource]` `acceptOpportunity` | — | `/api/job-search/record-decision`, `/open-application` | `job_search_open_application` (canonical) | partial | UI also asserts `task.sync`; tranche (c) aligns the capability set and bridges the tool into the legacy catalog for the CLI. |
| Triage deck window | `[resource]` `triageQueue` | — | `/api/job-search/next-triage-candidate` | — | partial | Single-candidate read vs. deck window; acceptable. Tranche (c) bridges to CLI. |
| Dig deeper (maybe + intelligence) | `[resource]` `digDeeper` | — | `/api/job-search/dig-deeper` | — | partial | Missing on MCP catalogs and CLI; tranche (c). |
| Verify posting (preflight) | `[resource]` `verifyPosting` | — | `/api/job-search/verify-posting` | — | partial | Tranche (c) bridge. |
| Inactive-source sweep (preview / apply) | `[resource]` `previewInactiveOpportunitySweep` / `applyInactiveOpportunitySweep` | — | `/api/job-search/sweep` | — | partial | Tranche (c) bridge. |
| Opportunity details panel | `[resource]` `loadOpportunityDetails` | — | `/api/job-search/inspect` | `job_search_inspect_opportunity` (canonical) | partial | Tranche (c) bridge for CLI. |
| Process opportunity with LLM (assessment) | `[resource]` `processOpportunityWithLlm` / `processOpportunity`; DataSurface `process-with-llm`; `POST /api/admin/opportunities/[id]/screening-questions` | — | bulk action + screening-questions route | `refresh_my_matches` (different scope) | partial | Single-opportunity assessment has no tool; tranche (c): `opportunity_assess`. |
| Create draft application | `[resource]` `createDraftApplication` | — | `/api/job-search/open-application` | `job_search_open_application` | partial | Tranche (c) bridge for CLI. |
| Create fact intake / accept fact candidate | `[resource]` `createFactIntake` / `acceptFactCandidate` | — | — | — | missing | Tranche (c): `fact_intake_create`, `fact_candidate_accept`. |
| Sync / process recommendation tasks | `[resource]` `syncRecommendationTasks` / `processRecommendationTask` | — | — | — | missing | Tranche (c). |
| Crawl source now | `[resource]` `crawlSourceNow` | — | `/api/job-search/crawl-source` | — | partial | Tranche (c) bridge; UI action currently has no capability assertion (REST asserts the full set). |
| Research company | `[id]` `researchCompany` | — | — | — | missing | Tranche (c): `company_research_request` on `ensureCompanyResearch()`. |
| Create root source | `/admin/sources/new` `create` | crud (`sources create`) | `/api/sources`, `/api/job-search/create-source` | `source_create` | exposed | |
| Set source active / source health / crawl status | (list page toggles) | mcp (health, crawl status) | `/api/job-search/*` | `job_search_list_source_health`, `job_search_source_crawl_status` | exposed | `set-source-active` is `source_update` on the generic surfaces. |
| URL intake (paste a posting or careers URL) | `POST /api/admin/url-intake` (admin shell) | — | `/api/admin/url-intake`, `/api/job-search/import` | — | partial | Tranche (c) bridge of `job_search_import_opportunity`. |
| Application review: add comments / request tweaks / review material | `/admin/applications/[id]` `addComments`, `requestTweaks`, `reviewMaterial` | — | — | — | missing | Tranche (c): `application_material_*` tools on `application-review.ts`. |
| Application review: generate packet | `/admin/applications/[id]` `generatePacket` | — | — | — | missing | Tranche (c): `application_generate_packet` (AI budget guard shared). |
| Application review: archive | `/admin/applications/[id]` `archiveApplication` | — | — | — | missing | Tranche (c). |
| Application review: provide form answers / revoke reusable answer | `/admin/applications/[id]` `provideAnswers`, `revokeReusableAnswer` | — | — | — | missing | Tranche (c). |
| Application review: report submission blocker | `/admin/applications/[id]` `reportBlocker` | — | — | — | missing | Tranche (c). |
| Application review: final approval | `/admin/applications/[id]` `approveFinal` | — | refused | refused | UI-only | Policy: final submission approval is recorded only from the authenticated review page (`docs/employment-workflows.md`, `mcp-apps-test-matrix.md`); both generic paths reject it. `iolaus_open_human_review` hands agents the page. |
| Application review: record submission | `/admin/applications/[id]` `recordSubmission` | — | refused | refused | UI-only | Same policy as final approval. |
| Résumé generate / regenerate / publish asset | `/admin/resume` `generate`, `regenerate`, `publish` | — | — | — | missing | Tranche (c): `resume_asset_generate` / `_regenerate` / `_publish` on `resume-admin.ts`. |
| Skill discovery (discover / confirm / dismiss) | `/admin/resume/skill-discovery` | — | — | — | missing | Tranche (c). |
| Skill experience map | `/admin/preferences/screening-questions` `saveSkillExperience` | — | — | — | missing | Tranche (c), or covered by a scoped `CandidateProfile` facts update. |
| Onboarding save | `/admin/onboarding` `save` | — | — | — | partial | Profile fields become `candidateprofile_update` in tranche (a); the orchestration (reusable answers, résumé selection, work-eligibility validation) stays UI-only until tranche (c) decides on an `onboarding_save` tool. |
| Shortlist manage | `/shortlist` page via `/api/shortlist*` | — | `/api/shortlist`, `/api/shortlist/import` | — | partial | Public-search feature; tranche (c) decides. |
| Private matches | (no UI) | — | `/api/public/v1/me/matches` | `match_my_profile`, `refresh_my_matches` | tool-only | |
| Read published résumé structure | (no UI) | — | `/api/job-search/read-resume` | — | tool-only | |
| Inspect application materials | (review page load) | — | `/api/job-search/inspect-application` | `job_search_inspect_application` | tool-only | |
| Workspace activity feed | admin shell | — | `/api/admin/activity` | — | partial | Read-only; REST suffices. |
| Admin assistant chat | `/admin` assistant panel | — | `/api/admin/assistant/*` | — | UI-only | A chat UI over the agent surfaces, not a capability of its own. |

## E. Account and operator functions (tranche d)

| Capability | UI route / action | CLI | REST | MCP | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Account export | `/admin/account` link | — | `GET /api/admin/account/export` | — | partial | REST download suffices; `iolaus` has no file-download command. Record as REST-only. |
| Account deletion | `/admin/account` `delete` | — | — | — | UI-only | The route rejects terminal sessions on purpose and requires typed confirmation from a browser cookie session (`account-deletion.ts`). |
| Terminal (device-code) login approval | `/admin/terminal-login` `approve` | — | — | — | UI-only | The browser session is the second factor that approves a CLI token. |
| OAuth grant revoke | `/account/connections` `revoke` | — | — | — | UI-only | Session-bound consent management. |
| Local first-run owner claim | `/setup` | — | — | — | UI-only | Pre-authentication bootstrap. |

## Summary

| Status | Rows |
| --- | --- |
| exposed | 12 |
| partial | 17 |
| missing | 40 |
| UI-only (reason recorded) | 9 |
| tool-only | 3 |

Missing rows by tranche: (a) 16 (career model, public-profile lifecycle),
(b) 13 (private workspace CRUD, tag lookup, tailoring configs),
(c) 11 (workflow tools without any agent surface). The 17 `partial` rows are
mostly one gap: the sixteen `job_search_*` workflow tools are not in the
legacy `/api/mcp/call` catalog, so the CLI cannot call them; bridging them
there (with their existing `jobSearchToolContracts` schemas and
`executeAsOwnerTool` permission sets) closes most of column `CLI` in one
change.

## Tranche plan

- (a) #259 — opt the career model into `api`/`cli`/`mcp` with scoped CRUD
  on the generic paths; add `public_profile_prepare|publish|unpublish|status`
  to the legacy MCP catalog and the canonical server; admin-write side
  effects on agent writes.
- (b) — private workspace CRUD (section C), tag lookup, tailoring configs.
- (c) — one owner-principal tool per remaining form action, built on the
  page's service function; bridge `job_search_*` into the legacy catalog.
- (d) — section E stays UI-only; document in `docs/configuration.md` if an
  operator script is wanted instead.
