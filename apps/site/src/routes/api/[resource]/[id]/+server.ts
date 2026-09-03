import { error, json, type RequestHandler } from '@sveltejs/kit';
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
import { type ApiAction, resolveApiResource } from '$lib/server/api-exposure';
import {
  applicationUpdatesFromPayload,
  commitApplicationIfCurrent,
} from '$lib/server/application-concurrency';
import {
  normalizeAccountStatus,
  syncApplicationWorkflowTasks,
  syncRecommendedOpportunityDecisionTasks,
  syncSourceAccountTasks,
  validateSubmittedApplicationPayload,
} from '$lib/server/application-workflow';
import {
  releaseResumeVariantApplicationWrite,
  reserveResumeVariantApplicationWrite,
  resumeVariantDeleteViolation,
  syncResumeVariantApplicationApprovals,
} from '$lib/server/resume-variant-workflow';
import { getCollection } from '$lib/server/smrt';
import {
  deleteSourceSchedule,
  syncSourceSchedule,
} from '$lib/server/source-schedules';

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

function assertApplicationOwnedResumeAssetIsImmutable(
  className: string,
  record: Record<string, unknown>,
  payload: Record<string, unknown> = {},
): void {
  if (
    className === 'ResumeAsset' &&
    (stringValue(record.applicationId) || stringValue(payload.applicationId))
  ) {
    error(
      403,
      'Application-owned materials are immutable through generic resource APIs. Regenerate or revise them through the application workflow.',
    );
  }
}

function requireParam(value: string | undefined, label: string): string {
  if (!value) throw error(404, `${label} not found`);
  return value;
}

async function getResourceItem(resource: string, id: string) {
  const collection = await getCollection(requireResourceClass(resource));
  const item = await collection.get(id);
  if (!item) throw error(404, 'Item not found');

  return item;
}

function serializeRecord(record: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
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

function payloadValue(
  payload: Record<string, unknown>,
  currentRecord: Record<string, unknown>,
  key: string,
): unknown {
  return Object.hasOwn(payload, key) ? payload[key] : currentRecord[key];
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

function assertApplicationUpdatePayload(
  payload: Record<string, unknown>,
  currentRecord: Record<string, unknown>,
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
  if (
    applicationSubmissionRequiresDedicatedAction({ currentRecord, payload })
  ) {
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
  if (hasStatus) {
    payload.status = normalizeApplicationStatus(payload.status);
  }

  let scopeInvalidatedApproval = false;
  if (applicationApprovalScopeChanged({ currentRecord, payload })) {
    if (
      applicationMaterialsAreLockedOrLeased(currentRecord.status, currentRecord)
    ) {
      error(
        400,
        'Submitted or closed applications cannot have their approved materials changed.',
      );
    }
    if (applicationApprovalShouldInvalidate(currentRecord.status)) {
      payload.status = 'awaiting_user';
      clearApplicationApprovalFields(payload);
      scopeInvalidatedApproval = true;
    }
  }

  const nextStatus =
    hasStatus || scopeInvalidatedApproval
      ? payload.status
      : (currentRecord.status ?? 'draft');
  const statusRequiresApproval = applicationStatusRequiresApproval(nextStatus);
  const hasApprovalField = Object.hasOwn(payload, 'approvedByUserId');
  const approvedByUserId = stringValue(payload.approvedByUserId);
  const existingApprovalUserId = stringValue(currentRecord.approvedByUserId);

  if (
    existingApprovalUserId &&
    approvedByUserId &&
    approvedByUserId !== existingApprovalUserId
  ) {
    error(
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
    if (!user?.id) {
      error(400, 'Application approval requires an authenticated user.');
    }

    if (approvedByUserId && approvedByUserId !== user.id) {
      error(
        400,
        'Application approval requires approvedByUserId matching the authenticated user.',
      );
    }
  }

  if (needsNewApproval || approvedByUserId || preservesExistingApproval) {
    payload.approvedByUserId = existingApprovalUserId || user?.id || '';
  }

  if (
    statusRequiresApproval &&
    !dateValue(payload.approvedAt) &&
    !dateValue(currentRecord.approvedAt)
  ) {
    payload.approvedAt = now;
  }

  const transitionViolation = validateApplicationStatusTransition({
    approvedByUserId: payloadValue(payload, currentRecord, 'approvedByUserId'),
    currentStatus: currentRecord.status,
    nextStatus,
  });
  if (transitionViolation) {
    error(400, transitionViolation);
  }

  if (hasStatus || scopeInvalidatedApproval) {
    payload.status = nextStatus;
  }

  if (toApplicationStatus(nextStatus) === 'submitted') {
    const submissionViolation = validateSubmittedApplicationPayload({
      currentRecord,
      payload,
      user,
    });
    if (submissionViolation) {
      error(400, submissionViolation);
    }
  }
}

export const GET: RequestHandler = async ({ params }) => {
  const resource = requireParam(params.resource, 'Resource');
  requireResourceClass(resource);
  assertActionExposed(resource, 'get');
  return json(await getResourceItem(resource, requireParam(params.id, 'Item')));
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  const resource = requireParam(params.resource, 'Resource');
  const className = requireResourceClass(resource);
  assertResourceIsWritable(className);
  assertActionExposed(resource, 'update');
  const payload = await readJsonObjectPayload(request);
  const id = requireParam(params.id, 'Item');
  const item = await getResourceItem(resource, id);
  assertApplicationOwnedResumeAssetIsImmutable(
    className,
    serializeRecord(item),
    payload,
  );
  normalizeAgentPayload(className, payload);
  if (
    (className === 'Application' || className === 'Source') &&
    Object.hasOwn(payload, 'accountStatus')
  ) {
    payload.accountStatus = normalizeAccountStatus(payload.accountStatus);
  }
  if (className === 'Application') {
    assertApplicationUpdatePayload(
      payload,
      serializeRecord(item),
      userWithId(locals?.user),
    );
  }
  let resumeVariantReservation: Awaited<
    ReturnType<typeof reserveResumeVariantApplicationWrite>
  >['reservation'] = null;
  if (className === 'ResumeVariant') {
    const { reservation, violation } =
      await reserveResumeVariantApplicationWrite(id);
    if (violation) {
      error(409, violation);
    }
    resumeVariantReservation = reservation;
  }

  try {
    if (className === 'Application') {
      if (
        !(await commitApplicationIfCurrent(
          item as unknown as Record<string, unknown>,
          applicationUpdatesFromPayload(payload),
        ))
      ) {
        error(
          409,
          'Application changed before this update could be saved. Reload and review the current application.',
        );
      }
      await syncApplicationWorkflowTasks(
        item as unknown as Record<string, unknown>,
      );
    } else {
      Object.assign(item, payload);
      await item.save();
    }
  } catch (cause) {
    if (resumeVariantReservation) {
      await releaseResumeVariantApplicationWrite(resumeVariantReservation);
    }
    throw cause;
  }
  if (resumeVariantReservation) {
    const release = await releaseResumeVariantApplicationWrite(
      resumeVariantReservation,
    );
    if (!release.applicationLocksReleased) {
      error(
        409,
        'Resume variant changed, but application materials could not be unlocked. Reload and review the current applications.',
      );
    }
    if (!release.workflowTasksSynced) {
      error(
        500,
        'Resume variant changed, but application review tasks could not be synchronized. Reload and review the current applications.',
      );
    }
  }
  if (className === 'Opportunity') {
    await syncRecommendedOpportunityDecisionTasks();
  }
  if (className === 'ResumeVariant') {
    await syncResumeVariantApplicationApprovals(id);
  }
  if (className === 'Source') {
    await syncSourceSchedule(
      item as unknown as Parameters<typeof syncSourceSchedule>[0],
    );
    await syncSourceAccountTasks(item as unknown as Record<string, unknown>);
  }

  return json(item);
};

export const DELETE: RequestHandler = async ({ params }) => {
  const resource = requireParam(params.resource, 'Resource');
  const className = requireResourceClass(resource);
  assertResourceIsWritable(className);
  assertActionExposed(resource, 'delete');
  const id = requireParam(params.id, 'Item');
  const item = await getResourceItem(resource, id);
  assertApplicationOwnedResumeAssetIsImmutable(
    className,
    serializeRecord(item),
  );
  if (className === 'ResumeVariant') {
    const violation = await resumeVariantDeleteViolation(id);
    if (violation) {
      error(400, violation);
    }
  }
  await item.delete();
  if (className === 'Source') {
    await deleteSourceSchedule(id);
  }

  return json({ success: true });
};
