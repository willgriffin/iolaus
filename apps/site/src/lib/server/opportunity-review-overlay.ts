import {
  createPrivateRecord,
  getPrivateRecord,
  listPrivateRecords,
  PrivateWorkspaceSubjectError,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';

const MAX_OPPORTUNITY_IDS = 200;

export interface OpportunityReviewOverlay {
  humanRating: number | null;
  humanReviewNotes: string;
  humanReviewStatus: 'apply' | 'archived' | 'maybe' | 'needs_input' | 'reject';
  reviewedAt: Date | string | null;
  reviewedByProfileId: string;
  reviewedByUserId: string;
}

export interface LoadOpportunityReviewOverlaysInput {
  opportunityIds: readonly string[];
  subject: WorkspaceSubject;
}

export interface CreatePrivateDecisionInput {
  agentRunId?: string;
  applicationId?: string;
  decision: string;
  database?: unknown;
  decisionTags?: string;
  evaluationScoreId?: string;
  humanRating?: number | null;
  newStatus?: string;
  opportunityId: string;
  previousStatus?: string;
  reason?: string;
  sourceCrawlId?: string;
  sourceCrawlItemId?: string;
  subject: WorkspaceSubject;
  taskId?: string;
}

export interface CreatePrivateDecisionTagInput {
  decisionId: string;
  subject: WorkspaceSubject;
  tagId: string;
  tagRole: string;
}

export interface RecordPrivateOpportunityReviewInput {
  humanRating?: number | null;
  humanReviewNotes?: string;
  humanReviewStatus: 'apply' | 'archived' | 'maybe' | 'needs_input' | 'reject';
  opportunityId: string;
  subject: WorkspaceSubject;
}

function requiredOpaqueId(value: unknown, label: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (
    !id ||
    id.length > 160 ||
    [...id].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new PrivateWorkspaceSubjectError(`Invalid ${label}.`);
  }
  return id;
}

function boundedOpportunityIds(ids: readonly string[]): string[] {
  if (ids.length > MAX_OPPORTUNITY_IDS) {
    throw new PrivateWorkspaceSubjectError(
      `At most ${MAX_OPPORTUNITY_IDS} opportunity IDs may be reviewed at once.`,
    );
  }
  return [...new Set(ids.map((id) => requiredOpaqueId(id, 'opportunity ID')))];
}

function reviewStatus(
  value: unknown,
): OpportunityReviewOverlay['humanReviewStatus'] {
  switch (value) {
    case 'accept_to_apply':
      return 'apply';
    case 'archive':
      return 'archived';
    case 'defer':
      return 'maybe';
    case 'reject':
      return 'reject';
    default:
      return 'needs_input';
  }
}

function decisionForReviewStatus(
  status: RecordPrivateOpportunityReviewInput['humanReviewStatus'],
): string {
  switch (status) {
    case 'apply':
      return 'accept_to_apply';
    case 'archived':
      return 'archive';
    case 'maybe':
      return 'defer';
    case 'needs_input':
      // A clear is a new immutable review revision, never deletion of history.
      return 'clear_review';
    case 'reject':
      return 'reject';
  }
}

function integerRating(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
    ? value
    : null;
}

function dateRank(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  }
  return Number.NEGATIVE_INFINITY;
}

function compareCurrentDecision(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftTime = dateRank(left.createdAt ?? left.created_at);
  const rightTime = dateRank(right.createdAt ?? right.created_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(right.id ?? '').localeCompare(String(left.id ?? ''));
}

function projectReview(
  record: Record<string, unknown>,
): OpportunityReviewOverlay {
  const reviewedAt = record.createdAt ?? record.created_at;
  return {
    humanRating: integerRating(record.humanRating),
    humanReviewNotes: typeof record.reason === 'string' ? record.reason : '',
    humanReviewStatus: reviewStatus(record.decision),
    reviewedAt:
      reviewedAt instanceof Date || typeof reviewedAt === 'string'
        ? reviewedAt
        : null,
    reviewedByProfileId:
      typeof record.deciderProfileId === 'string'
        ? record.deciderProfileId
        : '',
    reviewedByUserId:
      typeof record.deciderUserId === 'string' ? record.deciderUserId : '',
  };
}

/**
 * Returns only the current private human review per requested shared-catalog
 * opportunity. The caller merges this projection onto an Opportunity row; it
 * must never persist personal review state back to that shared row.
 */
export async function loadCurrentOpportunityReviewOverlays({
  opportunityIds,
  subject,
}: LoadOpportunityReviewOverlaysInput): Promise<
  Map<string, OpportunityReviewOverlay>
> {
  const verifiedSubject = requireWorkspaceSubject(subject);
  const ids = boundedOpportunityIds(opportunityIds);
  if (ids.length === 0) return new Map();

  const records = await listPrivateRecords('Decision', verifiedSubject, {
    // SQL projections must use the same current-row definition:
    // ORDER BY created_at DESC NULLS LAST, id DESC. SMRT expects one native
    // ordering clause per array entry, rather than a comma-delimited string.
    orderBy: ['created_at DESC', 'id DESC'],
    where: { opportunityId: ids },
  });
  const byOpportunity = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const opportunityId =
      typeof record.opportunityId === 'string' ? record.opportunityId : '';
    if (!ids.includes(opportunityId)) continue;
    const current = byOpportunity.get(opportunityId);
    if (!current || compareCurrentDecision(record, current) < 0) {
      byOpportunity.set(opportunityId, record);
    }
  }
  return new Map(
    [...byOpportunity].map(([opportunityId, record]) => [
      opportunityId,
      projectReview(record),
    ]),
  );
}

/** Create a human decision with actor and workspace ownership derived from the subject. */
export async function createPrivateDecision({
  subject,
  database,
  ...payload
}: CreatePrivateDecisionInput): Promise<Record<string, unknown>> {
  const verifiedSubject = requireWorkspaceSubject(subject);
  return await createPrivateRecord(
    'Decision',
    verifiedSubject,
    {
      ...payload,
      deciderProfileId: verifiedSubject.profileId,
      deciderUserId: verifiedSubject.userId,
      opportunityId: requiredOpaqueId(payload.opportunityId, 'opportunity ID'),
    },
    { db: database },
  );
}

/**
 * Store a manual opportunity review as an immutable private Decision. Shared
 * Opportunity rows must never receive these candidate-specific fields.
 */
export async function recordPrivateOpportunityReview(
  input: RecordPrivateOpportunityReviewInput,
): Promise<Record<string, unknown>> {
  const status = input.humanReviewStatus;
  if (
    !['apply', 'archived', 'maybe', 'needs_input', 'reject'].includes(status)
  ) {
    throw new PrivateWorkspaceSubjectError(
      'Invalid opportunity review status.',
    );
  }
  return await createPrivateDecision({
    decision: decisionForReviewStatus(status),
    humanRating: input.humanRating ?? null,
    opportunityId: input.opportunityId,
    reason: input.humanReviewNotes ?? '',
    subject: input.subject,
  });
}

/** Decision tags are reachable only after their Decision proves the same subject. */
export async function createPrivateDecisionTag({
  decisionId,
  subject,
  tagId,
  tagRole,
}: CreatePrivateDecisionTagInput): Promise<Record<string, unknown>> {
  const verifiedSubject = requireWorkspaceSubject(subject);
  const parentId = requiredOpaqueId(decisionId, 'decision ID');
  const decision = await getPrivateRecord(
    'Decision',
    parentId,
    verifiedSubject,
  );
  if (!decision) {
    throw new PrivateWorkspaceSubjectError(
      'Decision is outside the current workspace.',
    );
  }
  return await createPrivateRecord('DecisionTag', verifiedSubject, {
    decisionId: parentId,
    tagId: requiredOpaqueId(tagId, 'tag ID'),
    tagRole: requiredOpaqueId(tagRole, 'tag role'),
  });
}

/** List decision tags only after authorizing their parent Decision. */
export async function listPrivateDecisionTags(input: {
  decisionId: string;
  subject: WorkspaceSubject;
}): Promise<Record<string, unknown>[]> {
  const verifiedSubject = requireWorkspaceSubject(input.subject);
  const decisionId = requiredOpaqueId(input.decisionId, 'decision ID');
  const decision = await getPrivateRecord(
    'Decision',
    decisionId,
    verifiedSubject,
  );
  if (!decision) {
    throw new PrivateWorkspaceSubjectError(
      'Decision is outside the current workspace.',
    );
  }
  return await listPrivateRecords('DecisionTag', verifiedSubject, {
    orderBy: ['created_at DESC', 'id DESC'],
    where: { decisionId },
  });
}
