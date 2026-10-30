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
through `NORMALIZED_RESUME_READ_PLAN`. Since #259 the generic surfaces reach
them through `scoped-resource-crud.ts`: the same owner predicate as
`admin-data.ts`, a hosted owner allowed without operator authority, the admin
write side effect on every agent write, server-assigned identity (`id`,
`slug`, `context` refused in payloads so no natural key can adopt a foreign
row), the generated MCP tools routed around `MCPGenerator`'s caller-supplied
`where`, and MCP authorization through `workflow.profile.manage` rather than
per-class CRUD grants the hosted member role does not hold. The UI edits them through the generic
`[resource]` pages, `/admin/career` (`save`, `visibility`),
`/admin/resume` (`updateProfile`, `updateExperience`, `updateEducation`,
`setDefaultProfile`) and `/admin/candidate-profile-links` (`save`). Admin
writes invalidate the published-résumé cache and queue the canonical refresh
(`admin-data.ts` `queueResumeRefreshAfterSourceWrite`,
`career-management.ts`); the same side effect must run for agent writes.

| Capability | UI route / action | CLI | REST | MCP | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| CandidateProfile read/update (identity, contacts, summary, assistant notes and contact email, `useOnResume`) | `/admin/candidate-profiles`, `/admin/career` `save` (profile), `/admin/resume` `updateProfile`, `/admin/onboarding` `save` | crud (list/get/update) | `/api/candidateprofiles` | `candidateprofile_list/get/update` | exposed | #259. Scoped to the verified owner's own profile; agent writes accept only the career-editor allow-list (`agent-field-contract.ts`). `setDefaultProfile` / `active` stay on the résumé page (single-default invariant); onboarding creates. |
| CandidateProfileLink CRUD | `/admin/candidate-profile-links` `save`, `/admin/career` `save` (links) | crud | `/api/candidateprofilelinks` | `candidateprofilelink_*` | exposed | #259. |
| Experience CRUD | `/admin/experience`, `/admin/career` `save`, `/admin/resume` `updateExperience` | crud | `/api/experiences` | `experience_*` | exposed | #259. |
| ExperienceRole / ExperienceCompany CRUD | `/admin/experience-roles`, `/admin/experience-companies` | crud | `/api/experienceroles`, `/api/experiencecompanies` | `experiencerole_*`, `experiencecompany_*` | exposed | #259. `companyId` references the shared `Company` catalog. |
| EmploymentRole / EmploymentRoleTag CRUD | `/admin/roles`, `/admin/role-tags` | crud | `/api/employmentroles`, `/api/employmentroletags` | `employmentrole_*`, `employmentroletag_*` | exposed | #259. |
| Project / ProjectTag / ProjectAttachment CRUD | `/admin/projects`, `/admin/project-tags`, `/admin/project-attachments`; `/admin/experience/[id]/edit` `createRelatedProject` / `updateRelatedProject` | crud | `/api/projects`, `/api/projecttags`, `/api/projectattachments` | `project_*`, `projecttag_*`, `projectattachment_*` | exposed | #259. |
| Duty / DutyTag CRUD | `/admin/duties`, `/admin/duty-tags` | crud | `/api/duties`, `/api/dutytags` | `duty_*`, `dutytag_*` | exposed | #259. |
| Achievement / AchievementTag / AchievementAttachment CRUD | `/admin/achievements`, `/admin/achievement-tags`, `/admin/achievement-attachments`; `/admin/experience/[id]/edit` `createRelatedProjectBullet` / `updateRelatedProjectBullet` | crud | `/api/achievements`, `/api/achievementtags`, `/api/achievementattachments` | `achievement_*`, `achievementtag_*`, `achievementattachment_*` | exposed | #259. |
| Education / EducationTag CRUD | `/admin/education`, `/admin/education-tags`, `/admin/resume` `updateEducation` | crud | `/api/educations`, `/api/educationtags` | `education_*`, `educationtag_*` | exposed | #259. |
| SkillCategory / SkillCategoryMember / SkillGroup / SkillGroupMember CRUD | `/admin/skill-categories`, `/admin/skills`, `/admin/skill-groups`, `/admin/skill-group-members` | crud | `/api/skillcategories`, `/api/skillcategorymembers`, `/api/skillgroups`, `/api/skillgroupmembers` | `skillcategory_*`, `skillcategorymember_*`, `skillgroup_*`, `skillgroupmember_*` | exposed | #259. `SkillGroup.evidenceJson` follows the JSON field contract. |
| Attachment CRUD (file metadata) | `/admin/attachments` | crud | `/api/attachments` | `attachment_*` | exposed | #259, metadata only; the upload path stays on the admin route. |
| Résumé visibility toggles (`useOnResume`) | `/admin/career` `visibility` | crud (update) | `update` on the classes above | `<class>_update` | exposed | #259: `useOnResume` is a writable field on every class above. |
| Public profile: prepare preview | `/admin/career/public-profile` `prepare` | mcp | `POST /api/mcp/call` | `public_profile_prepare` (legacy + canonical) | exposed | #259. Same `preparePublicProfile()`; 20-per-48 h limit and artifact checks shared. Listed only where public profiles are enabled. |
| Public profile: publish prepared revision | `/admin/career/public-profile` `publish` | mcp | `POST /api/mcp/call` | `public_profile_publish` | exposed | #259. `{ revisionId, expectedRevision }`; stale revision is 409. |
| Public profile: unpublish | `/admin/career/public-profile` `unpublish` | mcp | `POST /api/mcp/call` | `public_profile_unpublish` | exposed | #259. |
| Public profile: status / pending preview | `/admin/career/public-profile` load, `preview/[id]` | mcp | `POST /api/mcp/call` | `public_profile_status` | exposed | #259 on `getPublicProfileManager()`; the preview PDF bytes stay on the admin route (`previewUrl` is returned). |
| Legacy `Resume*` classes (`ResumeProfile`, `ResumePosition`, `ResumeAchievement`, `ResumeSkill*`, `ResumeEducation`, `ResumeLink`, `ResumeOtherRole`) | (read fallback only; no dedicated admin page) | — | — | — | UI-only | Legacy read-only fallback (`LEGACY_RESUME_READ_PLAN`) slated for removal; agents write the normalized model. |
| ResumeTailoringConfig CRUD | `/admin/resume-tailoring-configs` | crud | `/api/resumetailoringconfigs` | `resumetailoringconfig_*` | exposed | #262. |
| Tag vocabulary lookup (`Tag` from smrt-tags, needed for every `*Tag.tagId`) | combo pickers on the tag pages | mcp | `POST /api/mcp/call` | `tag_lookup` (legacy + canonical) | exposed | #262: bounded read-only lookup (name/slug substring, ≤100 results) under `workflow.profile.manage`; the vocabulary itself stays off generated CRUD. |
| Résumé import (upload, review, apply, retry) | `/admin/career/import`, `POST /api/admin/resume-import*` | — | `/api/admin/resume-import*` | — | partial | REST only, by design of the multipart upload + reviewed-proposal flow; tranche (c) decides whether an MCP `resume_import_*` wrapper is worth it. |

## C. Private workspace model (tranche b)

The UI edits these through the generic `[resource]` pages with owner
scoping. They left the agent surfaces in #138; #262 re-exposes them through
the same owner-scoped path as the career model, keeping each class's bespoke
guards (application concurrency commit and approval/submission guards, résumé
variant reservation and approval sync, application-owned asset immutability,
assessment projection refresh after a preference change). MCP authorization
is `workflow.profile.manage`; system-authored records are list/get only.

| Capability | UI route / action | CLI | REST | MCP | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Application CRUD | `/admin/applications` create/update/delete | crud | `/api/applications` | `application_list/get/create/update` | exposed | #262. Owner-scoped; the existing guards (`assertApplicationCreatePayload`, `commitApplicationIfCurrent`, no final approval / submission / `materialWriteLock` through generic writes) run on the scoped path. MCP omits `delete`. |
| ApplicationMaterialComment CRUD | `/admin/application-material-comments` | crud | `/api/applicationmaterialcomments` | `applicationmaterialcomment_*` | exposed | #262. |
| Task CRUD | `/admin/tasks`, `/admin/tasks/new` | crud | `/api/tasks` | `task_*` | exposed | #262. |
| Decision / DecisionTag CRUD | `/admin/decisions`, `/admin/decision-tags` | crud | `/api/decisions`, `/api/decisiontags` | `decision_*`, `decisiontag_*` | exposed | #262. |
| PreferenceRule CRUD (screening questions, preferences) | `/admin/preferences`, `/admin/preferences/screening-questions` `save` / `delete` | crud | `/api/preferencerules` | `preferencerule_*` | exposed | #262. Every agent write refreshes the owner's assessment projections, as the admin page does. The screening-question page's optimistic `expectedRevision` stays a page concern. |
| ResumeAsset list/get/update/delete | `/admin/resume-assets` | crud (no create) | `/api/resumeassets` | `resumeasset_list/get/update` | exposed | #262. Application-owned assets stay immutable; generation stays with the résumé workflow (tranche c). |
| ResumeVariant CRUD | `/admin/resume-variants` | crud | `/api/resumevariants` | `resumevariant_list/get/create/update` | exposed | #262. Write reservation and approval sync run on the scoped path; MCP omits `delete`. |
| CandidateAnswer (reusable answers) | `/admin/onboarding` `revokeReusableAnswer`, application `provideAnswers` / `revokeReusableAnswer` | — | — | — | UI-only | Privacy surface by design (`candidate-answers.spec.ts`): no admin CRUD page either; answers are saved and revoked only inside onboarding and the application review flows. A revoke tool is tranche (c) if wanted. |
| FactIntake / FactCandidate | `/admin/fact-intakes`, `/admin/fact-candidates` | crud (list/get) | `/api/factintakes`, `/api/factcandidates` | `factintake_list/get`, `factcandidate_list/get` | exposed | #262, read-only; writes go through the intake tools in D. |
| EvaluationScore / OpportunityAssessment read | `/admin/evaluation-scores`, assessment panels | crud (list/get) | `/api/evaluationscores`, `/api/opportunityassessments` | `evaluationscore_list/get`, `opportunityassessment_list/get` | exposed | #262, read-only (system-authored). |
| AgentRun read | `/admin/agent-runs` | crud (list/get) | `/api/agentruns` | `agentrun_list/get` | exposed | #262, read-only; writes refused everywhere. |
| MatchModel, RequirementEvidenceDecision, OpportunityRecommendationRank | (no admin page) | — | — | — | UI-only | Internal matching state with no UI editor; `match_my_profile` / `refresh_my_matches` are the agent interface. |

## D. Workflow actions

| Capability | UI route / action | CLI | REST | MCP | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Review one opportunity (`humanReviewStatus`, rating, notes) | `[resource]` `reviewOpportunity` | mcp | `POST /api/mcp/call` | `opportunity_review` | exposed | #263: same `updateOpportunityReview()` (immutable Decision revision + audit) under `workflow.application.review`. |
| Bulk review | `[resource]` `bulkReviewOpportunities`; DataSurface `review` | — | `/api/admin/opportunities/bulk-actions/*` | — | partial | REST-only by policy (bulk mutations preview-then-apply on the DataSurface adapter, see `apps/site/AGENTS.md`). Record as REST-only; CLI reaches it with raw HTTP. |
| Accept opportunity to apply | `[resource]` `acceptOpportunity` | mcp | `/api/job-search/record-decision`, `/open-application` | `job_search_record_decision`, `job_search_open_application` (legacy bridge + canonical) | exposed | #263: bridged with the route's own permission sets. The UI's `acceptOpportunity` additionally asserts `task.sync`; the job-search tools keep their curated sets (recorded difference, same service). |
| Triage deck window | `[resource]` `triageQueue` | mcp | `/api/job-search/next-triage-candidate` | `job_search_next_triage_candidate` | exposed | #263 bridge; single-candidate read serves the deck window one card at a time. |
| Dig deeper (maybe + intelligence) | `[resource]` `digDeeper` | mcp | `/api/job-search/dig-deeper` | `job_search_dig_deeper` | exposed | #263 bridge. |
| Verify posting (preflight) | `[resource]` `verifyPosting` | mcp | `/api/job-search/verify-posting` | `job_search_verify_posting` | exposed | #263 bridge. |
| Inactive-source sweep (preview / apply) | `[resource]` `previewInactiveOpportunitySweep` / `applyInactiveOpportunitySweep` | mcp | `/api/job-search/sweep` | `job_search_sweep_opportunities` | exposed | #263 bridge (dry run by default). |
| Opportunity details panel | `[resource]` `loadOpportunityDetails` | mcp | `/api/job-search/inspect` | `job_search_inspect_opportunity` (legacy bridge + canonical) | exposed | #263 bridge. |
| Process opportunity with LLM (assessment) | `[resource]` `processOpportunityWithLlm` / `processOpportunity`; DataSurface `process-with-llm`; `POST /api/admin/opportunities/[id]/screening-questions` | mcp | `POST /api/mcp/call`; bulk action + screening-questions route | `opportunity_assess` | exposed | #263: same `enqueueOpportunityIntelligenceWithStatus(id, { modes: 'assessment' })` under `workflow.assessment.execute`. |
| Create draft application | `[resource]` `createDraftApplication` | mcp | `/api/job-search/open-application` | `job_search_open_application` | exposed | #263 bridge. |
| Create fact intake / accept fact candidate | `[resource]` `createFactIntake` / `acceptFactCandidate` | mcp | `POST /api/mcp/call` | `fact_intake_create`, `fact_candidate_accept` | exposed | #263 under `workflow.profile.manage`. |
| Sync / process recommendation tasks | `[resource]` `syncRecommendationTasks` / `processRecommendationTask` | mcp | `POST /api/mcp/call` | `recommendation_tasks_sync`, `recommendation_task_process` | exposed | #263; `accept_to_apply` additionally asserts `workflow.application.prepare`, as the page does. |
| Crawl source now | `[resource]` `crawlSourceNow` | mcp | `/api/job-search/crawl-source` | `job_search_crawl_source` | exposed | #263 bridge with the route's full operator set. The UI action itself still has no capability assertion (recorded; operator-only in hosted mode by resource policy). |
| Research company | `[id]` `researchCompany` | mcp | `POST /api/mcp/call` | `company_research_request` | exposed | #263 on `ensureCompanyResearch()` under `companyResearchOperations` (`companies.read/update`, `sources.read/create`, `workflow.application.review`, `workflow.task.sync`): it writes the shared company status and careers source, so a hosted non-operator cannot run it, while the page action writes the same records under the session only (recorded gap on the page side). |
| Create root source | `/admin/sources/new` `create` | crud (`sources create`) | `/api/sources`, `/api/job-search/create-source` | `source_create` | exposed | |
| Set source active / source health / crawl status | (list page toggles) | mcp | `/api/job-search/*` | `job_search_set_source_active`, `job_search_list_source_health`, `job_search_source_crawl_status` | exposed | #263 bridges `set-source-active` too. |
| URL intake (paste a posting or careers URL) | `POST /api/admin/url-intake` (admin shell) | mcp | `/api/admin/url-intake`, `/api/job-search/import` | `job_search_import_opportunity`, `job_search_create_source` | exposed | #263 bridge; the admin URL-intake route's auto-classification stays REST-only (it is a composition of the two tools). |
| Application review: add comments / request tweaks / review material | `/admin/applications/[id]` `addComments`, `requestTweaks`, `reviewMaterial` | — | — | — | missing | Tranche (c2), issue #265: form-shaped service inputs (FormData parsers in the page actions) need their own argument contracts: `application_material_*` tools on `application-review.ts`. |
| Application review: generate packet | `/admin/applications/[id]` `generatePacket` | — | — | — | missing | Tranche (c2), issue #265: form-shaped service inputs (FormData parsers in the page actions) need their own argument contracts: `application_generate_packet` (AI budget guard shared). |
| Application review: archive | `/admin/applications/[id]` `archiveApplication` | mcp | `POST /api/mcp/call` | `application_archive` | exposed | #263 under `workflow.application.review` + `workflow.task.sync`. |
| Application review: provide form answers / revoke reusable answer | `/admin/applications/[id]` `provideAnswers`, `revokeReusableAnswer` | — | — | — | missing | Tranche (c2), issue #265: form-shaped service inputs (FormData parsers in the page actions) need their own argument contracts. |
| Application review: report submission blocker | `/admin/applications/[id]` `reportBlocker` | — | — | — | missing | Tranche (c2), issue #265: form-shaped service inputs (FormData parsers in the page actions) need their own argument contracts. |
| Application review: final approval | `/admin/applications/[id]` `approveFinal` | — | refused | refused | UI-only | Policy: final submission approval is recorded only from the authenticated review page (`docs/employment-workflows.md`, `mcp-apps-test-matrix.md`); both generic paths reject it. `iolaus_open_human_review` hands agents the page. |
| Application review: record submission | `/admin/applications/[id]` `recordSubmission` | — | refused | refused | UI-only | Same policy as final approval. |
| Résumé generate / regenerate / publish asset | `/admin/resume` `generate`, `regenerate`, `publish` | — | — | — | missing | Tranche (c2), issue #265: form-shaped service inputs (FormData parsers in the page actions) need their own argument contracts: `resume_asset_generate` / `_regenerate` / `_publish` on `resume-admin.ts`. |
| Skill discovery (discover / confirm / dismiss) | `/admin/resume/skill-discovery` | — | — | — | missing | Tranche (c2), issue #265: form-shaped service inputs (FormData parsers in the page actions) need their own argument contracts. |
| Skill experience map | `/admin/preferences/screening-questions` `saveSkillExperience` | — | — | — | missing | Tranche (c2), issue #265: form-shaped service inputs (FormData parsers in the page actions) need their own argument contracts, or covered by a scoped `CandidateProfile` facts update. |
| Onboarding save | `/admin/onboarding` `save` | — | — | — | partial | Profile fields become `candidateprofile_update` in tranche (a); the orchestration (reusable answers, résumé selection, work-eligibility validation) stays UI-only until tranche (c) decides on an `onboarding_save` tool. |
| Shortlist manage | `/shortlist` page via `/api/shortlist*` | — | `/api/shortlist`, `/api/shortlist/import` | — | partial | Public-search feature; tranche (c) decides. |
| Private matches | (no UI) | — | `/api/public/v1/me/matches` | `match_my_profile`, `refresh_my_matches` (canonical) | tool-only | |
| Read published résumé structure | (no UI) | mcp | `/api/job-search/read-resume` | `job_search_read_resume` | tool-only | #263 bridge. |
| Inspect application materials | (review page load) | mcp | `/api/job-search/inspect-application` | `job_search_inspect_application` | tool-only | #263 bridge. |
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
| exposed | 55 |
| partial | 6 |
| missing | 7 |
| UI-only (reason recorded) | 10 |
| tool-only | 3 |

Missing rows: 7, all tranche (c2) (#265): the form-shaped admin actions
(application review materials, packet generation, answers, blockers, résumé
asset generation, skill discovery, skill experience map). The 6 `partial`
rows are REST-only by policy or acceptable as recorded (bulk DataSurface
actions, résumé import, shortlist, activity feed, account export, onboarding
orchestration).

## Tranche plan

- (a) #259 — opt the career model into `api`/`cli`/`mcp` with scoped CRUD
  on the generic paths; add `public_profile_prepare|publish|unpublish|status`
  to the legacy MCP catalog and the canonical server; admin-write side
  effects on agent writes.
- (b) #262 — private workspace CRUD (section C) on the same scoped path, `tag_lookup`, tailoring configs.
- (c) #263 — `job_search_*` bridged into the legacy catalog (CLI reach) and
  eight owner-principal tools for the plain-argument form actions.
- (c2) #265 — the form-shaped actions (application review materials,
  packet generation, answers, blockers, résumé asset generation, skill
  discovery, skill experience, onboarding): each page parses `FormData`
  into a service-specific shape, so each tool needs its own argument
  contract and test.
- (d) — section E stays UI-only; document in `docs/configuration.md` if an
  operator script is wanted instead.
