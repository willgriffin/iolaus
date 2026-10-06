import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import {
  OPPORTUNITY_RECOMMENDATION_RANK_VERSION,
  type OpportunityRecommendationAssessmentCompleteness,
  type OpportunityRecommendationRank,
} from '../objects/OpportunityRecommendationRank.js';
import { getDbConfig } from './db.js';
import {
  OPPORTUNITY_QUESTION_SCREENING_MODEL,
  OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION,
  OPPORTUNITY_QUESTION_SCREENING_VERSION,
} from './opportunity-question-screening.js';
import {
  privateRecordWhere,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getCollection } from './smrt.js';

type PinnedDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

export interface VerifiedOpportunityRecommendationRankPublication {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly candidateProfileId: string;
  readonly opportunityId: string;
  readonly recommendationPercent: number | null;
  readonly evidenceCoveragePercent: number | null;
  readonly mustHaveConflictCount: number;
  readonly assessmentCompleteness: OpportunityRecommendationAssessmentCompleteness;
  readonly sourceContentFingerprint: string;
  readonly sourceContentVersion: number;
  readonly candidateMaterialFingerprint: string;
  readonly questionSetFingerprint: string;
  readonly requiredSkillsSnapshot: string;
  readonly preferredSkillsSnapshot: string;
  readonly contractVersion: string;
  readonly model: string;
  readonly assessmentId: string;
  readonly intelligenceRequestId: string;
  readonly intelligenceResultId: string;
  readonly agentRunId: string;
  readonly assessmentFingerprint: string;
  readonly proofFinishedAt: Date;
  readonly projectionVersion?: typeof OPPORTUNITY_RECOMMENDATION_RANK_VERSION;
}

export type SaveVerifiedOpportunityRecommendationRankResult = {
  rank: OpportunityRecommendationRank;
  status: 'created' | 'ignored' | 'updated';
};

export type OwnedOpportunityRecommendationRankRow = {
  id: string;
  tenantId: string;
  ownerUserId: string;
  candidateProfileId: string;
  opportunityId: string;
  recommendationPercent: number | null;
  evidenceCoveragePercent: number | null;
  mustHaveConflictCount: number;
  assessmentCompleteness: OpportunityRecommendationAssessmentCompleteness;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  candidateMaterialFingerprint: string;
  questionSetFingerprint: string;
  requiredSkillsSnapshot: string;
  preferredSkillsSnapshot: string;
  contractVersion: string;
  model: string;
  projectionVersion: string;
  assessmentId: string;
  intelligenceRequestId: string;
  intelligenceResultId: string;
  agentRunId: string;
  assessmentFingerprint: string;
  proofFinishedAt: Date;
};

export class OpportunityRecommendationRankPublicationError extends Error {}

/**
 * Keep the raw requirement text byte-for-byte: query currentness compares the
 * stored value to `COALESCE(opportunity.required_skills, '')`. Arrays exist
 * only in fixture adapters and are made deterministic for those callers.
 */
export function normalizeOpportunityRecommendationRankSkillsSnapshot(
  value: unknown,
): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  throw new OpportunityRecommendationRankPublicationError(
    'Verified recommendation rank requires a raw skill snapshot string.',
  );
}

function nonBlank(value: string, label: string): string {
  if (!value || value !== value.trim() || value.length > 500)
    throw new OpportunityRecommendationRankPublicationError(
      `Verified recommendation rank requires ${label}.`,
    );
  return value;
}

function integer(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new OpportunityRecommendationRankPublicationError(
      `Verified recommendation rank has an invalid ${label}.`,
    );
  return value;
}

function percentage(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new OpportunityRecommendationRankPublicationError(
      `Verified recommendation rank has an invalid ${label}.`,
    );
  return value;
}

function validate(
  publication: VerifiedOpportunityRecommendationRankPublication,
): VerifiedOpportunityRecommendationRankPublication {
  for (const [value, label] of [
    [publication.tenantId, 'tenant ID'],
    [publication.ownerUserId, 'owner user ID'],
    [publication.candidateProfileId, 'candidate profile ID'],
    [publication.opportunityId, 'opportunity ID'],
    [publication.sourceContentFingerprint, 'source fingerprint'],
    [publication.candidateMaterialFingerprint, 'candidate fingerprint'],
    [publication.questionSetFingerprint, 'question set fingerprint'],
    [publication.contractVersion, 'contract version'],
    [publication.model, 'model'],
    [publication.assessmentId, 'assessment ID'],
    [publication.intelligenceRequestId, 'request ID'],
    [publication.intelligenceResultId, 'result ID'],
    [publication.agentRunId, 'agent run ID'],
    [publication.assessmentFingerprint, 'assessment fingerprint'],
  ] as const)
    nonBlank(value, label);
  for (const [value, label] of [
    [publication.requiredSkillsSnapshot, 'required skills snapshot'],
    [publication.preferredSkillsSnapshot, 'preferred skills snapshot'],
  ] as const) {
    if (typeof value !== 'string' || value.length > 100_000)
      throw new OpportunityRecommendationRankPublicationError(
        `Verified recommendation rank has an invalid ${label}.`,
      );
  }
  percentage(publication.recommendationPercent, 'recommendation percentage');
  percentage(
    publication.evidenceCoveragePercent,
    'evidence coverage percentage',
  );
  integer(publication.mustHaveConflictCount, 'must-have conflict count');
  integer(publication.sourceContentVersion, 'source version', 1);
  if (
    publication.assessmentCompleteness !== 'full' &&
    publication.assessmentCompleteness !== 'title_only'
  )
    throw new OpportunityRecommendationRankPublicationError(
      'Verified recommendation rank has an invalid assessment completeness.',
    );
  if (
    publication.projectionVersion !== undefined &&
    publication.projectionVersion !== OPPORTUNITY_RECOMMENDATION_RANK_VERSION
  )
    throw new OpportunityRecommendationRankPublicationError(
      'Verified recommendation rank has an unsupported projection version.',
    );
  if (
    publication.contractVersion !== OPPORTUNITY_QUESTION_SCREENING_VERSION &&
    publication.contractVersion !==
      OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION
  )
    throw new OpportunityRecommendationRankPublicationError(
      'Verified recommendation rank has an unsupported assessment contract.',
    );
  if (publication.model !== OPPORTUNITY_QUESTION_SCREENING_MODEL)
    throw new OpportunityRecommendationRankPublicationError(
      'Verified recommendation rank has an unsupported assessment model.',
    );
  if (
    !(publication.proofFinishedAt instanceof Date) ||
    Number.isNaN(publication.proofFinishedAt.getTime())
  )
    throw new OpportunityRecommendationRankPublicationError(
      'Verified recommendation rank requires a completed proof timestamp.',
    );
  return publication;
}

function semanticContextMatches(
  rank: OpportunityRecommendationRank,
  publication: VerifiedOpportunityRecommendationRankPublication,
): boolean {
  return (
    rank.sourceContentFingerprint === publication.sourceContentFingerprint &&
    rank.sourceContentVersion === publication.sourceContentVersion &&
    rank.candidateMaterialFingerprint ===
      publication.candidateMaterialFingerprint &&
    rank.questionSetFingerprint === publication.questionSetFingerprint &&
    rank.requiredSkillsSnapshot === publication.requiredSkillsSnapshot &&
    rank.preferredSkillsSnapshot === publication.preferredSkillsSnapshot &&
    supportedSemanticContract(rank.contractVersion) &&
    supportedSemanticContract(publication.contractVersion) &&
    rank.model === publication.model &&
    rank.projectionVersion === OPPORTUNITY_RECOMMENDATION_RANK_VERSION
  );
}

function supportedSemanticContract(value: string): boolean {
  return (
    value === OPPORTUNITY_QUESTION_SCREENING_VERSION ||
    value === OPPORTUNITY_QUESTION_SCREENING_OVERFLOW_VERSION
  );
}

function shouldReplace(
  rank: OpportunityRecommendationRank,
  publication: VerifiedOpportunityRecommendationRankPublication,
): boolean {
  // Changed material is re-validated at the coordinator's final authority
  // fence. Allow it to repair a return to an older, now-current receipt;
  // proof ordering arbitrates only one semantic context.
  if (!semanticContextMatches(rank, publication)) return true;
  if (
    rank.assessmentCompleteness === 'full' &&
    publication.assessmentCompleteness === 'title_only'
  )
    return false;
  if (
    rank.assessmentCompleteness === 'title_only' &&
    publication.assessmentCompleteness === 'full'
  )
    return true;
  const prior = rank.proofFinishedAt.getTime();
  const next = publication.proofFinishedAt.getTime();
  if (next > prior) return true;
  if (next < prior) return false;
  return false;
}

function assign(
  rank: OpportunityRecommendationRank,
  publication: VerifiedOpportunityRecommendationRankPublication,
): void {
  Object.assign(rank, {
    ...publication,
    projectionVersion: OPPORTUNITY_RECOMMENDATION_RANK_VERSION,
  });
}

async function ranks(database: PinnedDatabase) {
  return await getCollection<OpportunityRecommendationRank>(
    'OpportunityRecommendationRank',
    { db: database as never },
  );
}

/** One page-bounded, owner-tuple scoped native read; callers verify receipts. */
export async function listOwnedOpportunityRecommendationRanks(
  subject: WorkspaceSubject,
  opportunityIds: readonly string[],
  options: { db?: PinnedDatabase } = {},
): Promise<OwnedOpportunityRecommendationRankRow[]> {
  const owned = requireWorkspaceSubject(subject);
  const ids = [...new Set(opportunityIds)];
  if (ids.length === 0) return [];
  if (ids.length > 200)
    throw new OpportunityRecommendationRankPublicationError(
      'Recommendation rank lookup accepts at most 200 opportunity IDs.',
    );
  for (const id of ids) nonBlank(id, 'opportunity ID');
  const collection = await ranks(
    options.db ?? (await resolveDatabase(getDbConfig())),
  );
  const rows = await collection.list({
    where: { ...privateRecordWhere(owned), 'opportunityId in': ids },
    cache: false,
  });
  return rows.map(
    (rank) => rank.toJSON() as unknown as OwnedOpportunityRecommendationRankRow,
  );
}

function ownerWhere(
  publication: VerifiedOpportunityRecommendationRankPublication,
) {
  return {
    tenantId: publication.tenantId,
    ownerUserId: publication.ownerUserId,
    candidateProfileId: publication.candidateProfileId,
    opportunityId: publication.opportunityId,
  };
}

/**
 * The caller supplies a short pinned transaction. PostgreSQL needs a tuple
 * lock around insert-only creation because a unique-constraint exception
 * aborts its enclosing transaction before a retry can re-read the row.
 * SQLite serializes writes on its single connection.
 */
async function lockOwnerTuple(
  database: PinnedDatabase,
  publication: VerifiedOpportunityRecommendationRankPublication,
): Promise<void> {
  if (!database.url || detectEngine(database.url) !== 'postgres') return;
  await database.query('SELECT pg_advisory_xact_lock(hashtext(?))', [
    JSON.stringify([
      publication.tenantId,
      publication.ownerUserId,
      publication.candidateProfileId,
      publication.opportunityId,
    ]),
  ]);
}

/**
 * Stores only data already verified by the caller at its final authority and
 * receipt fence. The supplied executor must be the caller's active native
 * transaction; this function intentionally cannot derive authority from JSON.
 */
export async function saveVerifiedOpportunityRecommendationRank(
  database: PinnedDatabase,
  verifiedPublication: VerifiedOpportunityRecommendationRankPublication,
): Promise<SaveVerifiedOpportunityRecommendationRankResult> {
  const publication = validate(verifiedPublication);
  const collection = await ranks(database);
  await lockOwnerTuple(database, publication);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await collection.list({
      where: ownerWhere(publication),
      cache: false,
    });
    if (existing.length > 1)
      throw new OpportunityRecommendationRankPublicationError(
        'Recommendation rank owner tuple is ambiguous.',
      );
    const rank = existing[0];
    if (!rank) {
      try {
        const created = await collection.create({
          ...publication,
          projectionVersion: OPPORTUNITY_RECOMMENDATION_RANK_VERSION,
          _insertOnly: true,
        });
        return { rank: created, status: 'created' };
      } catch (cause) {
        if (attempt === 2) throw cause;
        continue;
      }
    }
    if (!shouldReplace(rank, publication)) return { rank, status: 'ignored' };
    const expectedUpdatedAt = rank.updated_at;
    if (!expectedUpdatedAt)
      throw new OpportunityRecommendationRankPublicationError(
        'Persisted recommendation rank has no revision timestamp.',
      );
    assign(rank, publication);
    try {
      await rank.save({ expectedUpdatedAt });
      return { rank, status: 'updated' };
    } catch (cause) {
      if (attempt === 2) throw cause;
    }
  }
  throw new OpportunityRecommendationRankPublicationError(
    'Recommendation rank publication could not acquire a revision.',
  );
}
