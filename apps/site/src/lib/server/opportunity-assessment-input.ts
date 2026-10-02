import { createHash } from 'node:crypto';
import {
  OPPORTUNITY_ASSESSMENT_MAX_SOURCE_TEXT,
  type OpportunityAssessmentRequirement,
  type OpportunityAssessmentSource,
} from './opportunity-assessment.js';

const DESCRIPTION_SCAN_LIMIT = OPPORTUNITY_ASSESSMENT_MAX_SOURCE_TEXT * 58;

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

function scalarSource(
  opportunityId: string,
  field: string,
  value: unknown,
): OpportunityAssessmentSource | undefined {
  const body = Array.isArray(value) ? textList(value).join(', ') : text(value);
  if (!body) return undefined;
  return {
    id: `${opportunityId}:00-field:${field}`,
    kind: 'posting_field',
    text: `${field}: ${body}`,
    title: field,
  };
}

/**
 * Retains role-specific structured clauses first, then scans the full bounded
 * raw posting in exact chunks. The final coverage sentinel is never evidence:
 * it tells the assessment contract that source text was truncated.
 */
export function buildOpportunityAssessmentPostingInput(
  opportunity: Record<string, unknown>,
): {
  postingSources: OpportunityAssessmentSource[];
  requirements: OpportunityAssessmentRequirement[];
} {
  const opportunityId = text(opportunity.id) || 'opportunity';
  const sources = [
    'title',
    'workMode',
    'locations',
    'locationNotes',
    'employmentType',
    'seniority',
    'visaOrEorPossible',
    'relocationSupported',
    'applyInstructions',
  ]
    .map((field) => scalarSource(opportunityId, field, opportunity[field]))
    .filter((source): source is OpportunityAssessmentSource => Boolean(source));
  const raw =
    text(opportunity.descriptionRaw) || text(opportunity.descriptionSummary);
  const scanned = raw.slice(0, DESCRIPTION_SCAN_LIMIT);
  // Scan every byte of the bounded posting for country/authorization language
  // before adding generic excerpts. This keeps contradictory role clauses in
  // the request even when a long description would otherwise crowd them out.
  const materialTerms =
    /\b(?:canada|united states|u\.?s\.?|visa|sponsor(?:ship)?|work authorization|eligible to work|remote)\b/giu;
  const usedPassages = new Set<number>();
  for (const match of scanned.matchAll(materialTerms)) {
    const index = match.index ?? 0;
    const offset = Math.max(0, index - 120);
    if (usedPassages.has(offset)) continue;
    usedPassages.add(offset);
    const passage = scanned.slice(
      offset,
      offset + OPPORTUNITY_ASSESSMENT_MAX_SOURCE_TEXT,
    );
    sources.push({
      id: `${opportunityId}:01-signal:${offset}`,
      kind: 'posting_material_clause',
      sourceLineStart: offset,
      sourceLineEnd: offset + passage.length,
      text: passage,
      title: 'Location or authorization clause',
    });
  }
  for (
    let offset = 0;
    offset < Math.min(raw.length, DESCRIPTION_SCAN_LIMIT);
    offset += OPPORTUNITY_ASSESSMENT_MAX_SOURCE_TEXT
  ) {
    const passage = raw.slice(
      offset,
      offset + OPPORTUNITY_ASSESSMENT_MAX_SOURCE_TEXT,
    );
    if (!passage) continue;
    sources.push({
      id: `${opportunityId}:10-description:${offset}`,
      kind: 'posting_description',
      sourceLineStart: offset,
      sourceLineEnd: offset + passage.length,
      text: passage,
      title: 'Posting description',
    });
  }
  if (raw.length > DESCRIPTION_SCAN_LIMIT) {
    sources.push({
      // This intentionally exceeds the excerpt limit so `prepareSources()`
      // records coverage loss without asking JEV to use the sentinel.
      id: `${opportunityId}:99-coverage:description`,
      kind: 'coverage',
      text: raw,
      title: 'Posting source coverage',
    });
  }
  const requirements = [
    ...textList(opportunity.requiredSkills).map((value, index) => ({
      id: `${opportunityId}:required:${index}`,
      text: value,
    })),
    ...textList(opportunity.preferredSkills).map((value, index) => ({
      id: `${opportunityId}:preferred:${index}`,
      text: value,
    })),
  ];
  return { postingSources: sources, requirements };
}

export function normalizeOpportunityAssessmentCandidateSources(
  sources: Array<{ id: unknown; kind: unknown; text: unknown; title: unknown }>,
): OpportunityAssessmentSource[] {
  return sources
    .map((source) => ({
      id: text(source.id),
      kind: text(source.kind) || 'candidate_evidence',
      text: text(source.text),
      title: text(source.title) || 'Candidate evidence',
    }))
    .filter((source) => source.id && source.text);
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
