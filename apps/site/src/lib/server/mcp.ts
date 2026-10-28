import type { MCPResponse } from '@happyvertical/smrt-core/generators/mcp';
import type { User } from '@happyvertical/smrt-users';
import { ZodError } from 'zod';
import {
  AgentFieldContractError,
  normalizeAgentWritablePayload,
} from '$lib/objects/agent-field-contract';
import {
  applicationApprovalScopeChanged,
  applicationApprovalShouldInvalidate,
  applicationMaterialsAreLockedOrLeased,
  applicationSubmissionRequiresDedicatedAction,
  clearApplicationApprovalFields,
  hasFinalApplicationApprovalMutation,
} from '$lib/objects/application-approval-scope';
import {
  applicationStatusRequiresApproval,
  normalizeApplicationStatus,
  toApplicationStatus,
  validateApplicationStatusTransition,
} from '$lib/objects/lifecycle';
import '../objects/index.js';
import { mcpToolPrefix, resolveMcpToolClass } from './api-exposure.js';
import {
  applicationUpdatesFromPayload,
  commitApplicationIfCurrent,
} from './application-concurrency.js';
import {
  normalizeAccountStatus,
  syncSourceAccountTasks,
  validateSubmittedApplicationPayload,
} from './application-workflow.js';
import {
  executeJobSearchTool,
  validateJobSearchToolArguments,
} from './job-search-tool-dispatch.js';
import type { JobSearchToolName } from './job-search-tool-operations.js';
import {
  createGenerator,
  isJobSearchBridgeMcpTool,
  isPublicMcpTool,
  isPublicProfileMcpTool,
  isReadOnlyMcpTool,
  isSourceReadMcpTool,
  isTagLookupMcpTool,
  isWorkflowToolName,
  listMcpTools,
  mcpToolOperations,
} from './mcp-tools.js';
import {
  isOwnerAuthorityDenial,
  type OwnerPrincipalLocals,
  runAsOwner,
} from './owner-principal.js';
import {
  getPublicProfileManager,
  type PublicProfileActorSource,
  preparePublicProfile,
  publishPublicProfile,
  unpublishPublicProfile,
} from './public-profile-service.js';
import { PublicProfileStoreError } from './public-profile-store.js';
import {
  PUBLIC_PROFILE_PREPARE_TOOL,
  PUBLIC_PROFILE_PUBLISH_TOOL,
  PUBLIC_PROFILE_STATUS_TOOL,
  PUBLIC_PROFILE_UNPUBLISH_TOOL,
} from './public-profile-tools.js';
import {
  releaseResumeVariantApplicationWrite,
  reserveResumeVariantApplicationWrite,
  resumeVariantWriteViolation,
  syncResumeVariantApplicationApprovals,
} from './resume-variant-workflow.js';
import {
  createScopedRecord,
  deleteScopedRecord,
  findOwnedRecord,
  getScopedRecord,
  isScopedResourceClass,
  listScopedRecords,
  runScopedWriteSideEffects,
  updateScopedRecord,
} from './scoped-resource-crud.js';
import { getCollection } from './smrt.js';
import { syncSourceSchedule } from './source-schedules.js';
import {
  listRootSourceHealth,
  listSourceCrawlStatus,
} from './source-webmcp.js';
import { lookupTags } from './tag-lookup-tool.js';
import {
  executeWorkflowTool,
  validateWorkflowToolArguments,
} from './workflow-tools.js';
import { requireCandidateWorkspaceSubject } from './workspace-resource-policy.js';
// Registers the curated `workflow.*` permission definitions the public-profile
// lifecycle tools assert; registration is process-scoped and idempotent.
import './workspace-workflow-capabilities.js';

export {
  configuredPublicMcpToolPatterns,
  isPublicMcpTool,
  listMcpTools,
  matchesToolPattern,
} from './mcp-tools.js';

export class McpAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpAccessError';
  }
}

function sourceMcpError(cause: unknown): never {
  const status =
    typeof (cause as { status?: unknown }).status === 'number'
      ? (cause as { status: number }).status
      : 500;
  const message =
    (cause as { body?: { message?: unknown } }).body?.message ??
    (cause instanceof Error ? cause.message : 'Source read failed.');
  if (status >= 400 && status < 600) {
    throw new McpAccessError(status, String(message));
  }
  throw cause;
}

async function callSourceReadMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<MCPResponse> {
  try {
    const structuredContent =
      name === 'job_search_list_source_health'
        ? await listRootSourceHealth(args)
        : await listSourceCrawlStatus(args);
    return {
      content: [{ text: JSON.stringify(structuredContent), type: 'text' }],
      structuredContent,
    };
  } catch (cause) {
    return sourceMcpError(cause);
  }
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type Saveable = { save?: () => Promise<unknown> };

function jsonResponse(structuredContent: Record<string, unknown>): MCPResponse {
  return {
    content: [{ text: JSON.stringify(structuredContent), type: 'text' }],
    structuredContent,
  };
}

/**
 * Translate a service failure (SvelteKit `error()`, zod input rejection, or a
 * publication store conflict) into the bridge's error contract, exactly as the
 * form action maps them for the browser.
 */
function publicProfileMcpError(cause: unknown): never {
  if (cause instanceof ZodError) {
    throw new McpAccessError(
      400,
      'Check the public profile arguments and try again.',
    );
  }
  if (cause instanceof PublicProfileStoreError) {
    const status =
      cause.code === 'conflict' || cause.code === 'handle_taken'
        ? 409
        : cause.code === 'limit'
          ? 429
          : cause.code === 'validation'
            ? 400
            : 404;
    throw new McpAccessError(status, cause.message);
  }
  if (isOwnerAuthorityDenial(cause)) throw cause;
  return sourceMcpError(cause);
}

/**
 * Run one public-profile lifecycle tool against the same service functions
 * the `/admin/career/public-profile` form actions call. Shared by the legacy
 * bridge (hook-verified locals) and the canonical MCP server (explicit
 * re-verified subject), so neither surface can bypass the preview step, the
 * preparation limit or the artifact checks.
 */
export async function callPublicProfileMcpTool(
  name: string,
  args: Record<string, unknown>,
  actor: PublicProfileActorSource,
): Promise<MCPResponse> {
  try {
    switch (name) {
      case PUBLIC_PROFILE_PREPARE_TOOL: {
        const prepared = await preparePublicProfile(actor, args);
        return jsonResponse({
          baseRevision: prepared.baseRevision,
          handle: prepared.handle,
          pdfBytes: prepared.pdfBytes,
          previewUrl: `/admin/career/public-profile/preview/${encodeURIComponent(prepared.id)}`,
          revisionId: prepared.id,
          snapshot: prepared.snapshot,
        });
      }
      case PUBLIC_PROFILE_PUBLISH_TOOL:
        return jsonResponse({
          published: true,
          ...(await publishPublicProfile(actor, args)),
        });
      case PUBLIC_PROFILE_UNPUBLISH_TOOL:
        return jsonResponse({
          unpublished: true,
          ...(await unpublishPublicProfile(actor, args)),
        });
      case PUBLIC_PROFILE_STATUS_TOOL:
        return jsonResponse(await getPublicProfileManager(actor));
      default:
        throw new McpAccessError(404, `Unknown MCP tool: ${name}`);
    }
  } catch (cause) {
    return publicProfileMcpError(cause);
  }
}

/**
 * Execute a generated `<class>_<action>` tool for a candidate-owned class
 * through the owner-scoped CRUD shared with `/api/[resource]`, never through
 * `MCPGenerator`, whose list honours a caller-supplied `where`.
 */
async function executeScopedMcpTool(
  className: string,
  action: string,
  args: Record<string, unknown>,
): Promise<MCPResponse> {
  const id = hasNonEmptyString(args.id) ? args.id.trim() : '';
  switch (action) {
    case 'list': {
      const page = await listScopedRecords(className, {
        limit: args.limit,
        offset: args.offset,
        orderBy: args.orderBy,
        where: args.where,
      });
      return jsonResponse({
        data: page.items,
        meta: {
          count: page.items.length,
          limit: page.limit,
          offset: page.offset,
          total: page.total,
        },
      });
    }
    case 'get': {
      if (!id) throw new McpAccessError(400, 'id is required.');
      const record = await getScopedRecord(className, id);
      if (!record) throw new McpAccessError(404, 'Object not found');
      return jsonResponse(record);
    }
    case 'create':
      return jsonResponse(await createScopedRecord(className, args));
    case 'update': {
      if (!id) throw new McpAccessError(400, 'ID is required for update');
      const { id: _ignored, ...payload } = args;
      return jsonResponse(await updateScopedRecord(className, id, payload));
    }
    case 'delete':
      if (!id) throw new McpAccessError(400, 'ID is required for delete');
      await deleteScopedRecord(className, id);
      return jsonResponse({
        message: 'Object deleted successfully',
        success: true,
      });
    default:
      throw new McpAccessError(404, `Unknown MCP action: ${action}`);
  }
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function submissionMethodFromApplyMethod(value: unknown): string {
  const applyMethod = typeof value === 'string' ? value.trim() : '';
  if (applyMethod === 'platform') return 'job_board';
  if (
    ['company_site', 'email', 'recruiter', 'referral', 'other'].includes(
      applyMethod,
    )
  ) {
    return applyMethod;
  }
  return '';
}

function normalizeMcpAccountStatus(value: unknown): string {
  try {
    return normalizeAccountStatus(value);
  } catch (cause) {
    const status =
      typeof (cause as { status?: unknown }).status === 'number'
        ? (cause as { status: number }).status
        : 400;
    const message =
      (cause as { body?: { message?: unknown } }).body?.message ??
      (cause instanceof Error ? cause.message : 'Invalid account status.');
    throw new McpAccessError(status, String(message));
  }
}

function normalizeMcpAgentPayload(
  toolName: string,
  args: Record<string, unknown>,
): void {
  const resource = resolveMcpToolClass(toolName);
  if (!resource) return;
  const { className } = resource;
  const action = toolName.slice(mcpToolPrefix(className).length);
  if (action !== 'create' && action !== 'update') return;

  try {
    normalizeAgentWritablePayload(className, args);
  } catch (cause) {
    if (cause instanceof AgentFieldContractError) {
      throw new McpAccessError(400, cause.message);
    }
    throw cause;
  }
}

export async function callMcpTool(options: {
  arguments?: unknown;
  /**
   * The hook-verified request locals. When present the principal runs under
   * the verified workspace subject, which the scoped generated tools and the
   * public-profile lifecycle tools require; otherwise it binds from the
   * user/tenant pair alone (sufficient for catalog tools).
   */
  locals?: OwnerPrincipalLocals;
  name: string;
  permissions?: App.Locals['permissions'];
  tenantId?: App.Locals['tenantId'];
  user?: Pick<User, 'id'> | null;
}): Promise<MCPResponse> {
  const tools = await listMcpTools({ authenticated: true });
  if (!tools.some((tool) => tool.name === options.name)) {
    throw new McpAccessError(404, `Unknown MCP tool: ${options.name}`);
  }

  if (!options.user && !isPublicMcpTool(options.name)) {
    throw new McpAccessError(
      401,
      `Authentication is required for MCP tool: ${options.name}`,
    );
  }

  const args = mcpToolArguments(options.arguments);
  if (!options.user) {
    // Public read-only tools run without a principal; they never mutate.
    return await executeMcpTool(options.name, args, null);
  }

  const user = options.user;
  const locals: OwnerPrincipalLocals = options.locals?.workspaceSubject
    ? options.locals
    : {
        permissions: options.permissions,
        tenantId: options.tenantId,
        user,
      };
  try {
    return await runAsOwner(
      locals,
      async (run) => {
        run.assertToolAllowed(options.name);
        const operations = mcpToolOperations(options.name, args);
        if (!operations) {
          throw new McpAccessError(
            403,
            `No operation permission mapping for MCP tool: ${options.name}`,
          );
        }
        for (const operation of operations) {
          await run.assertOperation(operation.collection, operation.action);
        }
        return await executeMcpTool(options.name, args, user, locals);
      },
      {
        action: 'mcp.tools/call',
        auditMetadata: { tool: options.name },
      },
    );
  } catch (cause) {
    if (isOwnerAuthorityDenial(cause)) {
      throw new McpAccessError(403, 'Forbidden');
    }
    throw cause;
  }
}

async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  user: Pick<User, 'id'> | null,
  locals?: OwnerPrincipalLocals,
): Promise<MCPResponse> {
  if (isSourceReadMcpTool(name)) {
    if (!user) {
      throw new McpAccessError(
        401,
        `Authentication is required for MCP tool: ${name}`,
      );
    }
    return await callSourceReadMcpTool(name, args);
  }
  if (isJobSearchBridgeMcpTool(name) || isWorkflowToolName(name)) {
    if (!user || !locals?.workspaceSubject) {
      throw new McpAccessError(
        401,
        `Authentication is required for MCP tool: ${name}`,
      );
    }
    const validation = isWorkflowToolName(name)
      ? validateWorkflowToolArguments(name, args)
      : validateJobSearchToolArguments(name as JobSearchToolName, args, 'body');
    if (!validation.ok) {
      throw new McpAccessError(400, validation.error);
    }
    try {
      const result = isWorkflowToolName(name)
        ? await executeWorkflowTool(name, args, user)
        : await executeJobSearchTool(name as JobSearchToolName, args, {
            locals,
            user,
          });
      return jsonResponse(
        (result && typeof result === 'object' && !Array.isArray(result)
          ? result
          : { result }) as Record<string, unknown>,
      );
    } catch (cause) {
      if (isOwnerAuthorityDenial(cause)) throw cause;
      return sourceMcpError(cause);
    }
  }
  if (isTagLookupMcpTool(name)) {
    if (!user) {
      throw new McpAccessError(
        401,
        `Authentication is required for MCP tool: ${name}`,
      );
    }
    return jsonResponse(
      (await lookupTags(args)) as unknown as Record<string, unknown>,
    );
  }
  if (isPublicProfileMcpTool(name)) {
    if (!user || !locals?.workspaceSubject) {
      throw new McpAccessError(
        401,
        `Authentication is required for MCP tool: ${name}`,
      );
    }
    return await callPublicProfileMcpTool(name, args, locals);
  }
  const subject = requireCandidateWorkspaceSubject();
  const options = { name, user };
  // An application update resolves the owned record exactly once, before any
  // record-dependent guard: a foreign or missing id is a 404 and nothing
  // about the row is disclosed, and the snapshot the guards validate is the
  // same snapshot the concurrency commit fences.
  let ownedApplication: (Record<string, unknown> & Saveable) | null = null;
  if (options.name === 'application_update') {
    const applicationId = hasNonEmptyString(args.id) ? args.id.trim() : '';
    if (!applicationId) {
      throw new McpAccessError(
        400,
        'Application update requires an application id.',
      );
    }
    ownedApplication = await findOwnedRecord('Application', applicationId);
    if (!ownedApplication) {
      throw new McpAccessError(404, 'Application not found.');
    }
  }
  await assertMcpWorkflowPayload(
    options.name,
    args,
    options.user ?? null,
    subject,
    ownedApplication
      ? (JSON.parse(JSON.stringify(ownedApplication)) as Record<
          string,
          unknown
        >)
      : undefined,
  );

  // Candidate-owned classes never reach `MCPGenerator`: every read and write
  // below goes through the owner-scoped path. Classes with a bespoke flow
  // (application concurrency commit, résumé variant reservation) keep that
  // flow around the scoped read or write.
  const scoped = resolveMcpToolClass(options.name);
  const scopedClassName =
    scoped && isScopedResourceClass(scoped.className) ? scoped.className : null;
  const scopedAction = scopedClassName
    ? options.name.slice(mcpToolPrefix(scopedClassName).length)
    : null;

  if (options.name === 'application_update' && ownedApplication) {
    const application = ownedApplication;
    if (
      !(await commitApplicationIfCurrent(
        application as unknown as Record<string, unknown>,
        applicationUpdatesFromPayload(args),
      ))
    ) {
      throw new McpAccessError(
        409,
        'Application changed before this update could be saved. Reload and review the current application.',
      );
    }
    const response: MCPResponse = {
      content: [
        {
          text: JSON.stringify(application),
          type: 'text',
        },
      ],
    };
    await syncMcpWorkflowSideEffects(options.name, args, response, subject);
    return response;
  }

  let resumeVariantReservation: Awaited<
    ReturnType<typeof reserveResumeVariantApplicationWrite>
  >['reservation'] = null;
  if (options.name === 'resumevariant_update') {
    const resumeVariantId = hasNonEmptyString(args.id) ? args.id.trim() : '';
    const { reservation, violation } =
      await reserveResumeVariantApplicationWrite(resumeVariantId, subject);
    if (violation) throw new McpAccessError(409, violation);
    resumeVariantReservation = reservation;
  }

  let response: MCPResponse;
  try {
    if (scopedClassName && scopedAction) {
      try {
        response = await executeScopedMcpTool(
          scopedClassName,
          scopedAction,
          args,
        );
      } catch (cause) {
        if (isOwnerAuthorityDenial(cause)) throw cause;
        return sourceMcpError(cause);
      }
    } else {
      response = await createGenerator(options.user).handleToolCall({
        method: 'tools/call',
        params: {
          arguments: args,
          name: options.name,
        },
      });
    }
  } catch (cause) {
    if (resumeVariantReservation) {
      await releaseResumeVariantApplicationWrite(
        resumeVariantReservation,
        subject,
      );
    }
    throw cause;
  }
  if (resumeVariantReservation) {
    const release = await releaseResumeVariantApplicationWrite(
      resumeVariantReservation,
      subject,
    );
    if (!release.applicationLocksReleased) {
      throw new McpAccessError(
        409,
        'Resume variant changed, but application materials could not be unlocked. Reload and review the current applications.',
      );
    }
    if (!release.workflowTasksSynced) {
      throw new McpAccessError(
        500,
        'Resume variant changed, but application review tasks could not be synchronized. Reload and review the current applications.',
      );
    }
  }
  await syncMcpWorkflowSideEffects(options.name, args, response, subject);
  return response;
}

function mcpToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpAccessError(400, 'MCP tool arguments must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function responseText(response: MCPResponse): string {
  return (
    response.content.find((entry) => entry.type === 'text')?.text.trim() ?? ''
  );
}

function responseRecordId(response: MCPResponse): string {
  const text = responseText(response);
  if (!text || text.startsWith('Error:')) return '';

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return hasNonEmptyString(parsed.id) ? parsed.id.trim() : '';
  } catch {
    return '';
  }
}

async function syncMcpWorkflowSideEffects(
  toolName: string,
  args: Record<string, unknown>,
  response: MCPResponse,
  subject: Parameters<typeof syncResumeVariantApplicationApprovals>[1],
) {
  if (responseText(response).startsWith('Error:')) return;

  const sourceWrite =
    toolName === 'source_create' || toolName === 'source_update';
  const resumeVariantWrite =
    toolName === 'resumevariant_create' || toolName === 'resumevariant_update';
  if (!sourceWrite && !resumeVariantWrite) return;

  const id = hasNonEmptyString(args.id)
    ? args.id.trim()
    : responseRecordId(response);
  if (!id) return;

  if (resumeVariantWrite) {
    await syncResumeVariantApplicationApprovals(id, subject);
    return;
  }

  const source = await (await getCollection('Source')).get(id);
  if (source) {
    await syncSourceSchedule(
      source as unknown as Parameters<typeof syncSourceSchedule>[0],
    );
    await syncSourceAccountTasks(source as unknown as Record<string, unknown>);
  }
}

/**
 * The application snapshot the update guards validate. The bridge resolves
 * it through the owner-scoped lookup and hands it in, so the guards never
 * read an unscoped row and the commit fences the very snapshot they saw; a
 * direct caller without a snapshot gets the owner-scoped read here.
 */
async function currentApplicationRecord(
  toolName: string,
  args: Record<string, unknown>,
  provided?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (toolName !== 'application_update') return null;
  if (provided) return provided;

  const applicationId = hasNonEmptyString(args.id) ? args.id.trim() : '';
  if (!applicationId) {
    throw new McpAccessError(
      400,
      'Application update requires an application id.',
    );
  }

  const application = await findOwnedRecord('Application', applicationId);
  if (!application) {
    throw new McpAccessError(404, 'Application not found.');
  }

  return JSON.parse(JSON.stringify(application)) as Record<string, unknown>;
}

async function assertMcpResumeAssetWriteAllowed(
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (
    toolName !== 'resumeasset_create' &&
    toolName !== 'resumeasset_update' &&
    toolName !== 'resumeasset_delete'
  ) {
    return;
  }
  if (hasNonEmptyString(args.applicationId)) {
    throw new McpAccessError(
      403,
      'Application-owned materials are immutable through generic MCP writes. Regenerate or revise them through the application workflow.',
    );
  }
  if (toolName === 'resumeasset_create') return;
  const assetId = hasNonEmptyString(args.id) ? args.id.trim() : '';
  if (!assetId) {
    throw new McpAccessError(400, 'Resume asset write requires an asset id.');
  }
  const asset = await findOwnedRecord('ResumeAsset', assetId);
  if (!asset) throw new McpAccessError(404, 'Resume asset not found.');
  if (
    hasNonEmptyString(
      (asset as unknown as Record<string, unknown>).applicationId,
    )
  ) {
    throw new McpAccessError(
      403,
      'Application-owned materials are immutable through generic MCP writes. Regenerate or revise them through the application workflow.',
    );
  }
}

export async function assertMcpWorkflowPayload(
  toolName: string,
  args: Record<string, unknown>,
  user?: Pick<User, 'id'> | null,
  subject?: Parameters<typeof syncResumeVariantApplicationApprovals>[1],
  currentApplication?: Record<string, unknown>,
): Promise<void> {
  if (toolName.startsWith('agentrun_') && !isReadOnlyMcpTool(toolName)) {
    throw new McpAccessError(
      403,
      'Agent run audit records are system-authored and immutable.',
    );
  }
  if (
    (toolName.startsWith('sourcecrawl_') ||
      toolName.startsWith('sourcecrawlitem_')) &&
    !isReadOnlyMcpTool(toolName)
  ) {
    throw new McpAccessError(
      403,
      'Source crawl accounting records are system-authored and immutable.',
    );
  }
  normalizeMcpAgentPayload(toolName, args);
  if (
    (toolName === 'application_create' || toolName === 'application_update') &&
    Object.hasOwn(args, 'materialWriteLock')
  ) {
    throw new McpAccessError(
      403,
      'Application material-write locks are system-managed.',
    );
  }
  await assertMcpResumeAssetWriteAllowed(toolName, args);

  if (
    (toolName === 'application_create' || toolName === 'application_update') &&
    hasFinalApplicationApprovalMutation(args)
  ) {
    throw new McpAccessError(
      400,
      'Final submission approval must be recorded from the application review page.',
    );
  }

  const isSourceWrite =
    toolName === 'source_create' || toolName === 'source_update';
  if (
    (isSourceWrite ||
      toolName === 'application_create' ||
      toolName === 'application_update') &&
    Object.hasOwn(args, 'accountStatus')
  ) {
    args.accountStatus = normalizeMcpAccountStatus(args.accountStatus);
  }

  if (toolName === 'resumevariant_update') {
    const resumeVariantId = hasNonEmptyString(args.id) ? args.id.trim() : '';
    if (!resumeVariantId) {
      throw new McpAccessError(
        400,
        'Resume variant update requires a resume variant id.',
      );
    }

    if (!subject) {
      throw new McpAccessError(
        401,
        'A verified candidate profile is required for resume variant updates.',
      );
    }
    const violation = await resumeVariantWriteViolation(
      resumeVariantId,
      subject,
    );
    if (violation) {
      throw new McpAccessError(400, violation);
    }
  }

  const isApplicationWrite =
    toolName === 'application_create' || toolName === 'application_update';
  if (!isApplicationWrite) return;

  const currentRecord = await currentApplicationRecord(
    toolName,
    args,
    currentApplication,
  );

  if (
    applicationSubmissionRequiresDedicatedAction({
      currentRecord,
      payload: args,
    })
  ) {
    throw new McpAccessError(
      400,
      'Application submission must be recorded from the application review page.',
    );
  }

  const hasStatus = Object.hasOwn(args, 'status');
  const statusValue = hasStatus ? String(args.status ?? '').trim() : '';
  if (hasStatus) {
    if (statusValue && !toApplicationStatus(statusValue)) {
      throw new McpAccessError(
        400,
        `Invalid application status: ${statusValue}.`,
      );
    }
    args.status = normalizeApplicationStatus(statusValue);
  }

  let scopeInvalidatedApproval = false;
  if (
    currentRecord &&
    applicationApprovalScopeChanged({ currentRecord, payload: args })
  ) {
    const currentStatus = currentRecord?.status ?? args.status;
    if (applicationMaterialsAreLockedOrLeased(currentStatus, currentRecord)) {
      throw new McpAccessError(
        400,
        'Submitted or closed applications cannot have their approved materials changed.',
      );
    }
    if (applicationApprovalShouldInvalidate(currentRecord.status)) {
      args.status = 'awaiting_user';
      clearApplicationApprovalFields(args);
      scopeInvalidatedApproval = true;
    }
  }

  const nextStatus =
    hasStatus || scopeInvalidatedApproval
      ? args.status
      : (currentRecord?.status ?? 'draft');
  const statusRequiresApproval = applicationStatusRequiresApproval(nextStatus);
  const hasApprovalField = Object.hasOwn(args, 'approvedByUserId');
  const approvedByUserId = hasNonEmptyString(args.approvedByUserId)
    ? args.approvedByUserId.trim()
    : '';
  const existingApprovalUserId = hasNonEmptyString(
    currentRecord?.approvedByUserId,
  )
    ? currentRecord.approvedByUserId.trim()
    : '';
  const isSubmitted = toApplicationStatus(nextStatus) === 'submitted';
  const violation = validateApplicationStatusTransition({
    approvedByUserId:
      approvedByUserId ||
      existingApprovalUserId ||
      (statusRequiresApproval && !existingApprovalUserId ? user?.id : ''),
    currentStatus: currentRecord?.status,
    nextStatus,
  });
  if (violation) {
    throw new McpAccessError(400, violation);
  }

  if (
    existingApprovalUserId &&
    approvedByUserId &&
    approvedByUserId !== existingApprovalUserId
  ) {
    throw new McpAccessError(
      400,
      'Application approval is already recorded and cannot be reassigned.',
    );
  }

  const needsNewApproval = statusRequiresApproval && !existingApprovalUserId;
  const preservesExistingApproval =
    !scopeInvalidatedApproval &&
    hasApprovalField &&
    !approvedByUserId &&
    existingApprovalUserId;
  if (needsNewApproval || approvedByUserId) {
    if (!user?.id || (approvedByUserId && approvedByUserId !== user.id)) {
      throw new McpAccessError(
        400,
        'Application approval requires approvedByUserId matching the authenticated user.',
      );
    }
  }

  if (needsNewApproval || approvedByUserId || preservesExistingApproval) {
    args.approvedByUserId = existingApprovalUserId || user?.id || '';
  }

  if (
    statusRequiresApproval &&
    !dateValue(args.approvedAt) &&
    !dateValue(currentRecord?.approvedAt)
  ) {
    args.approvedAt = new Date();
  }

  if (!isSubmitted) return;

  if (!dateValue(args.submittedAt) && !dateValue(currentRecord?.submittedAt)) {
    args.submittedAt = new Date();
  }

  if (!args.submissionMethod && !currentRecord?.submissionMethod) {
    args.submissionMethod = submissionMethodFromApplyMethod(
      args.applyMethod ?? currentRecord?.applyMethod,
    );
  }

  if (!args.submittedByRole && !currentRecord?.submittedByRole) {
    args.submittedByRole = currentRecord?.approvedByUserId
      ? 'agent_with_approval'
      : 'owner';
  }

  if (args.submittedByRole === 'owner' && user?.id && !args.submittedByUserId) {
    args.submittedByUserId = user.id;
  }

  const submissionViolation = validateSubmittedApplicationPayload({
    currentRecord,
    payload: args,
    user,
  });
  if (submissionViolation) {
    throw new McpAccessError(400, submissionViolation);
  }
}
