import { createHash } from 'node:crypto';
import type { DecisionResult } from '@happyvertical/ai';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from './db.js';
import {
  opportunityAssessmentSubjectMaterialFingerprint,
  selectOpportunityAssessmentCandidateSources,
} from './opportunity-assessment-input.js';
import {
  OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
  type PartialOpportunityAssessmentResult,
  preparePartialOpportunityAssessment,
  resolvePartialOpportunityAssessment,
} from './opportunity-assessment-partial.js';
import {
  type PartialOpportunityRequirementEvidence,
  readPartialOpportunityRequirementEvidence,
} from './opportunity-requirement-coverage-provider.js';
import {
  listPrivateRecords,
  recordOwnedBySubject,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import {
  loadWorkspaceCandidateEvidence,
  type WorkspaceCandidateEvidence,
} from './resume-data.js';

export interface OpportunityPartialAssessmentProjection {
  version: 'opportunity-assessment-partial-projection/v1';
  mode: 'partial';
  sourceStatus: 'current';
  criterionCount: number;
  supportedCriterionCount: number;
  unresolvedSourceClauseCount: number;
  requirements: Array<{
    id: string;
    text: string;
    support: 'supported' | 'uncertain';
    postingCitations: Array<{
      excerpt: string;
      clauseId: string;
      start: number;
      end: number;
    }>;
    candidateCitations: Array<{
      sourceId: string;
      title: string;
      excerpt: string;
      recordId?: string;
      sectionId?: string;
    }>;
  }>;
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function sameSubject(left: WorkspaceSubject, right: WorkspaceSubject): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.profileId === right.profileId
  );
}

/** Fresh canonical inputs and the native GLOBAL reader authorize presentation, never cache JSON. */
export function projectCurrentPartialOpportunityAssessment(input: {
  row: Record<string, unknown>;
  opportunity: Record<string, unknown>;
  subject: WorkspaceSubject;
  candidate: WorkspaceCandidateEvidence;
  evidence: PartialOpportunityRequirementEvidence;
  decision: DecisionResult;
}): OpportunityPartialAssessmentProjection | null {
  const { row, opportunity, subject, candidate, evidence } = input;
  if (
    !recordOwnedBySubject(row, subject) ||
    !sameSubject(candidate.subject, subject) ||
    row.status !== 'partial' ||
    row.contractVersion !== OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION ||
    row.opportunityId !== opportunity.id ||
    row.matchReadiness !== 'needs_evidence' ||
    row.candidateMaterialFingerprint !== candidate.fingerprint ||
    row.sourceContentFingerprint !== opportunity.sourceContentFingerprint ||
    row.sourceContentVersion !== opportunity.sourceContentVersion ||
    evidence.context.sourceFingerprint !==
      opportunity.sourceContentFingerprint ||
    evidence.context.sourceVersion !== opportunity.sourceContentVersion
  )
    return null;
  try {
    const result = JSON.parse(
      String(row.assessmentJson),
    ) as PartialOpportunityAssessmentResult;
    if (
      result.contractVersion !== OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION ||
      result.mode !== 'partial' ||
      result.matchReadiness !== 'needs_evidence' ||
      result.fingerprint !== row.assessmentFingerprint ||
      result.candidateMaterialFingerprint !== candidate.fingerprint ||
      result.evidenceFingerprint !== evidence.fingerprint ||
      result.sourceContentFingerprint !==
        opportunity.sourceContentFingerprint ||
      result.sourceContentVersion !== opportunity.sourceContentVersion ||
      !result.provenance ||
      typeof result.provenance.model !== 'string' ||
      !result.provenance.model ||
      typeof result.provenance.provider !== 'string' ||
      !result.provenance.provider ||
      !result.answerProbabilities ||
      typeof result.answerProbabilities !== 'object' ||
      Array.isArray(result.answerProbabilities)
    )
      return null;
    const sources = selectOpportunityAssessmentCandidateSources(
      candidate.evidence,
      [],
    );
    const prepared = preparePartialOpportunityAssessment({
      opportunityId: String(opportunity.id),
      evidence,
      candidateSources: sources.sources,
      candidateMaterialFingerprint: candidate.fingerprint,
      candidateCoverageTruncated: sources.truncated,
    });
    if (prepared.fingerprint !== result.fingerprint) return null;
    const canonical = resolvePartialOpportunityAssessment(
      prepared,
      input.decision,
      evidence,
    );
    if (
      hash(canonical.answerProbabilities) !==
        hash(result.answerProbabilities) ||
      hash(canonical.provenance) !== hash(result.provenance)
    )
      return null;
    if (
      hash(canonical.requirements) !== hash(result.requirements) ||
      hash(canonical.sourceCatalog) !== hash(result.sourceCatalog) ||
      hash(canonical.unresolvedClauses) !== hash(result.unresolvedClauses)
    )
      return null;
    const requirements = canonical.requirements.map((row) => {
      const requirement = prepared.requirements.find(
        (item) => item.id === row.id,
      )!;
      const sourceRequirement = evidence.acceptedRequirements.find(
        (item) => `${opportunity.id}:partial:${item.id}` === row.id,
      )!;
      return {
        id: row.id,
        text: requirement.text,
        support: row.support,
        postingCitations: sourceRequirement.clauseIds.map((id) => {
          const clause = evidence.ledger.clauses.find(
            (item) => item.id === id,
          )!;
          if (
            evidence.context.sourceText.slice(
              clause.spanStart,
              clause.spanEnd,
            ) !== clause.text
          )
            throw new Error('Changed literal source citation');
          return {
            excerpt: clause.text,
            clauseId: clause.id,
            start: clause.spanStart,
            end: clause.spanEnd,
          };
        }),
        candidateCitations: row.candidateSourceKeys.map((key) => {
          const citation = canonical.sourceCatalog.find(
            (item) => item.key === key,
          )!;
          const source = sources.sources.find(
            (item) => item.id === citation.sourceId,
          )!;
          return {
            sourceId: source.id,
            title: source.title,
            excerpt: source.text,
            ...(source.recordId ? { recordId: source.recordId } : {}),
            ...(source.sectionId ? { sectionId: source.sectionId } : {}),
          };
        }),
      };
    });
    return {
      version: 'opportunity-assessment-partial-projection/v1',
      mode: 'partial',
      sourceStatus: 'current',
      criterionCount: requirements.length,
      supportedCriterionCount: requirements.filter(
        (row) => row.support === 'supported',
      ).length,
      unresolvedSourceClauseCount: canonical.unresolvedClauses.length,
      requirements,
    };
  } catch {
    return null;
  }
}

type ReceiptDatabase = {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows?: Record<string, unknown>[] }>;
};

/** The result locator selects an actual private receipt; it never authorizes cached answers. */
export async function readRecordedPartialOpportunityAssessment(
  input: {
    row: Record<string, unknown>;
    opportunity: Record<string, unknown>;
    subject: WorkspaceSubject;
    candidate: WorkspaceCandidateEvidence;
    evidence: PartialOpportunityRequirementEvidence;
  },
  database?: ReceiptDatabase,
): Promise<DecisionResult | undefined> {
  try {
    const result = JSON.parse(
      String(input.row.assessmentJson),
    ) as PartialOpportunityAssessmentResult;
    if (
      typeof result.requestId !== 'string' ||
      !result.requestId ||
      !input.row.agentRunId ||
      !recordOwnedBySubject(input.row, input.subject)
    )
      return undefined;
    const sources = selectOpportunityAssessmentCandidateSources(
      input.candidate.evidence,
      [],
    );
    const prepared = preparePartialOpportunityAssessment({
      opportunityId: String(input.opportunity.id),
      evidence: input.evidence,
      candidateSources: sources.sources,
      candidateMaterialFingerprint: input.candidate.fingerprint,
      candidateCoverageTruncated: sources.truncated,
    });
    const subjectFingerprint = opportunityAssessmentSubjectMaterialFingerprint({
      candidateMaterialFingerprint: input.candidate.fingerprint,
      sourceContentFingerprint: input.evidence.context.sourceFingerprint,
      sourceContentVersion: input.evidence.context.sourceVersion,
      requirementCoverageFingerprint: input.evidence.fingerprint,
      subject: input.subject,
    });
    const inputFingerprint = hash({
      prepared: prepared.fingerprint,
      subject: subjectFingerprint,
    });
    if (
      result.fingerprint !== prepared.fingerprint ||
      result.inputFingerprint !== inputFingerprint
    )
      return undefined;
    const db = database ?? (await resolveDatabase(getDbConfig()));
    const found = await db.query(
      `SELECT r.owner_request_id, r.output_json, r.opportunity_id, r.agent_run_id,
      r.content_fingerprint, r.input_fingerprint, r.feature, r.output_schema_version, r.prompt_version,
      r.prepared_payload_version, r.status AS result_status, r.profile, r.model,
      r.tenant_id, r.owner_user_id, r.candidate_profile_id,
      q.request_id, q.status AS request_status, q.accounting_basis, q.actual_total_tokens,
      q.tenant_id AS request_tenant_id, q.owner_user_id AS request_owner_user_id,
      q.candidate_profile_id AS request_candidate_profile_id
      FROM opportunity_intelligence_results r JOIN opportunity_intelligence_requests q
      ON q.request_id = r.owner_request_id AND q.idempotency_key = r.idempotency_key
      AND q.opportunity_id = r.opportunity_id AND q.agent_run_id = r.agent_run_id
      AND q.content_fingerprint = r.content_fingerprint AND q.input_fingerprint = r.input_fingerprint
      AND q.feature = r.feature AND q.profile = r.profile AND q.model = r.model
      WHERE r.owner_request_id = ? AND r.opportunity_id = ? AND r.agent_run_id = ?
      AND r.content_fingerprint = ? AND r.input_fingerprint = ?
      AND r.feature = 'opportunity-assessment-partial' AND r.profile = 'typesafe-opportunity-assessment-partial'
      AND r.output_schema_version = ? AND r.prompt_version = r.output_schema_version
      AND r.prepared_payload_version = r.output_schema_version
      AND r.tenant_id = ? AND r.owner_user_id = ? AND r.candidate_profile_id = ?
      AND q.tenant_id = r.tenant_id AND q.owner_user_id = r.owner_user_id AND q.candidate_profile_id = r.candidate_profile_id
      AND r.status = 'completed' AND q.status = 'succeeded' AND q.accounting_basis = 'actual'
      AND q.actual_total_tokens > 0 LIMIT 2`,
      [
        result.requestId,
        input.opportunity.id,
        input.row.agentRunId,
        input.evidence.context.sourceFingerprint,
        inputFingerprint,
        OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
        input.subject.tenantId,
        input.subject.userId,
        input.subject.profileId,
      ],
    );
    if (found.rows?.length !== 1) return undefined;
    const row = found.rows[0];
    if (
      row.owner_request_id !== result.requestId ||
      row.request_id !== result.requestId ||
      row.opportunity_id !== input.opportunity.id ||
      row.agent_run_id !== input.row.agentRunId ||
      row.content_fingerprint !== input.evidence.context.sourceFingerprint ||
      row.input_fingerprint !== inputFingerprint ||
      row.feature !== 'opportunity-assessment-partial' ||
      row.profile !== 'typesafe-opportunity-assessment-partial' ||
      row.output_schema_version !== OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION ||
      row.prompt_version !== OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION ||
      row.prepared_payload_version !== OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION ||
      row.result_status !== 'completed' ||
      row.request_status !== 'succeeded' ||
      row.accounting_basis !== 'actual' ||
      !Number.isSafeInteger(Number(row.actual_total_tokens)) ||
      Number(row.actual_total_tokens) <= 0 ||
      row.model !== result.provenance.model ||
      row.tenant_id !== input.subject.tenantId ||
      row.request_tenant_id !== input.subject.tenantId ||
      row.owner_user_id !== input.subject.userId ||
      row.request_owner_user_id !== input.subject.userId ||
      row.candidate_profile_id !== input.subject.profileId ||
      row.request_candidate_profile_id !== input.subject.profileId
    )
      return undefined;
    const decision = JSON.parse(String(row.output_json)) as DecisionResult;
    resolvePartialOpportunityAssessment(prepared, decision, input.evidence);
    return decision;
  } catch {
    return undefined;
  }
}

/** Owned, reload-safe private projection; this read path never enqueues or invokes a provider. */
export async function loadCurrentPartialOpportunityAssessmentProjections(input: {
  opportunities: Record<string, unknown>[];
  subject: WorkspaceSubject;
}): Promise<Map<string, OpportunityPartialAssessmentProjection>> {
  const subject = requireWorkspaceSubject(input.subject);
  const opportunities = new Map(
    input.opportunities
      .filter((row) => typeof row.id === 'string' && row.id)
      .map((row) => [String(row.id), row]),
  );
  if (!opportunities.size) return new Map();
  const rows = await listPrivateRecords('OpportunityAssessment', subject, {
    where: {
      'opportunityId in': [...opportunities.keys()],
      status: 'partial',
      contractVersion: OPPORTUNITY_ASSESSMENT_PARTIAL_VERSION,
    },
    orderBy: 'updated_at DESC',
  });
  if (!rows.length) return new Map();
  const candidate = await loadWorkspaceCandidateEvidence(subject);
  const projections = new Map<string, OpportunityPartialAssessmentProjection>();
  const evidenceByOpportunity = new Map<
    string,
    PartialOpportunityRequirementEvidence | undefined
  >();
  for (const row of rows) {
    const id = String(row.opportunityId ?? '');
    const opportunity = opportunities.get(id);
    if (
      !opportunity ||
      projections.has(id) ||
      !recordOwnedBySubject(row, subject)
    )
      continue;
    if (!evidenceByOpportunity.has(id))
      evidenceByOpportunity.set(
        id,
        await readPartialOpportunityRequirementEvidence(opportunity),
      );
    const evidence = evidenceByOpportunity.get(id);
    if (!evidence) continue;
    const decision = await readRecordedPartialOpportunityAssessment({
      row,
      opportunity,
      subject,
      candidate,
      evidence,
    });
    if (!decision) continue;
    const projection = projectCurrentPartialOpportunityAssessment({
      row,
      opportunity,
      subject,
      candidate,
      evidence,
      decision,
    });
    if (projection) projections.set(id, projection);
  }
  return projections;
}
