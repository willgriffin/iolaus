import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
  AgentFieldContractError,
  normalizeAgentWritablePayload,
} from '$lib/objects/agent-field-contract';
import {
  applicationSubmissionRequiresDedicatedAction,
  hasFinalApplicationApprovalMutation,
} from '$lib/objects/application-approval-scope';
import {
  applicationStatusRequiresApproval,
  normalizeApplicationStatus,
  toApplicationStatus,
  validateApplicationStatusTransition,
} from '$lib/objects/lifecycle';
import { type ApiAction, resolveApiResource } from '$lib/server/api-exposure';
import {
  normalizeAccountStatus,
  syncApplicationWorkflowTasks,
  syncRecommendedOpportunityDecisionTasks,
  syncSourceAccountTasks,
  validateSubmittedApplicationPayload,
} from '$lib/server/application-workflow';
import { syncResumeVariantApplicationApprovals } from '$lib/server/resume-variant-workflow';
import { getCollection } from '$lib/server/smrt';
import { syncSourceSchedule } from '$lib/server/source-schedules';

function requireResourceClass(resource: string): string {
  const resolved = resolveApiResource(resource);
  if (!resolved) throw error(404, 'Resource not found');
  return resolved.className;
}

/**
 * Reject an action the class's `@smrt({ api })` include does not expose. Runs
 * after the class-specific immutability guards so their more specific 403s
 * keep precedence.
 */
function assertActionExposed(resource: string, action: ApiAction): void {
  const resolved = resolveApiResource(resource);
  if (resolved && !resolved.actions.has(action)) {
    error(405, `Action "${action}" is not exposed for this resource.`);
  }
}

function assertResourceIsWritable(className: string): void {
  if (className === 'AgentRun') {
    error(403, 'Agent run audit records are system-authored and immutable.');
  }
  if (className === 'SourceCrawl' || className === 'SourceCrawlItem') {
    error(
      403,
      'Source crawl accounting records are system-authored and immutable.',
    );
  }
}

function assertGenericResumeAssetWriteAllowed(
  className: string,
  payload: Record<string, unknown>,
): void {
  if (className === 'ResumeAsset' && stringValue(payload.applicationId)) {
    error(
      403,
      'Application-owned materials are immutable through generic resource APIs. Regenerate or revise them through the application workflow.',
    );
  }
}

function requireResourceParam(resource: string | undefined): string {
  if (!resource) throw error(404, 'Resource not found');
  return resource;
}

function jsonObjectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    error(400, 'Request body must be a JSON object.');
  }
  return payload as Record<string, unknown>;
}

async function readJsonObjectPayload(
  request: Request,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    error(400, 'Request body must be valid JSON.');
  }
  return jsonObjectPayload(payload);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function userWithId(
  user?: { id?: string | null } | null,
): { id: string } | null {
  return typeof user?.id === 'string' && user.id.trim()
    ? { id: user.id }
    : null;
}

function normalizeAgentPayload(
  className: string,
  payload: Record<string, unknown>,
) {
  try {
    normalizeAgentWritablePayload(className, payload);
  } catch (cause) {
    if (cause instanceof AgentFieldContractError) {
      error(400, cause.message);
    }
    throw cause;
  }
}

function assertApplicationCreatePayload(
  payload: Record<string, unknown>,
  user?: { id: string } | null,
  now = new Date(),
) {
  if (Object.hasOwn(payload, 'materialWriteLock')) {
    error(403, 'Application material-write locks are system-managed.');
  }
  if (hasFinalApplicationApprovalMutation(payload)) {
    error(
      400,
      'Final submission approval must be recorded from the application review page.',
    );
  }
  if (applicationSubmissionRequiresDedicatedAction({ payload })) {
    error(
      400,
      'Application submission must be recorded from the application review page.',
    );
  }

  const hasStatus = Object.hasOwn(payload, 'status');
  if (hasStatus && !toApplicationStatus(payload.status)) {
    error(
      400,
      `Invalid application status: ${String(payload.status ?? '').trim()}.`,
    );
  }
  const status = hasStatus
    ? normalizeApplicationStatus(payload.status)
    : 'draft';
  payload.status = status;

  const approvedByUserId = stringValue(payload.approvedByUserId);
  if (applicationStatusRequiresApproval(status) || approvedByUserId) {
    if (!user?.id) {
      error(400, 'Application approval requires an authenticated user.');
    }

    if (approvedByUserId && approvedByUserId !== user.id) {
      error(
        400,
        'Application approval requires approvedByUserId matching the authenticated user.',
      );
    }

    payload.approvedByUserId = user.id;
    if (!dateValue(payload.approvedAt)) {
      payload.approvedAt = now;
    }
  }

  const violation = validateApplicationStatusTransition({
    approvedByUserId: payload.approvedByUserId,
    nextStatus: status,
  });
  if (violation) {
    error(400, violation);
  }

  const submissionViolation = validateSubmittedApplicationPayload({
    payload,
    user,
  });
  if (submissionViolation) {
    error(400, submissionViolation);
  }
}

export const GET: RequestHandler = async ({ params, url }) => {
  const limit = Number(url.searchParams.get('limit')) || 50;
  const offset = Number(url.searchParams.get('offset')) || 0;
  const resource = requireResourceParam(params.resource);
  const className = requireResourceClass(resource);
  assertActionExposed(resource, 'list');
  const collection = await getCollection(className);
  const items = await collection.list({ limit, offset });
  const count = await collection.count();

  return json({ count, data: items, items, limit, offset });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const resource = requireResourceParam(params.resource);
  const className = requireResourceClass(resource);
  assertResourceIsWritable(className);
  assertActionExposed(resource, 'create');
  const collection = await getCollection(className);
  const payload = await readJsonObjectPayload(request);
  normalizeAgentPayload(className, payload);
  assertGenericResumeAssetWriteAllowed(className, payload);

  if (
    (className === 'Application' || className === 'Source') &&
    Object.hasOwn(payload, 'accountStatus')
  ) {
    payload.accountStatus = normalizeAccountStatus(payload.accountStatus);
  }

  if (className === 'Application') {
    assertApplicationCreatePayload(payload, userWithId(locals?.user));
  }

  const item = await collection.create(payload);
  await item.save();
  if (className === 'Application') {
    await syncApplicationWorkflowTasks(
      item as unknown as Record<string, unknown>,
    );
  }
  if (className === 'Opportunity') {
    await syncRecommendedOpportunityDecisionTasks();
  }
  if (className === 'ResumeVariant') {
    await syncResumeVariantApplicationApprovals(String(item.id ?? ''));
  }
  if (className === 'Source') {
    await syncSourceSchedule(
      item as unknown as Parameters<typeof syncSourceSchedule>[0],
    );
    await syncSourceAccountTasks(item as unknown as Record<string, unknown>);
  }

  return json(item, { status: 201 });
};
