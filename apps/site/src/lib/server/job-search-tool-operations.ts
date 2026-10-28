import type { MCPTool } from '@happyvertical/smrt-core/generators/mcp';
import { jobSearchToolContracts } from '../job-search-tool-schemas.js';
import { jobSearchWebMcpToolDefinitions } from '../webmcp.js';
import {
  type WorkspaceWorkflowCapability,
  workspaceWorkflowOperation,
} from './workspace-workflow-capabilities.js';

/**
 * The `job_search_*` workflow tools' authorization contract, shared by the
 * `/api/job-search/<action>` route (browser WebMCP + REST) and the legacy
 * `/api/mcp/call` bridge (the `iolaus mcp` commands). One table, so a tool
 * asserts the same generated and curated permissions on every surface. This
 * module has no dependency on the principal seam or the services, so the MCP
 * catalog can load it.
 */

export interface JobSearchRequiredOperation {
  action: 'create' | 'delete' | 'read' | 'update' | WorkspaceWorkflowCapability;
  collection:
    | 'companies'
    | 'opportunities'
    | 'sourcecrawls'
    | 'sourcecrawlitems'
    | 'sources'
    | 'workflow';
}

export type JobSearchToolName = keyof typeof jobSearchToolContracts;

const contextReadOperations = [
  { action: 'read', collection: 'companies' },
  { action: 'read', collection: 'opportunities' },
] satisfies JobSearchRequiredOperation[];

const inspectReadOperations = [
  ...contextReadOperations,
  workspaceWorkflowOperation('application.inspect'),
] satisfies JobSearchRequiredOperation[];

const sourceReadOperations = [
  { action: 'read', collection: 'sources' },
  { action: 'read', collection: 'sourcecrawls' },
] satisfies JobSearchRequiredOperation[];

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
] satisfies JobSearchRequiredOperation[];

export const jobSearchToolOperations: Record<
  JobSearchToolName,
  readonly JobSearchRequiredOperation[]
> = {
  job_search_browse_opportunities: inspectReadOperations,
  job_search_crawl_source: crawlSourceOperations,
  job_search_create_source: [
    workspaceWorkflowOperation('audit.record'),
    { action: 'create', collection: 'sources' },
  ],
  job_search_dig_deeper: [
    ...contextReadOperations,
    workspaceWorkflowOperation('application.review'),
  ],
  job_search_import_opportunity: [
    ...contextReadOperations,
    workspaceWorkflowOperation('audit.record'),
    { action: 'create', collection: 'opportunities' },
    { action: 'update', collection: 'opportunities' },
  ],
  job_search_inspect_application: [
    workspaceWorkflowOperation('application.inspect'),
  ],
  job_search_inspect_opportunity: inspectReadOperations,
  job_search_list_source_health: sourceReadOperations,
  job_search_next_triage_candidate: inspectReadOperations,
  job_search_open_application: [
    ...contextReadOperations,
    workspaceWorkflowOperation('application.prepare'),
  ],
  // Resume material is private profile data, never generic collection CRUD.
  job_search_read_resume: [workspaceWorkflowOperation('profile.manage')],
  job_search_record_decision: [
    ...contextReadOperations,
    workspaceWorkflowOperation('application.review'),
  ],
  job_search_set_source_active: [
    workspaceWorkflowOperation('audit.record'),
    { action: 'read', collection: 'sources' },
    { action: 'update', collection: 'sources' },
  ],
  job_search_source_crawl_status: sourceReadOperations,
  job_search_sweep_opportunities: [
    { action: 'read', collection: 'opportunities' },
    { action: 'update', collection: 'opportunities' },
    { action: 'read', collection: 'sources' },
    workspaceWorkflowOperation('audit.record'),
  ],
  job_search_verify_posting: [
    { action: 'read', collection: 'opportunities' },
    workspaceWorkflowOperation('audit.record'),
  ],
};

export const jobSearchToolNames = Object.keys(
  jobSearchToolOperations,
) as JobSearchToolName[];

export function isJobSearchToolName(name: string): name is JobSearchToolName {
  return Object.hasOwn(jobSearchToolOperations, name);
}

/**
 * The job-search tools as legacy-bridge MCP tools: the WebMCP description and
 * the published input schema, verbatim. The two bounded source reads already
 * carry their own hand-written catalog entries in `mcp-tools.ts` and are left
 * out here.
 */
export const jobSearchBridgeMcpToolNames = jobSearchToolNames.filter(
  (name) =>
    name !== 'job_search_list_source_health' &&
    name !== 'job_search_source_crawl_status',
);

export function jobSearchBridgeMcpTools(): MCPTool[] {
  const descriptions = new Map(
    jobSearchWebMcpToolDefinitions.map((definition) => [
      definition.name,
      definition.description,
    ]),
  );
  return jobSearchBridgeMcpToolNames.map((name) => ({
    description: descriptions.get(name) ?? name,
    inputSchema: jobSearchToolContracts[name]
      .inputSchema as MCPTool['inputSchema'],
    name,
    outputSchema: { additionalProperties: true, type: 'object' },
  }));
}

export function isJobSearchBridgeMcpTool(name: string): boolean {
  return (jobSearchBridgeMcpToolNames as string[]).includes(name);
}
