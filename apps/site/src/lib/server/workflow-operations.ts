/**
 * Generated `(collection, action)` permission sets for the workflow side
 * effects that run after an object write. The generated server-MCP mutation
 * tools (`mcp-tools.ts`) and the agent-drivable admin form actions
 * (`admin-resource-route.ts`) both assert these inside the owner principal
 * run, so a principal that may write the primary record but not the records
 * its workflow touches is refused before anything executes.
 *
 * Each set is derived by reading the helper it names; keep them in step with
 * the helper's collection reads and writes. This module has no imports so the
 * MCP catalog can load it without a cycle through the principal seam.
 */

/**
 * A generated CRUD action on a model collection, or a curated workspace
 * capability slug (`workflow.<capability>`, asserted as the action of the
 * `workflow` collection — see `workspace-workflow-capabilities.ts`).
 */
export type WorkflowOperationAction =
  | 'create'
  | 'delete'
  | 'read'
  | 'update'
  | `${string}.${string}`;

export interface WorkflowOperation {
  action: WorkflowOperationAction;
  collection: string;
}

/**
 * `createTaskIfMissing()` / `closeStale*Tasks()` / `markTask*()` in
 * `application-workflow.ts`: list tasks by external id or owner, create the
 * missing ones, and save closed, canceled, or blocked ones.
 */
/**
 * `recordAgentAudit()` (`application-workflow.ts`) and the helpers built on it
 * (`recordPostingPreflight()`, the WebMCP source and import audits) write an
 * `AgentRun` row. `AgentRun` is system-authored: the generated catalog exposes
 * it as api list/get only, so no `agentruns.create` permission exists. By
 * convention the audit write is instead authorized by the owner's right to
 * read the audit log — `(agentruns, read)` is the surrogate — and every
 * workflow operation set whose run can write an `AgentRun` must include it.
 */
export const agentRunAuditOperations = [
  { action: 'read', collection: 'agentruns' },
] as const satisfies readonly WorkflowOperation[];

/**
 * `requireFreshPostingPreflight()` / `runWithFreshPostingPreflight()`
 * (`posting-preflight.ts`, `application-workflow.ts`) and the WebMCP
 * `verify-posting` tool: re-read the opportunity and record the verdict (and
 * any owner override) as an `AgentRun`.
 */
export const postingPreflightOperations = [
  { action: 'read', collection: 'opportunities' },
  ...agentRunAuditOperations,
] as const satisfies readonly WorkflowOperation[];

/**
 * `updateOpportunityReview()` / `bulkUpdateOpportunityReviews()`
 * (`application-package.ts`) and `enqueueOpportunityIntelligence()`
 * (`opportunity-intelligence-job.ts`): read the opportunity (the review
 * returns the full record) before saving the review or queuing the job.
 */
export const opportunityReviewOperations = [
  { action: 'read', collection: 'opportunities' },
  { action: 'update', collection: 'opportunities' },
] as const satisfies readonly WorkflowOperation[];

/**
 * `sweepInactiveSourceOpportunities()` (`opportunity-sweep.ts`): reads the
 * sources joined to the matched opportunities, reads the applications and
 * owner decisions that mark a posting as already decided so the match can
 * exclude those rows, counts and samples the opportunities, batch-updates the
 * matched rows to the archived state, and records one `AgentRun` audit per
 * apply. The dry run performs only the reads, but the tool asserts the write
 * authority up front so a principal that may not archive is refused before it
 * sees any count.
 */
export const opportunitySweepOperations = [
  { action: 'read', collection: 'opportunities' },
  { action: 'update', collection: 'opportunities' },
  { action: 'read', collection: 'sources' },
  { action: 'read', collection: 'applications' },
  { action: 'read', collection: 'decisions' },
  ...agentRunAuditOperations,
] as const satisfies readonly WorkflowOperation[];

export const taskSyncOperations = [
  { action: 'read', collection: 'tasks' },
  { action: 'create', collection: 'tasks' },
  { action: 'update', collection: 'tasks' },
] as const satisfies readonly WorkflowOperation[];

/**
 * `digDeeperOnOpportunity()` (`opportunity-deep-dive.ts`), behind the triage
 * right-swipe and the `job_search_dig_deeper` tool. It reads the opportunity
 * and saves the `maybe` review (`opportunityReviewOperations`), queues the
 * intelligence job — which re-reads the opportunity; the `_smrt_jobs` queue
 * table has no generated permission, so the opportunity read authorizes the row
 * queued for it, exactly as the source update authorizes its schedule row —
 * runs one posting preflight (`postingPreflightOperations`), and calls
 * `ensureCompanyResearch()`: read and update the company, list/create/update its
 * `research_company` task, and look up or create its careers source.
 *
 * The whole set is asserted before anything runs, so a principal that may
 * record the verdict but not queue the follow-up is refused up front rather
 * than left with a half-executed deep dive.
 */
export const opportunityDigDeeperOperations = [
  ...opportunityReviewOperations,
  ...postingPreflightOperations,
  ...taskSyncOperations,
  { action: 'read', collection: 'companies' },
  { action: 'update', collection: 'companies' },
  { action: 'read', collection: 'sources' },
  { action: 'create', collection: 'sources' },
] as const satisfies readonly WorkflowOperation[];

/**
 * `ensureCompanyResearch()` (`application-workflow.ts`): reads and re-statuses
 * the shared `Company`, looks up or creates its careers `Source`, and lists,
 * creates or updates the owner's `research_company` task. The shared-catalog
 * writes assert their generated permissions (company update, careers source
 * read/create); the private task workflow asserts the curated capabilities
 * the admin actions assert for it (`application.review`, which authorizes
 * the deep dive that performs the same research, and `task.sync`), never a
 * generic private task CRUD grant.
 */
export const companyResearchOperations = [
  { action: 'read', collection: 'companies' },
  { action: 'update', collection: 'companies' },
  { action: 'read', collection: 'sources' },
  { action: 'create', collection: 'sources' },
  { action: 'application.review', collection: 'workflow' },
  { action: 'task.sync', collection: 'workflow' },
] as const satisfies readonly WorkflowOperation[];

/**
 * `syncApplicationWorkflowTasks()`: syncs the application's account and stage
 * tasks, and for a submitted application reads its opportunity and moves it
 * to `applied` (`syncSubmittedOpportunityStatus()`). The application record
 * itself is re-read before the sync runs.
 */
export const applicationWorkflowSyncOperations = [
  { action: 'read', collection: 'applications' },
  ...taskSyncOperations,
  { action: 'read', collection: 'opportunities' },
  { action: 'update', collection: 'opportunities' },
] as const satisfies readonly WorkflowOperation[];

/**
 * `syncRecommendedOpportunityDecisionTasks()`: lists recommended
 * opportunities (and re-reads each task's opportunity while closing stale
 * review tasks), then creates or cancels `review_recommendation` tasks.
 */
export const recommendedOpportunityTaskSyncOperations = [
  { action: 'read', collection: 'opportunities' },
  ...taskSyncOperations,
] as const satisfies readonly WorkflowOperation[];

/**
 * `syncSourceSchedule()` re-reads the source, writes its crawl schedule, and
 * saves `nextCheckAt` back onto the source; `syncSourceAccountTasks()` syncs
 * its `account_setup` tasks. The `_smrt_agent_schedules` table has no
 * generated permission; the source update authorizes its schedule row.
 */
export const sourceWorkflowSyncOperations = [
  { action: 'read', collection: 'sources' },
  { action: 'update', collection: 'sources' },
  ...taskSyncOperations,
] as const satisfies readonly WorkflowOperation[];

/**
 * `reserveResumeVariantApplicationWrite()` /
 * `releaseResumeVariantApplicationWrite()` /
 * `syncResumeVariantApplicationApprovals()`: list the applications that
 * selected the variant, fence-update their approval and material lock, and
 * run `syncApplicationWorkflowTasks()` for each.
 */
export const resumeVariantWorkflowSyncOperations = [
  { action: 'read', collection: 'applications' },
  { action: 'update', collection: 'applications' },
  ...applicationWorkflowSyncOperations,
] as const satisfies readonly WorkflowOperation[];

/**
 * Owner-scoped generic CRUD on a candidate-owned class
 * (`scoped-resource-crud.ts`): the generated `<class>_<action>` MCP tools for
 * the career model. The hosted member role holds the curated `workflow.*`
 * capabilities and catalog reads only — never generated private CRUD grants
 * (`role-permissions.ts`), and the admin pages that edit the same records
 * assert `workflow.profile.manage` (`career-management.ts`). The tools assert
 * that same capability; the owner predicate, not a per-class grant, bounds
 * what the write can reach.
 */
export const privateWorkspaceCrudOperations = [
  { action: 'profile.manage', collection: 'workflow' },
] as const satisfies readonly WorkflowOperation[];

/**
 * `preparePublicProfile()` / `publishPublicProfile()` /
 * `unpublishPublicProfile()` / `getPublicProfileManager()`
 * (`public-profile-service.ts`), behind the `/admin/career/public-profile`
 * form actions and the `public_profile_*` tools. The service asserts the
 * curated `workflow.public-profile.manage` capability at every fence and
 * reads the owner's candidate profiles and publication rows inside it; it
 * grants no generic CRUD, so the tools assert exactly what the page asserts.
 */
export const publicProfileWorkflowOperations = [
  { action: 'public-profile.manage', collection: 'workflow' },
] as const satisfies readonly WorkflowOperation[];

/**
 * Deduplicate `(collection, action)` pairs while preserving first-seen order.
 */
export function uniqueWorkflowOperations<T extends WorkflowOperation>(
  operations: readonly T[],
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const operation of operations) {
    const key = `${operation.collection}.${operation.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(operation);
  }
  return unique;
}
