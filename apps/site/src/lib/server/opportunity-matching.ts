import { createHash } from 'node:crypto';
import {
  matchPublicSkills,
  type PublicMatchOpportunity,
} from './public-search/match.js';
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

/**
 * Private Stages 0–2. Stage 3 is deliberately opt-in and bounded by callers
 * to 25 candidates; no user evidence crosses the public reader boundary.
 */
export async function getMyOpportunityMatches(
  subject: WorkspaceSubject,
  input: { limit?: number } = {},
  deps: OpportunityMatchDependencies,
): Promise<OpportunityMatch[]> {
  const owned = requireCandidateWorkspaceSubject(subject);
  const limit = Math.min(
    Math.max(input.limit ?? 25, 1),
    MAX_STAGE_THREE_POSTINGS,
  );
  const skills = await deps.reader.loadCandidateSkills(owned);
  const opportunities = await deps.reader.listOpportunities({ limit, skills });
  return matchPublicSkills({ skills }, opportunities).map((row) => ({
    ...row,
  }));
}

export async function refreshOpportunityMatches(
  subject: WorkspaceSubject,
  options: { enrich?: boolean; limit?: number } = {},
  deps: OpportunityMatchDependencies,
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
