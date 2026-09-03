import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  MCPGenerator,
  type MCPTool,
} from '@happyvertical/smrt-core/generators/mcp';
import {
  deriveOperationPermissionCollectionName,
  type User,
} from '@happyvertical/smrt-users';
import '../objects/index.js';
import {
  listMcpExposedResources,
  mcpToolPrefix,
  resolveMcpToolClass,
} from './api-exposure.js';
import { getDbConfig } from './db.js';
import {
  applicationWorkflowSyncOperations,
  recommendedOpportunityTaskSyncOperations,
  resumeVariantWorkflowSyncOperations,
  sourceWorkflowSyncOperations,
  uniqueWorkflowOperations,
  type WorkflowOperation,
} from './workflow-operations.js';

/**
 * Generated server-MCP tool catalog. This module deliberately has no
 * dependency on the principal seam so `owner-principal.ts` can derive its
 * fail-closed allow-list from it without an import cycle through `mcp.ts`.
 */

const publicToolEnv = 'SMRT_PUBLIC_MCP_TOOLS';
const sourceReadToolNames = new Set([
  'job_search_list_source_health',
  'job_search_source_crawl_status',
]);

export type McpOperationAction = 'create' | 'delete' | 'read' | 'update';

export type McpToolOperation = WorkflowOperation;

const sourceReadOperations: readonly McpToolOperation[] = [
  { action: 'read', collection: 'sources' },
  { action: 'read', collection: 'sourcecrawls' },
];

const generatedToolActions: Record<string, McpOperationAction> = {
  create: 'create',
  delete: 'delete',
  get: 'read',
  list: 'read',
  update: 'update',
};

/**
 * Workflow side effects `callMcpTool()` runs around a generated mutation, per
 * exposed class and action, as the extra `(collection, action)` permissions
 * the principal must hold besides the primary write. Derived from
 * `executeMcpTool()` / `assertMcpWorkflowPayload()` /
 * `syncMcpWorkflowSideEffects()` in `mcp.ts` and the helpers they call; the
 * SmrtObject classes themselves declare no save or delete hooks, so a class
 * absent here has only its primary operation.
 */
const generatedToolSideEffects: Record<
  string,
  Partial<Record<McpOperationAction, readonly McpToolOperation[]>>
> = {
  // `currentApplicationRecord()` and the post-write re-read, then
  // `syncApplicationWorkflowTasks()`.
  Application: {
    create: applicationWorkflowSyncOperations,
    update: applicationWorkflowSyncOperations,
  },
  // `syncRecommendedOpportunityDecisionTasks()` after every write.
  Opportunity: {
    create: recommendedOpportunityTaskSyncOperations,
    update: recommendedOpportunityTaskSyncOperations,
  },
  // `assertMcpResumeAssetWriteAllowed()` reads the asset before an update or
  // delete to refuse application-owned materials.
  ResumeAsset: {
    delete: [{ action: 'read', collection: 'resumeassets' }],
    update: [{ action: 'read', collection: 'resumeassets' }],
  },
  // `resumeVariantWriteViolation()`, the write reservation/release, and
  // `syncResumeVariantApplicationApprovals()`.
  ResumeVariant: {
    create: resumeVariantWorkflowSyncOperations,
    update: resumeVariantWorkflowSyncOperations,
  },
  // Re-read, `syncSourceSchedule()`, and `syncSourceAccountTasks()`.
  Source: {
    create: sourceWorkflowSyncOperations,
    update: sourceWorkflowSyncOperations,
  },
};

export const sourceReadMcpTools = [
  {
    description:
      'List explicitly classified root sources and rank persisted provider health from bounded durable terminal crawl accounting. Credentials and posting-derived sources are excluded.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: {
        historyLimit: {
          default: 10,
          maximum: 20,
          minimum: 1,
          type: 'integer',
        },
        limit: { default: 10, maximum: 25, minimum: 1, type: 'integer' },
        query: { maxLength: 120, type: 'string' },
      },
      type: 'object',
    },
    name: 'job_search_list_source_health',
    outputSchema: { additionalProperties: true, type: 'object' },
  },
  {
    description:
      'Inspect one crawl or a bounded recent set for one explicit root source. Returns durable counts and at most five sanitized error samples per crawl.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: {
        crawlId: {
          description: 'Explicit crawl identifier',
          format: 'uuid',
          type: 'string',
        },
        limit: { default: 10, maximum: 20, minimum: 1, type: 'integer' },
        sourceId: {
          description: 'Explicit local root-source identifier',
          format: 'uuid',
          type: 'string',
        },
      },
      anyOf: [{ required: ['crawlId'] }, { required: ['sourceId'] }],
      type: 'object',
    },
    name: 'job_search_source_crawl_status',
    outputSchema: { additionalProperties: true, type: 'object' },
  },
] satisfies MCPTool[];

export function createGenerator(user?: Pick<User, 'id'> | null): MCPGenerator {
  return new MCPGenerator(
    {
      description:
        'SMRT MCP server for iolaus.localhost employment-search data.',
      name: 'iolaus-employment-search',
      version: '0.1.0',
    },
    {
      db: getDbConfig(),
      user: user?.id ? { id: user.id } : undefined,
    },
  );
}

/**
 * A generated tool is allowed when its class opts into MCP through its
 * `@smrt({ mcp })` include. `MCPGenerator` already honours the per-action
 * include list, so a class-level check is enough here.
 */
function isAllowedCoreTool(toolName: string): boolean {
  return listMcpExposedResources().some((resource) =>
    toolName.startsWith(mcpToolPrefix(resource.className)),
  );
}

export function isSourceReadMcpTool(toolName: string): boolean {
  return sourceReadToolNames.has(toolName);
}

export function configuredPublicMcpToolPatterns(): string[] {
  return (process.env[publicToolEnv] ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

export function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return true;

  const parts = pattern.split('*');
  if (parts.length === 1) return toolName === pattern;

  let cursor = 0;
  if (parts[0] && !toolName.startsWith(parts[0])) return false;
  for (const part of parts) {
    if (!part) continue;
    const index = toolName.indexOf(part, cursor);
    if (index < 0) return false;
    cursor = index + part.length;
  }

  const last = parts.at(-1);
  return !last || toolName.endsWith(last);
}

export function isReadOnlyMcpTool(toolName: string): boolean {
  return toolName.endsWith('_list') || toolName.endsWith('_get');
}

export function isPublicMcpTool(toolName: string): boolean {
  return (
    isReadOnlyMcpTool(toolName) &&
    configuredPublicMcpToolPatterns().some((pattern) =>
      matchesToolPattern(toolName, pattern),
    )
  );
}

export async function listMcpTools(options: {
  authenticated: boolean;
}): Promise<MCPTool[]> {
  const tools = await createGenerator().generateTools();
  const allowedTools = tools.filter((tool) => isAllowedCoreTool(tool.name));

  if (options.authenticated) {
    return [...allowedTools, ...sourceReadMcpTools].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  return allowedTools.filter((tool) => isPublicMcpTool(tool.name));
}

/**
 * Resolve every generated model operation an MCP tool performs, expressed as
 * `(collection, action)` pairs for `PrincipalRun.assertOperation`: the
 * primary operation of a generated `<class>_<action>` tool plus the workflow
 * side effects `callMcpTool()` runs around that write. Returns `null` for a
 * tool with no known operation mapping so callers fail closed.
 */
export function mcpToolOperations(
  toolName: string,
): readonly McpToolOperation[] | null {
  if (isSourceReadMcpTool(toolName)) return sourceReadOperations;

  const resource = resolveMcpToolClass(toolName);
  if (!resource) return null;
  const action =
    generatedToolActions[
      toolName.slice(mcpToolPrefix(resource.className).length)
    ];
  if (!action) return null;
  const modelClass =
    ObjectRegistry.getObjectMetadata(resource.className)?.constructor ?? null;
  if (!modelClass) return null;
  const collection = deriveOperationPermissionCollectionName(modelClass);
  return uniqueWorkflowOperations([
    { action, collection },
    ...(generatedToolSideEffects[resource.className]?.[action] ?? []),
  ]);
}
