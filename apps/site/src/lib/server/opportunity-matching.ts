import { createHash } from 'node:crypto';
import {
  matchPublicSkills,
  type PublicMatchOpportunity,
} from './public-search/match.js';
import { loadWorkspaceCandidateEvidence } from './resume-data.js';
import { getCollection } from './smrt.js';
import {
  requireCandidateWorkspaceSubject,
  type WorkspaceSubject,
} from './workspace-subject.js';

export const OPPORTUNITY_MATCH_VERSION = 'opportunity-match/v1';
export const MAX_STAGE_THREE_POSTINGS = 25;

export type OpportunityMatch = {
  id: string;
  score: number;
  explanation: ReturnType<typeof matchPublicSkills>[number]['explanation'];
};

export type OpportunityMatchReader = {
  listOpportunities(input: {
    limit: number;
    skills: readonly string[];
  }): Promise<readonly PublicMatchOpportunity[]>;
  loadCandidateSkills(
    subject: Required<WorkspaceSubject>,
  ): Promise<readonly string[]>;
};

export type OpportunityMatchDependencies = { reader: OpportunityMatchReader };

async function defaultReader(): Promise<OpportunityMatchReader> {
  return {
    async loadCandidateSkills(subject) {
      const evidence = await loadWorkspaceCandidateEvidence(subject);
      return evidence.evidence
        .filter(
          (item) => item.kind === 'skill' || item.kind === 'skill_context',
        )
        .map((item) => item.title);
    },
    async listOpportunities({ limit }) {
      const analyses = await getCollection('OpportunityAnalysis');
      const rows = await analyses.list({
        where: { status: 'deterministic' },
        limit,
        cache: false,
      });
      return rows
        .map((row) => {
          const value = row.toJSON() as Record<string, unknown>;
          const parse = (key: string) => {
            try {
              const result = JSON.parse(String(value[key] ?? '[]'));
              return Array.isArray(result) ? result : [];
            } catch {
              return [];
            }
          };
          const skills = parse('skillsJson') as Array<{
            slug?: string;
            kind?: string;
          }>;
          return {
            id: String(value.opportunityId ?? ''),
            skills: {
              required: skills
                .filter((item) => item.kind === 'required')
                .map((item) => String(item.slug ?? '')),
              preferred: skills
                .filter((item) => item.kind === 'preferred')
                .map((item) => String(item.slug ?? '')),
            },
            requirements: parse(
              'requirementsJson',
            ) as PublicMatchOpportunity['requirements'],
          };
        })
        .filter((row) => row.id);
    },
  };
}

/**
 * Private Stages 0–2. Stage 3 is deliberately opt-in and bounded by callers
 * to 25 candidates; no user evidence crosses the public reader boundary.
 */
export async function getMyOpportunityMatches(
  subject: WorkspaceSubject,
  input: { limit?: number } = {},
  deps?: OpportunityMatchDependencies,
): Promise<OpportunityMatch[]> {
  const owned = requireCandidateWorkspaceSubject(subject);
  const limit = Math.min(
    Math.max(input.limit ?? 25, 1),
    MAX_STAGE_THREE_POSTINGS,
  );
  const reader = deps?.reader ?? (await defaultReader());
  const skills = await reader.loadCandidateSkills(owned);
  const opportunities = await reader.listOpportunities({ limit, skills });
  return matchPublicSkills({ skills }, opportunities).map((row) => ({
    ...row,
  }));
}

export async function refreshOpportunityMatches(
  subject: WorkspaceSubject,
  options: { enrich?: boolean; limit?: number } = {},
  deps?: OpportunityMatchDependencies,
): Promise<{
  matches: OpportunityMatch[];
  materialFingerprint: string;
  stageThreeCap: number;
}> {
  const matches = await getMyOpportunityMatches(
    subject,
    { limit: options.limit },
    deps,
  );
  // Stable local provenance only; callers use it to invalidate private ranks.
  const materialFingerprint = createHash('sha256')
    .update(JSON.stringify(matches.map(({ id, score }) => [id, score])))
    .digest('hex');
  return {
    matches,
    materialFingerprint,
    stageThreeCap: MAX_STAGE_THREE_POSTINGS,
  };
}
