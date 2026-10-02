import { createHash } from 'node:crypto';
import {
  OPPORTUNITY_ASSESSMENT_INPUT_PACK_VERSION,
  type OpportunityAssessmentRequirement,
  type OpportunityAssessmentSource,
} from './opportunity-assessment.js';
import {
  type CoverageLedger,
  type RequirementCoverageContext,
  requirementCoverageContextForOpportunity,
} from './opportunity-requirement-coverage.js';
import { validateVerifiedRequirementCoverage } from './opportunity-requirement-coverage-provider.js';

export { readVerifiedOpportunityRequirementCoverage } from './opportunity-requirement-coverage-provider.js';

/** Only the current native source cache can satisfy the private prerequisite. */
export function verifiedOpportunityRequirementCoverage(
  opportunity: Record<string, unknown>,
): { ledger: CoverageLedger; fingerprint: string } | undefined {
  try {
    const prepared: unknown = JSON.parse(text(opportunity.preparedPostingJson));
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      !('requirementCoverage' in prepared)
    )
      return undefined;
    const ledger = prepared.requirementCoverage as CoverageLedger;
    const result = validateVerifiedRequirementCoverage(
      requirementCoverageContextForOpportunity(opportunity),
      ledger,
    );
    return result.complete && result.fingerprint
      ? { ledger, fingerprint: result.fingerprint }
      : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : typeof value === 'string'
      ? value
          .split(/[\n,;]+/u)
          .map(text)
          .filter(Boolean)
      : [];
}

/** Full raw posting plus atomic structured fields; no redundant signal excerpts. */
export function buildOpportunityAssessmentPostingInput(
  opportunity: Record<string, unknown>,
  verified?: {
    ledger: CoverageLedger;
    fingerprint: string;
    context?: RequirementCoverageContext;
  },
): {
  postingSources: OpportunityAssessmentSource[];
  postingCoverageTruncated: boolean;
  requirements: OpportunityAssessmentRequirement[];
} {
  const opportunityId = text(opportunity.id) || 'opportunity';
  const postingSources: OpportunityAssessmentSource[] = [];
  for (const field of [
    'title',
    'workMode',
    'locations',
    'locationNotes',
    'employmentType',
    'seniority',
    'visaOrEorPossible',
    'relocationSupported',
    'applyInstructions',
  ]) {
    const value = opportunity[field];
    const body = Array.isArray(value)
      ? textList(value).join(', ')
      : text(value);
    if (body)
      postingSources.push({
        id: `${opportunityId}:field:${field}`,
        kind: 'posting_field',
        text: `${field}: ${body}`,
        title: field,
      });
  }
  const raw = verified
    ? (
        verified.context ??
        requirementCoverageContextForOpportunity(opportunity)
      ).sourceText
    : text(opportunity.descriptionRaw);
  const description = raw || text(opportunity.descriptionSummary);
  if (description)
    postingSources.push({
      id: `${opportunityId}:description`,
      kind: 'posting_description',
      text: description,
      title: raw ? 'Full posting' : 'Posting summary (partial)',
    });
  const requirements: OpportunityAssessmentRequirement[] = [];
  if (verified) {
    const candidateCriterionIds = new Set(
      verified.ledger.dispositions
        .filter(
          (row) =>
            row.type !== 'source_context' && row.type !== 'nonrequirement',
        )
        .flatMap((row) => row.requirementIds),
    );
    // Exact context clauses already occur in the full posting. Preserve their
    // canonical attribution on that source instead of sending duplicate text.
    const descriptionSource = postingSources.find(
      (source) => source.kind === 'posting_description',
    );
    if (descriptionSource) {
      descriptionSource.sourceSpans = verified.ledger.dispositions
        .filter((row) => row.type === 'source_context')
        .map((disposition) => {
          const clause = verified.ledger.clauses.find(
            (row) => row.id === disposition.clauseId,
          )!;
          return {
            clauseId: clause.id,
            start: clause.spanStart,
            end: clause.spanEnd,
            hash: clause.hash,
          };
        });
    }
    for (const requirement of verified.ledger.requirements) {
      if (!candidateCriterionIds.has(requirement.id)) continue;
      const importance = verified.ledger.audit!.importance[requirement.id]!;
      const id = `${opportunityId}:coverage:${requirement.id}`;
      const clauses = requirement.clauseIds.map(
        (clauseId) =>
          verified.ledger.clauses.find((clause) => clause.id === clauseId)!,
      );
      postingSources.push({
        id,
        kind: 'posting_requirement',
        text:
          importance === 'unknown'
            ? requirement.text
            : `${importance}: ${requirement.text}`,
        title: 'Lossless role statement',
        recordId: opportunityId,
        sourceSpans: clauses.map((clause) => ({
          clauseId: clause.id,
          start: clause.spanStart,
          end: clause.spanEnd,
          hash: clause.hash,
        })),
      });
      requirements.push({
        id,
        text: requirement.text,
        postingSourceIds: [id],
        auditedImportance: importance,
      });
    }
    return { postingSources, requirements, postingCoverageTruncated: !raw };
  }
  for (const [field, importance] of [
    ['requiredSkills', 'required'],
    ['preferredSkills', 'preferred'],
  ] as const) {
    for (const [index, value] of textList(opportunity[field]).entries()) {
      const id = `${opportunityId}:${importance}:${index}`;
      postingSources.push({
        id,
        kind: 'posting_requirement',
        text: `${importance}: ${value}`,
        title: `${importance} requirement`,
      });
      requirements.push({ id, text: value, postingSourceIds: [id] });
    }
  }
  // Full-role coverage includes qualifications and duties, not only taxonomy
  // skills. Preserve commas inside each clause and its extracted-field identity.
  for (const [field, kind, title] of [
    ['qualifications', 'qualification', 'Role qualification'],
    ['responsibilities', 'responsibility', 'Role responsibility'],
  ] as const) {
    for (const [index, statement] of text(opportunity[field])
      .split(/\r?\n|;\s+/u)
      .map(text)
      .filter(Boolean)
      .entries()) {
      const id = `${opportunityId}:${kind}:${index}`;
      postingSources.push({
        id,
        kind: 'posting_requirement',
        text: statement,
        title,
      });
      requirements.push({ id, text: statement, postingSourceIds: [id] });
    }
  }
  return { postingSources, requirements, postingCoverageTruncated: !raw };
}

export interface SelectedOpportunityAssessmentCandidateSources {
  /** Only invalid/missing semantic source content marks the complete catalog partial. */
  truncated: boolean;
  sources: OpportunityAssessmentSource[];
}

export function normalizeOpportunityAssessmentCandidateSources(
  sources: Array<{
    id: unknown;
    kind: unknown;
    text: unknown;
    title: unknown;
    sectionId?: unknown;
    recordId?: unknown;
  }>,
): OpportunityAssessmentSource[] {
  return sources
    .map((source) => ({
      id: text(source.id),
      kind: text(source.kind) || 'candidate_evidence',
      text: text(source.text),
      title: text(source.title) || 'Candidate evidence',
      ...(text(source.sectionId) ? { sectionId: text(source.sectionId) } : {}),
      ...(text(source.recordId) ? { recordId: text(source.recordId) } : {}),
    }))
    .filter((source) => source.id && source.text);
}

/**
 * The catalog is complete, independent of requirement keywords. Question choice
 * scoping happens later; it must never erase semantic evidence from state.
 */
export function selectOpportunityAssessmentCandidateSources(
  sources: Array<{
    id: unknown;
    kind: unknown;
    text: unknown;
    title: unknown;
    sectionId?: unknown;
    recordId?: unknown;
  }>,
  _requirements: OpportunityAssessmentRequirement[],
): SelectedOpportunityAssessmentCandidateSources {
  const normalized = normalizeOpportunityAssessmentCandidateSources(sources);
  return {
    sources: normalized,
    truncated: normalized.length !== sources.length,
  };
}

/**
 * Private candidate/posting material identity for queue idempotence. It never
 * belongs on the global Opportunity row and includes the canonical ownership
 * tuple so identical resumes from two users cannot share a job or score.
 */
export function opportunityAssessmentSubjectMaterialFingerprint(input: {
  candidateMaterialFingerprint: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  requirementCoverageFingerprint?: string;
  subject: { profileId: string; tenantId: string; userId: string };
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        inputPackVersion: OPPORTUNITY_ASSESSMENT_INPUT_PACK_VERSION,
        candidateMaterialFingerprint: input.candidateMaterialFingerprint,
        sourceContentFingerprint: input.sourceContentFingerprint,
        sourceContentVersion: input.sourceContentVersion,
        ...(input.requirementCoverageFingerprint
          ? {
              requirementCoverageFingerprint:
                input.requirementCoverageFingerprint,
            }
          : {}),
        subject: {
          profileId: input.subject.profileId,
          tenantId: input.subject.tenantId,
          userId: input.subject.userId,
        },
      }),
    )
    .digest('hex');
}
