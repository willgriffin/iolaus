import { error, json, type RequestHandler } from '@sveltejs/kit';
import { jobSearchToolContracts } from '$lib/job-search-tool-schemas';
import { inspectJobApplication } from '$lib/server/application-inspect-webmcp';
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
} from '$lib/server/job-search-webmcp';
import {
  isOwnerAuthorityDenial,
  type PrincipalRun,
  runAsOwner,
} from '$lib/server/owner-principal';
import type { WorkspaceSubject } from '$lib/server/private-workspace';
import { readJobSearchResume } from '$lib/server/resume-webmcp';
import {
  createRootSourceFromWebMcp,
  enqueueRootSourceCrawl,
  listRootSourceHealth,
  listSourceCrawlStatus,
  setRootSourceActive,
} from '$lib/server/source-webmcp';
import {
  type ToolArgumentSource,
  validateToolArguments,
} from '$lib/server/tool-arguments';
import { workspaceSubjectFromLocals } from '$lib/server/workspace-subject';
import {
  type WorkspaceWorkflowCapability,
  workspaceWorkflowOperation,
} from '$lib/server/workspace-workflow-capabilities';

function unauthorized(): Response {
  return json({ error: 'Unauthorized' }, { status: 401 });
}

function forbidden(): Response {
  return json({ error: 'Forbidden' }, { status: 403 });
}

interface RequiredOperation {
  action: 'create' | 'delete' | 'read' | 'update' | WorkspaceWorkflowCapability;
  collection:
    | 'companies'
    | 'opportunities'
    | 'sourcecrawls'
    | 'sourcecrawlitems'
    | 'sources'
    | 'workflow';
}

/** Shared posting metadata remains catalog-backed; personal projections do not. */
const contextReadOperations = [
  { action: 'read', collection: 'companies' },
  { action: 'read', collection: 'opportunities' },
] satisfies RequiredOperation[];

const workspaceInspectionOperations = [
  workspaceWorkflowOperation('application.inspect'),
] satisfies RequiredOperation[];

const sourceReadOperations = [
  { action: 'read', collection: 'sources' },
  { action: 'read', collection: 'sourcecrawls' },
] satisfies RequiredOperation[];

const inspectReadOperations = [
  ...contextReadOperations,
  ...workspaceInspectionOperations,
] satisfies RequiredOperation[];

/** Audit writes are private workflow facts, not public AgentRun CRUD. */
const verifyPostingOperations = [
  { action: 'read', collection: 'opportunities' },
  workspaceWorkflowOperation('audit.record'),
] satisfies RequiredOperation[];

const digDeeperOperations = [
  ...contextReadOperations,
  workspaceWorkflowOperation('application.review'),
] satisfies RequiredOperation[];

const sweepOpportunitiesOperations = [
  { action: 'read', collection: 'opportunities' },
  { action: 'update', collection: 'opportunities' },
  { action: 'read', collection: 'sources' },
  workspaceWorkflowOperation('audit.record'),
] satisfies RequiredOperation[];

const inspectApplicationOperations = [
  workspaceWorkflowOperation('application.inspect'),
] satisfies RequiredOperation[];

/** Resume material is private profile data, never generic collection CRUD. */
const readResumeOperations = [
  workspaceWorkflowOperation('profile.manage'),
] satisfies RequiredOperation[];

/** Provider crawl is an operator workflow; it never receives private CRUD. */
const crawlSourceOperations = [
  { action: 'read', collection: 'sources' },
  { action: 'create', collection: 'sources' },
  { action: 'update', collection: 'sources' },
  { action: 'read', collection: 'sourcecrawls' },
  { action: 'read', collection: 'sourcecrawlitems' },
  { action: 'read', collection: 'opportunities' },
  { action: 'create', collection: 'opportunities' },
  { action: 'update', collection: 'opportunities' },
  { action: 'read', collection: 'companies' },
  { action: 'create', collection: 'companies' },
  { action: 'update', collection: 'companies' },
  workspaceWorkflowOperation('audit.record'),
] satisfies RequiredOperation[];

/** Route action → the WebMCP tool name it executes. */
const toolNames = {
  browse: 'job_search_browse_opportunities',
  'create-source': 'job_search_create_source',
  'crawl-source': 'job_search_crawl_source',
  'dig-deeper': 'job_search_dig_deeper',
  import: 'job_search_import_opportunity',
  inspect: 'job_search_inspect_opportunity',
  'next-triage-candidate': 'job_search_next_triage_candidate',
  'inspect-application': 'job_search_inspect_application',
  'open-application': 'job_search_open_application',
  'read-resume': 'job_search_read_resume',
  'record-decision': 'job_search_record_decision',
  'set-source-active': 'job_search_set_source_active',
  'source-crawl-status': 'job_search_source_crawl_status',
  'source-health': 'job_search_list_source_health',
  sweep: 'job_search_sweep_opportunities',
  'verify-posting': 'job_search_verify_posting',
} as const;

type ToolAction = keyof typeof toolNames;

function isToolAction(action: string | undefined): action is ToolAction {
  return typeof action === 'string' && Object.hasOwn(toolNames, action);
}

/**
 * Execute one WebMCP tool as the signed-in owner. Every generated operation
 * the tool's curated response and workflow side effects need is asserted
 * against the principal's published permission snapshot before the handler
 * reads or mutates data.
 */
async function executeAsOwnerTool(
  locals: App.Locals,
  action: ToolAction,
  operations: RequiredOperation[],
  handler: (run: PrincipalRun) => Promise<unknown>,
): Promise<Response> {
  const tool = toolNames[action];
  try {
    const result = await runAsOwner(
      locals,
      async (run) => {
        run.assertToolAllowed(tool);
        for (const { action: operation, collection } of operations) {
          await run.assertOperation(collection, operation);
        }
        return await handler(run);
      },
      { action: `webmcp.${tool}`, auditMetadata: { tool } },
    );
    return json(result);
  } catch (cause) {
    if (isOwnerAuthorityDenial(cause)) return forbidden();
    throw cause;
  }
}

/**
 * Enforce the tool's published `inputSchema` before any handler runs, so a
 * wrong argument name or type is named precisely instead of surfacing as an
 * opaque `HTTP 400`. Runs only after authentication; authority denials keep
 * their non-descriptive bodies. Returns `undefined` when the arguments are
 * acceptable.
 */
function rejectInvalidArguments(
  action: ToolAction,
  input: Record<string, unknown>,
  source: ToolArgumentSource,
): Response | undefined {
  const tool = toolNames[action];
  const validation = validateToolArguments(
    tool,
    jobSearchToolContracts[tool].inputSchema,
    input,
    source,
  );
  if (validation.ok) return undefined;
  return json(
    { error: validation.error, details: validation.details },
    { status: 400 },
  );
}

function methodOf(action: ToolAction): 'GET' | 'POST' {
  return jobSearchToolContracts[toolNames[action]].method;
}

function unsupported(action: string, method: string): Response {
  return json(
    {
      error: `Unsupported job-search action: ${method} ${action || '(missing)'}`,
    },
    { status: 404 },
  );
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    error(400, 'Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    error(400, 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function privateWorkspaceSubject(locals: App.Locals): WorkspaceSubject {
  const subject = workspaceSubjectFromLocals(locals);
  if (!subject.profileId) error(403, 'A candidate profile is required.');
  return { ...subject, profileId: subject.profileId };
}

export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) return unauthorized();
  const input = Object.fromEntries(url.searchParams.entries());
  const action = params.action;
  if (!isToolAction(action) || methodOf(action) !== 'GET') {
    return unsupported(action ?? '', 'GET');
  }
  const rejection = rejectInvalidArguments(action, input, 'query');
  if (rejection) return rejection;
  if (action === 'browse') {
    return await executeAsOwnerTool(locals, action, inspectReadOperations, () =>
      browseJobOpportunities(input, privateWorkspaceSubject(locals)),
    );
  }
  if (action === 'next-triage-candidate') {
    return await executeAsOwnerTool(locals, action, inspectReadOperations, () =>
      nextJobTriageCandidate(input, privateWorkspaceSubject(locals)),
    );
  }
  if (action === 'inspect') {
    return await executeAsOwnerTool(locals, action, inspectReadOperations, () =>
      inspectJobOpportunity(input, privateWorkspaceSubject(locals)),
    );
  }
  if (action === 'inspect-application') {
    return await executeAsOwnerTool(
      locals,
      action,
      inspectApplicationOperations,
      () => inspectJobApplication(input),
    );
  }
  if (action === 'read-resume') {
    return await executeAsOwnerTool(locals, action, readResumeOperations, () =>
      readJobSearchResume(input),
    );
  }
  if (action === 'source-health') {
    return await executeAsOwnerTool(locals, action, sourceReadOperations, () =>
      listRootSourceHealth(input),
    );
  }
  if (action === 'source-crawl-status') {
    return await executeAsOwnerTool(locals, action, sourceReadOperations, () =>
      listSourceCrawlStatus(input),
    );
  }
  return unsupported(action, 'GET');
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const user = locals.user;
  if (!user) return unauthorized();
  const input = await jsonObject(request);
  const action = params.action;
  if (!isToolAction(action) || methodOf(action) !== 'POST') {
    return unsupported(action ?? '', 'POST');
  }
  const rejection = rejectInvalidArguments(action, input, 'body');
  if (rejection) return rejection;
  if (action === 'create-source') {
    return await executeAsOwnerTool(
      locals,
      action,
      [
        workspaceWorkflowOperation('audit.record'),
        { action: 'create', collection: 'sources' },
      ],
      () => createRootSourceFromWebMcp(input, user),
    );
  }
  if (action === 'set-source-active') {
    return await executeAsOwnerTool(
      locals,
      action,
      [
        workspaceWorkflowOperation('audit.record'),
        { action: 'read', collection: 'sources' },
        { action: 'update', collection: 'sources' },
      ],
      () => setRootSourceActive(input, user),
    );
  }
  if (action === 'crawl-source') {
    return await executeAsOwnerTool(locals, action, crawlSourceOperations, () =>
      enqueueRootSourceCrawl(input, user),
    );
  }
  if (action === 'verify-posting') {
    return await executeAsOwnerTool(
      locals,
      action,
      verifyPostingOperations,
      () => verifyJobPosting(input, user),
    );
  }
  if (action === 'sweep') {
    return await executeAsOwnerTool(
      locals,
      action,
      sweepOpportunitiesOperations,
      () => sweepJobOpportunities(input, user),
    );
  }
  if (action === 'import') {
    return await executeAsOwnerTool(
      locals,
      action,
      [
        ...contextReadOperations,
        workspaceWorkflowOperation('audit.record'),
        { action: 'create', collection: 'opportunities' },
        { action: 'delete', collection: 'opportunities' },
        { action: 'update', collection: 'opportunities' },
      ],
      () => importJobOpportunity(input, user),
    );
  }
  if (action === 'dig-deeper') {
    return await executeAsOwnerTool(locals, action, digDeeperOperations, () =>
      digDeeperOnJobOpportunity(input, user, privateWorkspaceSubject(locals)),
    );
  }
  if (action === 'record-decision') {
    return await executeAsOwnerTool(
      locals,
      action,
      [
        ...contextReadOperations,
        workspaceWorkflowOperation('application.review'),
      ],
      () =>
        recordJobOpportunityDecision(
          input,
          user,
          privateWorkspaceSubject(locals),
        ),
    );
  }
  if (action === 'open-application') {
    return await executeAsOwnerTool(
      locals,
      action,
      [
        ...contextReadOperations,
        workspaceWorkflowOperation('application.prepare'),
      ],
      () => openJobApplication(input, user, privateWorkspaceSubject(locals)),
    );
  }
  return unsupported(action, 'POST');
};
