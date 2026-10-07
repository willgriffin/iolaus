import {
  createMcpAppServer,
  McpAccessError,
  type McpAppPrincipal,
  type McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import {
  openAiDisplayMetadata,
  withOpenAiEntrypoints,
} from '@happyvertical/smrt-mcp-openai';
import workspaceCss from '$lib/components/mcp-apps/generated/iolaus-opportunity-workspace.css?raw';
import workspaceScript from '$lib/components/mcp-apps/generated/iolaus-opportunity-workspace.iife.js?raw';
import { jobSearchToolContracts } from '$lib/job-search-tool-schemas';
import {
  publicFacetsSchema,
  publicOpportunityDetailSchema,
  publicSearchInputSchema,
  publicSearchPageSchema,
} from '$lib/public-opportunity-contract.js';
import { administrativeSessionFailure } from './administrative-auth.js';
import { getConfiguredMcpServerName } from './app-config.js';
import { inspectJobApplication } from './application-inspect-webmcp.js';
import {
  browseJobOpportunities,
  inspectJobOpportunity,
  openJobApplication,
} from './job-search-webmcp.js';
import {
  getMyOpportunityMatches,
  refreshOpportunityMatches,
} from './opportunity-matching.js';
import { runAsOwner } from './owner-principal.js';
import {
  getPublicOpportunity,
  listPublicFacets,
  searchPublicOpportunities,
} from './public-search/index.js';
import { getRequestScopedSmrtOptions } from './smrt.js';
import {
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from './workspace-subject.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

/** Static resource only: data is returned by authorized tool calls. */
export const IOLAUS_MCP_APP_RESOURCE = 'ui://iolaus/v1/workspace.html';

function trustedMcpAppOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '[::1]';
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function safeInlineScript(value: string): string {
  return value.replace(/<\/script/giu, '<\\/script');
}

const browserConfiguration = JSON.stringify({
  hostOrigin: trustedMcpAppOrigin(process.env.IOLAUS_MCP_HOST_ORIGIN),
  iolausOrigin: trustedMcpAppOrigin(process.env.IOLAUS_PUBLIC_URL),
}).replace(/</gu, '\\u003c');

/**
 * Prebuilt browser resource: its bundle has no principal, session, candidate,
 * or credential data. Every changing value arrives through authorized tools.
 */
const workspaceHtml = `<!doctype html><html lang="en"><head><title>Iolaus workspace</title><style>${workspaceCss}</style></head><body><script>window.__IOLAUS_MCP_APP_CONFIG__=${browserConfiguration};</script><script>${safeInlineScript(workspaceScript)}</script></body></html>`;

type IolausMcpPrincipal = McpAppPrincipal & {
  permissions?: readonly string[];
  /** Minted only from the server-verified workspace subject. */
  profileId?: string;
};

const outputSchema = {
  additionalProperties: true,
  type: 'object' as const,
};

const PUBLIC_MCP_TOOL_NAMES = new Set([
  'get_opportunity',
  'list_facets',
  'search_opportunities',
]);

const publicSearchInputJsonSchema = {
  additionalProperties: false,
  properties: {
    company: { maxLength: 120, type: 'string' },
    country: {
      items: { maxLength: 80, type: 'string' },
      maxItems: 12,
      type: 'array',
    },
    cursor: { maxLength: 1000, type: 'string' },
    employmentType: {
      items: { maxLength: 80, type: 'string' },
      maxItems: 12,
      type: 'array',
    },
    function: {
      items: { maxLength: 80, type: 'string' },
      maxItems: 12,
      type: 'array',
    },
    limit: { maximum: 50, minimum: 1, type: 'integer' },
    q: { maxLength: 200, type: 'string' },
    salaryMin: { minimum: 0, type: 'number' },
    seniority: {
      items: { maxLength: 80, type: 'string' },
      maxItems: 12,
      type: 'array',
    },
    skills: {
      items: { maxLength: 80, type: 'string' },
      maxItems: 12,
      type: 'array',
    },
    sort: { enum: ['relevance', 'newest', 'salary'], type: 'string' },
    workMode: {
      items: { maxLength: 80, type: 'string' },
      maxItems: 12,
      type: 'array',
    },
  },
  type: 'object' as const,
};

function jsonResult(data: Record<string, unknown>) {
  return {
    content: [{ text: JSON.stringify(data), type: 'text' as const }],
    structuredContent: data,
  };
}

function parsePublicSearchInput(input: unknown) {
  try {
    return publicSearchInputSchema.parse(input);
  } catch {
    throw new McpAccessError(400, 'Invalid public search arguments.');
  }
}

const publicSearchWorkflow: McpWorkflowToolDefinition = {
  description:
    'Search the shared public opportunity catalog. It never reads a profile, workspace, application, or private evidence.',
  effect: 'read',
  execute: async ({ arguments: input }) =>
    jsonResult(
      publicSearchPageSchema.parse(
        await searchPublicOpportunities(parsePublicSearchInput(input)),
      ),
    ),
  idempotent: true,
  inputSchema: publicSearchInputJsonSchema,
  name: 'search_opportunities',
  openWorld: true,
  outputSchema,
  title: 'Search public opportunities',
};

const publicOpportunityWorkflow: McpWorkflowToolDefinition = {
  description:
    'Read one allowlisted public opportunity summary and its original posting link. It never returns a raw posting or workspace data.',
  effect: 'read',
  execute: async ({ arguments: input }) => {
    const id =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>).id
        : null;
    if (typeof id !== 'string' || id.length > 128) {
      throw new McpAccessError(
        400,
        'A valid public opportunity ID is required.',
      );
    }
    const opportunity = await getPublicOpportunity(id);
    if (!opportunity) throw new McpAccessError(404, 'Opportunity not found.');
    return jsonResult(publicOpportunityDetailSchema.parse(opportunity));
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: { id: { maxLength: 128, minLength: 1, type: 'string' } },
    required: ['id'],
    type: 'object',
  },
  name: 'get_opportunity',
  openWorld: true,
  outputSchema,
  title: 'Get public opportunity',
};

const publicFacetsWorkflow: McpWorkflowToolDefinition = {
  description:
    'List bounded filter facets for the shared public opportunity catalog. It does not access linked-account or workspace data.',
  effect: 'read',
  execute: async ({ arguments: input }) =>
    jsonResult(
      publicFacetsSchema.parse(
        await listPublicFacets(parsePublicSearchInput(input)),
      ),
    ),
  idempotent: true,
  inputSchema: publicSearchInputJsonSchema,
  name: 'list_facets',
  openWorld: true,
  outputSchema,
  title: 'List public opportunity facets',
};

function matchLimit(input: Record<string, unknown>): number | undefined {
  const value = input.limit;
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 25
  ) {
    throw new McpAccessError(
      400,
      'Match limit must be an integer from 1 to 25.',
    );
  }
  return value;
}

const privateMatchInputSchema = {
  additionalProperties: false,
  properties: { limit: { maximum: 25, minimum: 1, type: 'integer' } },
  type: 'object' as const,
};

const privateMatchesWorkflow: McpWorkflowToolDefinition = {
  description:
    'Read the signed-in owner’s private opportunity matches. It rechecks the live workspace subject and never accepts an owner, profile, or tenant argument.',
  effect: 'read',
  execute: async ({ arguments: input, principal }) =>
    jsonResult(
      await runOwnerWorkflow({
        execute: async (owner) => ({
          items: await getMyOpportunityMatches(
            workspaceSubjectForOwner(owner),
            {
              limit: matchLimit(input),
            },
          ),
        }),
        operations: [workspaceWorkflowOperation('application.inspect')],
        principal,
        profileRequired: true,
        tool: 'match_my_profile',
      }),
    ),
  idempotent: true,
  inputSchema: privateMatchInputSchema,
  name: 'match_my_profile',
  openWorld: false,
  outputSchema,
  title: 'Read my opportunity matches',
};

const refreshPrivateMatchesWorkflow: McpWorkflowToolDefinition = {
  description:
    'Refresh the signed-in owner’s bounded private opportunity matches without approving or submitting an application.',
  effect: 'write',
  execute: async ({ arguments: input, principal }) =>
    jsonResult(
      await runOwnerWorkflow({
        execute: async (owner) =>
          await refreshOpportunityMatches(workspaceSubjectForOwner(owner), {
            limit: matchLimit(input),
          }),
        operations: [workspaceWorkflowOperation('application.inspect')],
        principal,
        profileRequired: true,
        tool: 'refresh_my_matches',
      }),
    ),
  idempotent: false,
  inputSchema: privateMatchInputSchema,
  name: 'refresh_my_matches',
  openWorld: false,
  outputSchema,
  title: 'Refresh my opportunity matches',
};

function asOwnerPrincipal(
  principal: McpAppPrincipal | null,
  profileRequired = false,
): Required<Pick<IolausMcpPrincipal, 'id' | 'tenantId'>> &
  Pick<IolausMcpPrincipal, 'permissions' | 'profileId'> {
  const candidate = principal as IolausMcpPrincipal | null;
  const id = candidate?.id?.trim();
  const tenantId = candidate?.tenantId?.trim();
  const profileId = candidate?.profileId?.trim();
  const permissions = candidate?.permissions ?? [];
  if (!id || !tenantId || permissions.length === 0) {
    throw new McpAccessError(401, 'Authentication is required.');
  }
  if (profileRequired && !profileId) {
    throw new McpAccessError(403, 'A verified candidate profile is required.');
  }
  return { id, permissions, profileId, tenantId };
}

async function runOwnerWorkflow<T>(options: {
  principal: McpAppPrincipal | null;
  tool: string;
  operations: readonly { action: string; collection: string }[];
  profileRequired?: boolean;
  execute: (owner: {
    id: string;
    profileId?: string;
    tenantId: string;
  }) => Promise<T>;
}): Promise<T> {
  const owner = asOwnerPrincipal(options.principal, options.profileRequired);
  return await runAsOwner(
    {
      permissions: owner.permissions,
      tenantId: owner.tenantId,
      user: { id: owner.id },
    },
    async (run) => {
      // These names are shared with the authenticated WebMCP catalog, so the
      // owner allow-list remains derived in tool-catalog.ts.
      run.assertToolAllowed(options.tool);
      for (const operation of options.operations) {
        await run.assertOperation(operation.collection, operation.action);
      }
      // The native principal establishes a fresh tenant context. Revalidate
      // the request-minted profile and bind its subject inside that context
      // before private services read it; tool arguments never supply scope.
      return await withVerifiedWorkspaceSubject(
        workspaceSubjectForOwner(owner),
        async () =>
          await options.execute({
            id: owner.id,
            profileId: owner.profileId,
            tenantId: owner.tenantId,
          }),
      );
    },
    {
      action: `mcp-apps.${options.tool}`,
      auditMetadata: { tool: options.tool },
    },
  );
}

/** Build private workflow scope only from the principal minted by request auth. */
function workspaceSubjectForOwner(owner: {
  id: string;
  profileId?: string;
  tenantId: string;
}) {
  if (!owner.profileId) {
    throw new McpAccessError(403, 'A verified candidate profile is required.');
  }
  return {
    profileId: owner.profileId,
    tenantId: owner.tenantId,
    userId: owner.id,
  };
}

function reviewApplicationId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300) {
    throw new McpAccessError(400, 'A dedicated review URL is required.');
  }
  let url: URL;
  try {
    url = new URL(value, 'https://iolaus.invalid');
  } catch {
    throw new McpAccessError(400, 'A dedicated review URL is required.');
  }
  if (url.origin !== 'https://iolaus.invalid' || url.search || url.hash) {
    throw new McpAccessError(400, 'A dedicated review URL is required.');
  }
  const segments = url.pathname.split('/');
  if (
    segments.length !== 5 ||
    segments[1] !== 'admin' ||
    segments[2] !== 'applications' ||
    segments[4] !== 'review' ||
    !segments[3] ||
    /%2f|%5c/iu.test(segments[3])
  ) {
    throw new McpAccessError(400, 'A dedicated review URL is required.');
  }
  let id: string;
  try {
    id = decodeURIComponent(segments[3]);
  } catch {
    throw new McpAccessError(400, 'A dedicated review URL is required.');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
    throw new McpAccessError(400, 'A dedicated review URL is required.');
  }
  return id;
}

const browseWorkflow: McpWorkflowToolDefinition = {
  description:
    'Browse the signed-in owner’s local Iolaus opportunity board. Results remain available as structured content when no embedded UI is supported.',
  effect: 'read',
  execute: async ({ arguments: input, principal }) =>
    jsonResult(
      await runOwnerWorkflow({
        execute: async (owner) =>
          await browseJobOpportunities(input, workspaceSubjectForOwner(owner)),
        // The posting catalog is global, while the board projects this
        // subject's application and assessment state alongside it.
        operations: [workspaceWorkflowOperation('application.inspect')],
        principal,
        profileRequired: true,
        tool: 'job_search_browse_opportunities',
      }),
    ),
  idempotent: true,
  inputSchema:
    jobSearchToolContracts.job_search_browse_opportunities.inputSchema,
  name: 'job_search_browse_opportunities',
  openWorld: false,
  outputSchema,
  title: 'Browse opportunities',
  ui: { resourceUri: IOLAUS_MCP_APP_RESOURCE, visibility: ['app', 'model'] },
};

// OpenAI entrypoints must accept exactly `{}`. The regular browse tool keeps
// its filters, while this entrypoint selects the same bounded default board.
const opportunityBoardEntrypoint = withOpenAiEntrypoints(
  {
    ...browseWorkflow,
    inputSchema: {
      additionalProperties: false,
      properties: {},
      type: 'object',
    },
    name: 'iolaus_open_opportunity_board',
    title: 'Open opportunity board',
  },
  ['global', 'thread'],
);

const inspectWorkflow: McpWorkflowToolDefinition = {
  description:
    'Inspect one local opportunity with bounded posting, fit, and application context. It does not contact an employer.',
  effect: 'read',
  execute: async ({ arguments: input, principal }) =>
    jsonResult(
      await runOwnerWorkflow({
        execute: async (owner) =>
          await inspectJobOpportunity(input, workspaceSubjectForOwner(owner)),
        operations: [workspaceWorkflowOperation('application.inspect')],
        principal,
        profileRequired: true,
        tool: 'job_search_inspect_opportunity',
      }),
    ),
  idempotent: true,
  inputSchema:
    jobSearchToolContracts.job_search_inspect_opportunity.inputSchema,
  name: 'job_search_inspect_opportunity',
  openWorld: false,
  outputSchema,
  title: 'Inspect opportunity',
  ui: { resourceUri: IOLAUS_MCP_APP_RESOURCE, visibility: ['app', 'model'] },
};

const prepareWorkflow: McpWorkflowToolDefinition = {
  description:
    'Create or reopen the signed-in owner’s local application workspace for an explicit opportunity. It never records final approval or submission.',
  effect: 'write',
  execute: async ({ arguments: input, principal }) =>
    jsonResult(
      await runOwnerWorkflow({
        execute: async (owner) =>
          await openJobApplication(
            input,
            owner,
            workspaceSubjectForOwner(owner),
          ),
        operations: [workspaceWorkflowOperation('application.prepare')],
        principal,
        profileRequired: true,
        tool: 'job_search_open_application',
      }),
    ),
  idempotent: false,
  inputSchema: jobSearchToolContracts.job_search_open_application.inputSchema,
  name: 'job_search_open_application',
  openWorld: true,
  outputSchema,
  title: 'Prepare application workspace',
  ui: { resourceUri: IOLAUS_MCP_APP_RESOURCE, visibility: ['app', 'model'] },
};

const inspectApplicationWorkflow: McpWorkflowToolDefinition = {
  description:
    'Inspect the signed-in owner’s local application materials and return the dedicated review URL. This read never grants approval or submission.',
  effect: 'read',
  execute: async ({ arguments: input, principal }) =>
    jsonResult(
      await runOwnerWorkflow({
        execute: async () => await inspectJobApplication(input),
        operations: [workspaceWorkflowOperation('application.inspect')],
        principal,
        profileRequired: true,
        tool: 'job_search_inspect_application',
      }),
    ),
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      applicationId: { format: 'uuid', type: 'string' },
    },
    required: ['applicationId'],
    type: 'object',
  },
  name: 'job_search_inspect_application',
  openWorld: false,
  outputSchema,
  title: 'Inspect application workspace',
  ui: { resourceUri: IOLAUS_MCP_APP_RESOURCE, visibility: ['app', 'model'] },
};

const reviewNavigationWorkflow: McpWorkflowToolDefinition = {
  description:
    'Resolve a dedicated Iolaus application-review destination after rechecking the current owner workspace. Opening this link does not approve or submit anything.',
  effect: 'read',
  execute: async ({ arguments: input, principal }) => {
    const applicationId = reviewApplicationId(input.url);
    const inspection = await runOwnerWorkflow({
      execute: async () => await inspectJobApplication({ applicationId }),
      operations: [workspaceWorkflowOperation('application.review')],
      principal,
      profileRequired: true,
      tool: 'job_search_inspect_application',
    });
    return jsonResult({
      applicationId,
      humanReviewUrl: inspection.application.reviewUrl,
      approval: inspection.approval,
      submission: inspection.submission,
    });
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: { url: { maxLength: 300, type: 'string' } },
    required: ['url'],
    type: 'object',
  },
  name: 'iolaus_open_human_review',
  openWorld: false,
  outputSchema,
  title: 'Open dedicated human review',
  ui: { resourceUri: IOLAUS_MCP_APP_RESOURCE, visibility: ['app'] },
};

function canUseIolausMcp(
  principal: McpAppPrincipal | null,
): principal is IolausMcpPrincipal {
  const candidate = principal as IolausMcpPrincipal | null;
  return Boolean(
    candidate?.id?.trim() &&
      candidate.tenantId?.trim() &&
      candidate.permissions?.length,
  );
}

/**
 * Canonical MCP Apps catalog. Generated REST MCP remains mounted at its
 * compatibility routes while its workflow guards are migrated one by one;
 * every workflow here re-enters the existing Iolaus owner-principal boundary.
 */
export const mcpAppServer = createMcpAppServer({
  allowedClassNames: [],
  publicToolPatterns: () => [...PUBLIC_MCP_TOOL_NAMES],
  resourcePolicy: ({ principal }) => canUseIolausMcp(principal),
  resources: [
    {
      html: workspaceHtml,
      metadata: openAiDisplayMetadata({
        availableDisplayModes: ['inline', 'fullscreen'],
        preferredDisplayMode: 'fullscreen',
      }),
      name: 'Iolaus opportunity workspace',
      uri: IOLAUS_MCP_APP_RESOURCE,
      version: 'v1',
    },
  ],
  serverInfo: {
    description: 'Private Iolaus opportunity and application workspace.',
    name: getConfiguredMcpServerName(),
    version: '0.1.0',
  },
  smrtOptions: () =>
    getRequestScopedSmrtOptions() as unknown as Record<string, unknown>,
  // Keep the anonymous surface exact. A null principal can discover and call
  // only the catalog tools declared above; it never makes generated CRUD,
  // private workflows, or the embedded resource public.
  toolPolicy: ({ principal, tool }) =>
    (principal == null && PUBLIC_MCP_TOOL_NAMES.has(tool.name)) ||
    canUseIolausMcp(principal),
  workflowTools: [
    publicSearchWorkflow,
    publicOpportunityWorkflow,
    publicFacetsWorkflow,
    privateMatchesWorkflow,
    refreshPrivateMatchesWorkflow,
    browseWorkflow,
    opportunityBoardEntrypoint,
    inspectWorkflow,
    prepareWorkflow,
    inspectApplicationWorkflow,
    reviewNavigationWorkflow,
  ],
});

export function resolveMcpAppPrincipal(
  locals: App.Locals,
): IolausMcpPrincipal | null {
  if (administrativeSessionFailure(locals) !== null) return null;
  // `workspaceSubject` is re-verified by the request hook from live
  // membership and server-owned profile state. Never admit actor identity
  // from a tool argument, browser selection, or a stale session snapshot.
  let subject;
  try {
    subject = workspaceSubjectFromLocals(locals);
  } catch {
    return null;
  }
  if (!locals.permissions?.length) return null;
  return {
    id: subject.userId,
    kind: 'human',
    permissions: locals.permissions,
    profileId: subject.profileId,
    tenantId: subject.tenantId,
  };
}
