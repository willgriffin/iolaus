import { error, json, type RequestHandler } from '@sveltejs/kit';
import { jobSearchToolContracts } from '$lib/job-search-tool-schemas';
import {
  executeJobSearchTool,
  validateJobSearchToolArguments,
} from '$lib/server/job-search-tool-dispatch';
import {
  type JobSearchToolName,
  jobSearchToolOperations,
} from '$lib/server/job-search-tool-operations';
import {
  isOwnerAuthorityDenial,
  runAsOwner,
} from '$lib/server/owner-principal';
import type { ToolArgumentSource } from '$lib/server/tool-arguments';

function unauthorized(): Response {
  return json({ error: 'Unauthorized' }, { status: 401 });
}

function forbidden(): Response {
  return json({ error: 'Forbidden' }, { status: 403 });
}

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
} as const satisfies Record<string, JobSearchToolName>;

type ToolAction = keyof typeof toolNames;

function isToolAction(action: string | undefined): action is ToolAction {
  return typeof action === 'string' && Object.hasOwn(toolNames, action);
}

/**
 * Execute one WebMCP tool as the signed-in owner. Every generated operation
 * the tool's curated response and workflow side effects need
 * (`jobSearchToolOperations`, shared with the legacy MCP bridge) is asserted
 * against the principal's published permission snapshot before the handler
 * reads or mutates data.
 */
async function executeAsOwnerTool(
  locals: App.Locals,
  action: ToolAction,
  input: Record<string, unknown>,
  user: NonNullable<App.Locals['user']>,
): Promise<Response> {
  const tool = toolNames[action];
  try {
    const result = await runAsOwner(
      locals,
      async (run) => {
        run.assertToolAllowed(tool);
        for (const { action: operation, collection } of jobSearchToolOperations[
          tool
        ]) {
          await run.assertOperation(collection, operation);
        }
        return await executeJobSearchTool(tool, input, { locals, user });
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
  const validation = validateJobSearchToolArguments(
    toolNames[action],
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

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const user = locals.user;
  if (!user) return unauthorized();
  const input = Object.fromEntries(url.searchParams.entries());
  const action = params.action;
  if (!isToolAction(action) || methodOf(action) !== 'GET') {
    return unsupported(action ?? '', 'GET');
  }
  const rejection = rejectInvalidArguments(action, input, 'query');
  if (rejection) return rejection;
  return await executeAsOwnerTool(locals, action, input, user);
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
  return await executeAsOwnerTool(locals, action, input, user);
};
