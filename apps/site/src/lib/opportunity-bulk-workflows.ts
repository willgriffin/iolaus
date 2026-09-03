import type {
  DataSurfaceActionRequest,
  DataSurfaceActionResult,
  DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data';

/**
 * Browser-safe contract for the opportunity bulk workflows.
 *
 * Kept free of server imports so the list component can build requests and
 * name tools without pulling the database layer into the client bundle.
 */

/** The mounted surface these actions belong to. */
export const OPPORTUNITY_DATA_SURFACE_IDENTITY: DataSurfaceIdentity = {
  surfaceId: 'admin-opportunities',
  kind: 'table',
};

export const OPPORTUNITY_BULK_WORKFLOW_IDS = {
  processWithLlm: 'process-with-llm',
  review: 'review',
} as const;

export type OpportunityBulkWorkflowId =
  (typeof OPPORTUNITY_BULK_WORKFLOW_IDS)[keyof typeof OPPORTUNITY_BULK_WORKFLOW_IDS];

/**
 * Persona capabilities gating the two workflows.
 *
 * These are principal tool names, not WebMCP or server-MCP tools: the actions
 * are reachable only through the authenticated route. They are merged into the
 * owner's derived allow-list so the fail-closed check has something to match.
 */
export const OPPORTUNITY_BULK_REVIEW_TOOL = 'opportunity_bulk_review';
export const OPPORTUNITY_BULK_PROCESS_LLM_TOOL = 'opportunity_bulk_process_llm';

export const opportunityDataSurfaceToolNames: readonly string[] = [
  OPPORTUNITY_BULK_PROCESS_LLM_TOOL,
  OPPORTUNITY_BULK_REVIEW_TOOL,
];

/**
 * The ceiling on a single bulk selection. An "all matching" selection larger
 * than this is refused rather than silently truncated, so the operator is
 * never told a narrower action was applied to everything they filtered for.
 */
export const OPPORTUNITY_BULK_MAX_SELECTION_SIZE = 500;

export const OPPORTUNITY_BULK_ACTIONS_PATH =
  '/api/admin/opportunities/bulk-actions';

export type OpportunityBulkWorkflowRequest = DataSurfaceActionRequest & {
  expectedRevision: number;
  idempotencyKey?: string;
};

export interface OpportunityBulkWorkflowClient {
  preview(
    request: OpportunityBulkWorkflowRequest,
  ): Promise<DataSurfaceActionResult>;
  apply(
    request: OpportunityBulkWorkflowRequest,
  ): Promise<DataSurfaceActionResult>;
}

export function createOpportunityBulkWorkflowClient(options: {
  fetch: typeof globalThis.fetch;
  path?: string;
}): OpportunityBulkWorkflowClient {
  const basePath = options.path ?? OPPORTUNITY_BULK_ACTIONS_PATH;

  const call = async (
    phase: 'preview' | 'apply',
    request: OpportunityBulkWorkflowRequest,
  ): Promise<DataSurfaceActionResult> => {
    const response = await options.fetch(`${basePath}/${phase}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, phase }),
    });
    if (!response.ok) {
      // 401/403 mean the session or authority is gone, which is not an
      // in-band action outcome. Everything else is returned as a result.
      throw new Error(
        response.status === 401 || response.status === 403
          ? 'Not authorized to run opportunity bulk workflows.'
          : `Opportunity bulk ${phase} failed (${response.status}).`,
      );
    }
    return (await response.json()) as DataSurfaceActionResult;
  };

  return {
    preview: (request) => call('preview', request),
    apply: (request) => call('apply', request),
  };
}

/** What a preview resolved, as the confirmation strip reports it. */
export interface OpportunityBulkActionSummary {
  /** Rows a confirm would actually change. */
  accepted: number;
  /** Distinct reasons the remaining rows were not accepted. */
  reasons: string[];
  /** Rows the action resolved but will not change. */
  skipped: number;
}

/**
 * Summarize a `DataSurfaceActionResult`'s details for the operator.
 *
 * The adapter reports per-row results under `outcomes`, alongside `accepted`,
 * `skipped`, and `failed` tallies -- not under `rows`, and not as a single
 * `count`. The number the operator confirms against must be the accepted
 * count: the resolved-row count includes archived rows and rows with no
 * stored posting content, which are skipped rather than changed, so showing
 * it would overstate what a confirm does.
 */
export function summarizeOpportunityBulkDetails(
  details: unknown,
): OpportunityBulkActionSummary {
  const record =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {};
  const outcomes = Array.isArray(record.outcomes) ? record.outcomes : [];
  const reasons = new Set<string>();
  let acceptedRows = 0;
  let skippedRows = 0;
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
      continue;
    }
    const entry = outcome as Record<string, unknown>;
    if (entry.status === 'accepted') {
      acceptedRows += 1;
      continue;
    }
    skippedRows += 1;
    if (typeof entry.reason === 'string' && entry.reason) {
      reasons.add(entry.reason);
    }
  }

  // The adapter's own tallies are authoritative when present; the per-row
  // walk is the fallback for a result that carries only outcomes.
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  const hasTallies = typeof record.accepted === 'number';
  return {
    accepted: hasTallies ? number(record.accepted) : acceptedRows,
    reasons: [...reasons].sort(),
    skipped: hasTallies
      ? number(record.skipped) + number(record.failed)
      : skippedRows,
  };
}
