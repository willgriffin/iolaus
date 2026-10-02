import { createHash } from 'node:crypto';
import {
  OPPORTUNITY_ASSESSMENT_INPUT_PACK_VERSION,
  type OpportunityAssessmentRequirement,
  type OpportunityAssessmentSource,
} from './opportunity-assessment.js';

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
  const raw = text(opportunity.descriptionRaw);
  const description = raw || text(opportunity.descriptionSummary);
  if (description)
    postingSources.push({
      id: `${opportunityId}:description`,
      kind: 'posting_description',
      text: description,
      title: raw ? 'Full posting' : 'Posting summary (partial)',
    });
  const requirements: OpportunityAssessmentRequirement[] = [];
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
  subject: { profileId: string; tenantId: string; userId: string };
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        inputPackVersion: OPPORTUNITY_ASSESSMENT_INPUT_PACK_VERSION,
        candidateMaterialFingerprint: input.candidateMaterialFingerprint,
        sourceContentFingerprint: input.sourceContentFingerprint,
        sourceContentVersion: input.sourceContentVersion,
        subject: {
          profileId: input.subject.profileId,
          tenantId: input.subject.tenantId,
          userId: input.subject.userId,
        },
      }),
    )
    .digest('hex');
}
