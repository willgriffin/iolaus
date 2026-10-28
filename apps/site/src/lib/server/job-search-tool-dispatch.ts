import type { User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { jobSearchToolContracts } from '$lib/job-search-tool-schemas';
import { inspectJobApplication } from './application-inspect-webmcp.js';
import type { JobSearchToolName } from './job-search-tool-operations.js';
import {
  browseJobOpportunities,
  digDeeperOnJobOpportunity,
  importJobOpportunity,
  inspectJobOpportunity,
  nextJobTriageCandidate,
  openJobApplication,
  recordJobOpportunityDecision,
  sweepJobOpportunities,
  verifyJobPosting,
} from './job-search-webmcp.js';
import type { OwnerPrincipalLocals } from './owner-principal.js';
import type { WorkspaceSubject } from './private-workspace.js';
import { readJobSearchResume } from './resume-webmcp.js';
import {
  createRootSourceFromWebMcp,
  enqueueRootSourceCrawl,
  listRootSourceHealth,
  listSourceCrawlStatus,
  setRootSourceActive,
} from './source-webmcp.js';
import {
  type ToolArgumentSource,
  type ToolArgumentValidation,
  validateToolArguments,
} from './tool-arguments.js';
import { workspaceSubjectFromLocals } from './workspace-subject.js';

/**
 * One handler table for the `job_search_*` tools. The `/api/job-search` route
 * and the legacy MCP bridge both validate the arguments against the published
 * `inputSchema`, assert `jobSearchToolOperations[tool]` inside the owner
 * principal, and then call this. The private tools take their workspace
 * subject from the hook-verified locals only; the arguments never name it.
 */

export interface JobSearchToolContext {
  locals: OwnerPrincipalLocals;
  user: Pick<User, 'id'>;
}

function privateWorkspaceSubject(
  locals: OwnerPrincipalLocals,
): WorkspaceSubject {
  const subject = workspaceSubjectFromLocals(locals);
  if (!subject.profileId) error(403, 'A candidate profile is required.');
  return { ...subject, profileId: subject.profileId };
}

export function validateJobSearchToolArguments(
  tool: JobSearchToolName,
  input: Record<string, unknown>,
  source: ToolArgumentSource,
): ToolArgumentValidation {
  return validateToolArguments(
    tool,
    jobSearchToolContracts[tool].inputSchema,
    input,
    source,
  );
}

export async function executeJobSearchTool(
  tool: JobSearchToolName,
  input: Record<string, unknown>,
  context: JobSearchToolContext,
): Promise<unknown> {
  const { locals, user } = context;
  switch (tool) {
    case 'job_search_browse_opportunities':
      return await browseJobOpportunities(
        input,
        privateWorkspaceSubject(locals),
      );
    case 'job_search_next_triage_candidate':
      return await nextJobTriageCandidate(
        input,
        privateWorkspaceSubject(locals),
      );
    case 'job_search_inspect_opportunity':
      return await inspectJobOpportunity(
        input,
        privateWorkspaceSubject(locals),
      );
    case 'job_search_inspect_application':
      return await inspectJobApplication(input);
    case 'job_search_read_resume':
      return await readJobSearchResume(input);
    case 'job_search_list_source_health':
      return await listRootSourceHealth(input);
    case 'job_search_source_crawl_status':
      return await listSourceCrawlStatus(input);
    case 'job_search_create_source':
      return await createRootSourceFromWebMcp(input, user);
    case 'job_search_set_source_active':
      return await setRootSourceActive(input, user);
    case 'job_search_crawl_source':
      return await enqueueRootSourceCrawl(input, user);
    case 'job_search_verify_posting':
      return await verifyJobPosting(input, user);
    case 'job_search_sweep_opportunities':
      return await sweepJobOpportunities(input, user);
    case 'job_search_import_opportunity':
      return await importJobOpportunity(input, user);
    case 'job_search_dig_deeper':
      return await digDeeperOnJobOpportunity(
        input,
        user,
        privateWorkspaceSubject(locals),
      );
    case 'job_search_record_decision':
      return await recordJobOpportunityDecision(
        input,
        user,
        privateWorkspaceSubject(locals),
      );
    case 'job_search_open_application':
      return await openJobApplication(
        input,
        user,
        privateWorkspaceSubject(locals),
      );
    default: {
      const unreachable: never = tool;
      throw new Error(`Unknown job-search tool: ${String(unreachable)}`);
    }
  }
}
