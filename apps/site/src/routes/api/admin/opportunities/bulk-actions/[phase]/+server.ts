import {
  type DataSurfaceServerActionRequest,
  isBoundedDataSurfaceJsonValue,
} from '@happyvertical/smrt-agents/server';
import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import { json, type RequestHandler } from '@sveltejs/kit';
import { OPPORTUNITY_DATA_SURFACE_IDENTITY } from '$lib/opportunity-bulk-workflows';
import { normalizeFilterState } from '$lib/opportunity-filters';
import { SmrtDataSurfaceActionStateStore } from '$lib/server/data-surface-action-state-store';
import {
  createOpportunityDataSurfaceAdapter,
  type OpportunityBulkQueryTarget,
  OpportunitySelectionError,
} from '$lib/server/opportunity-data-surface-actions';
import {
  isOwnerAuthorityDenial,
  logOwnerPrincipalAudit,
  ownerPrincipalOptions,
} from '$lib/server/owner-principal';

const PHASES = new Set(['preview', 'apply']);

/**
 * The action label `@happyvertical/smrt-agents` stamps on the audit line for
 * an apply it actually executes, overriding the one the route supplies.
 */
const ADAPTER_APPLY_AUDIT_ACTION = 'data_surface.action.apply';
const ADAPTER_PREVIEW_AUDIT_ACTION = 'data_surface.action.preview';

function refusal(
  body: Record<string, unknown>,
  phase: string,
  reason: string,
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: typeof body.requestId === 'string' ? body.requestId : '',
    identity: OPPORTUNITY_DATA_SURFACE_IDENTITY,
    actionId: typeof body.actionId === 'string' ? body.actionId : '',
    phase: phase as 'preview' | 'apply',
    ok: false,
    reason,
  };
}

/**
 * Read the filter state the caller claims the selection was made under.
 *
 * `normalizeFilterState` is the same sanitizer the page load and the browser
 * use, which is what makes the two query fingerprints comparable: it starts
 * from the defaults and reads only known keys, so an untrusted body still
 * cannot introduce a key the fingerprint would hash, and it coerces each
 * field by its own type instead of by `typeof` against the default. That
 * distinction matters -- every numeric filter defaults to `null`, so a
 * `typeof` comparison drops the value the operator actually set.
 */
function queryTargetFrom(
  body: Record<string, unknown>,
): OpportunityBulkQueryTarget {
  const raw =
    body.target &&
    typeof body.target === 'object' &&
    !Array.isArray(body.target)
      ? (body.target as Record<string, unknown>)
      : {};

  const filters = normalizeFilterState(raw.filters);

  return {
    candidateSkills: Array.isArray(raw.candidateSkills)
      ? raw.candidateSkills.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    filters,
    page: typeof raw.page === 'number' ? raw.page : 1,
    reviewFilter:
      typeof raw.reviewFilter === 'string' ? raw.reviewFilter : 'unsorted',
    search: typeof raw.search === 'string' ? raw.search : undefined,
  };
}

/**
 * Record a request the adapter answered without entering the owner principal.
 *
 * The adapter emits the audit line itself, but only once it enters the
 * principal. Everything it settles before that -- a refused envelope, an
 * expired, mismatched, or already-spent confirmation, an idempotency conflict,
 * a replay of a completed apply, a reservation still held elsewhere -- would
 * otherwise leave no trace of an authenticated request to mutate rows in bulk.
 *
 * Rather than enumerate those exits and drift from the upstream list, the
 * route watches whether the principal audited at all: `principalAudited` is
 * set by the audit sink the principal was handed. Exactly one line is emitted
 * per request either way.
 */
function auditUnprincipledRequest(
  principal: Awaited<ReturnType<typeof ownerPrincipalOptions>>,
  phase: string,
  result: DataSurfaceActionResult | null,
  outcome?: string,
): void {
  logOwnerPrincipalAudit({
    // The label the adapter stamps on the phases it executes, so one filter
    // over the audit stream returns executed and unexecuted alike.
    action:
      phase === 'apply'
        ? ADAPTER_APPLY_AUDIT_ACTION
        : ADAPTER_PREVIEW_AUDIT_ACTION,
    actorUserId: principal.principal.runAsUserId,
    agentClass: principal.agentClass,
    onBehalfOfUserId: principal.onBehalfOfUserId ?? null,
    tenantId: principal.principal.tenantId ?? null,
    metadata: {
      ...principal.auditMetadata,
      // A successful result that never entered the principal can only be a
      // replay of one an earlier apply recorded. An unsuccessful one is
      // reported as refused with its reason: the route cannot tell a fresh
      // refusal from a replayed refusal, and the reason is the part worth
      // keeping either way.
      outcome: outcome ?? (result?.ok ? 'replayed' : 'refused'),
      ...(result?.reason ? { reason: result.reason } : {}),
    },
  });
}

/**
 * Preview and apply for the opportunity bulk workflows.
 *
 * Action outcomes -- a refused selection, an ineligible row, a drifted
 * revision -- are returned in band with HTTP 200, because they are answers,
 * not transport failures. Only a missing session or a denied authority
 * produces 401/403.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const phase = params.phase ?? '';
  if (!PHASES.has(phase)) {
    return json({ error: 'Not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be an object');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  // Set by the audit sink handed to the principal below. The adapter settles
  // several outcomes before entering the principal, so this is what tells the
  // route whether the line has already been written.
  let principalAudited = false;
  // Binding the principal resolves the tool catalogue; it does not authorize
  // anything, so there is no denial to translate here. Tool and operation
  // denials come from the adapter below, after the principal has written its
  // own audit line.
  const resolved = await ownerPrincipalOptions(locals, {
    action: `data_surface.opportunities.${phase}`,
    auditMetadata: {
      actionId: String(body.actionId ?? ''),
      requestId: String(body.requestId ?? ''),
      surfaceId: OPPORTUNITY_DATA_SURFACE_IDENTITY.surfaceId,
      ...(typeof body.idempotencyKey === 'string'
        ? { idempotencyKey: body.idempotencyKey }
        : {}),
    },
  });
  const principal = {
    ...resolved,
    audit: (entry: Parameters<typeof logOwnerPrincipalAudit>[0]) => {
      principalAudited = true;
      logOwnerPrincipalAudit(entry);
    },
  };

  // Every answer from here on carries exactly one audit line: the principal's
  // own when it ran, and the route's otherwise. An unexpected error that
  // escapes as a 500 is not an answer and is not audited here.
  const answer = (result: DataSurfaceActionResult): Response => {
    if (!principalAudited) auditUnprincipledRequest(principal, phase, result);
    return json(result);
  };

  if (
    body.version !== 1 ||
    // The phase is part of the URL and part of the envelope; a request that
    // disagrees with itself is not one this route will guess about.
    body.phase !== phase ||
    (body.payload !== undefined && !isBoundedDataSurfaceJsonValue(body.payload))
  ) {
    return answer(refusal(body, phase, 'invalid_request'));
  }

  const actionRequest = {
    ...body,
    identity: OPPORTUNITY_DATA_SURFACE_IDENTITY,
    expectedRevision:
      typeof body.expectedRevision === 'number' ? body.expectedRevision : 0,
  } as unknown as DataSurfaceServerActionRequest;

  try {
    // Inside the audited boundary: the state store opens a database
    // connection, and a failure there is as much a failed bulk attempt as one
    // the adapter raises.
    const adapter = createOpportunityDataSurfaceAdapter({
      state: await SmrtDataSurfaceActionStateStore.create(),
      resolveQueryTarget: () => queryTargetFrom(body),
    });
    const result =
      phase === 'preview'
        ? await adapter.preview(actionRequest, { principal })
        : await adapter.apply(actionRequest, { principal });
    return answer(result);
  } catch (caught) {
    // A selection the server will not resolve has no row set to report on, so
    // the adapter raises it rather than returning per-row outcomes. It is
    // still an answer to the caller, not a transport failure.
    if (caught instanceof OpportunitySelectionError) {
      return answer(refusal(body, phase, caught.reason));
    }
    if (isOwnerAuthorityDenial(caught)) {
      return json({ error: 'Forbidden' }, { status: 403 });
    }
    // An unexpected failure -- the state store, or the adapter's own database
    // work before it enters the principal -- becomes a 500 with no result to
    // report. Record that the request was made and failed before dropping it,
    // so a bulk attempt that ends in an error is not the one kind of attempt
    // the trail forgets.
    if (!principalAudited) {
      auditUnprincipledRequest(principal, phase, null, 'failed');
    }
    throw caught;
  }
};
