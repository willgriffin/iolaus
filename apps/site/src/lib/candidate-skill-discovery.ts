export type CandidateSkillClassification =
  | 'direct'
  | 'introductory'
  | 'unknown';
export interface CandidateSkillEvidence {
  id: string;
  title: string;
  text: string;
}
export interface CandidateSkillProposal {
  id: string;
  revision: string;
  label: string;
  canonicalLabel: string;
  classification: CandidateSkillClassification;
  status: 'pending' | 'confirmed' | 'dismissed' | 'duplicate';
  evidence: CandidateSkillEvidence[];
  confidence: number | null;
}
export interface CandidateSkillDiscoverySnapshot {
  revision: string;
  proposals: CandidateSkillProposal[];
  canonicalSkills: string[];
  scope: {
    candidateEvidenceCount: number;
    vocabularyCount: number;
    assessedCount: number;
    remainingCount: number;
    description: string;
  };
  status: 'idle' | 'complete' | 'partial' | 'stale';
}

export interface ConfirmedCandidateSkill {
  id: string;
  label: string;
  classification: 'direct' | 'introductory';
  provenance: 'user_verified';
  evidence: CandidateSkillEvidence[];
  discoveryRequestId: string;
}

/** Only explicit, structurally valid confirmations enter candidate evidence. */
export function parseConfirmedCandidateSkills(
  rawFactsJson: unknown,
): ConfirmedCandidateSkill[] {
  try {
    const state =
      typeof rawFactsJson === 'string' ? JSON.parse(rawFactsJson) : null;
    if (state?.version !== 1 || !Array.isArray(state.facts?.confirmedSkills))
      return [];
    const seen = new Set<string>();
    const nonempty = (value: unknown): value is string =>
      typeof value === 'string' && value.trim().length > 0;
    return state.facts.confirmedSkills
      .filter((row: unknown): row is ConfirmedCandidateSkill => {
        if (!row || typeof row !== 'object') return false;
        const value = row as ConfirmedCandidateSkill;
        if (
          !nonempty(value.id) ||
          !nonempty(value.label) ||
          !nonempty(value.discoveryRequestId) ||
          value.provenance !== 'user_verified' ||
          !['direct', 'introductory'].includes(value.classification) ||
          !Array.isArray(value.evidence) ||
          value.evidence.length === 0 ||
          !value.evidence.every(
            (cite) =>
              cite &&
              nonempty(cite.id) &&
              nonempty(cite.title) &&
              nonempty(cite.text),
          ) ||
          seen.has(value.id)
        )
          return false;
        seen.add(value.id);
        return true;
      })
      .map((row: ConfirmedCandidateSkill) => ({
        id: row.id,
        label: row.label,
        classification: row.classification,
        provenance: 'user_verified',
        discoveryRequestId: row.discoveryRequestId,
        evidence: row.evidence.map(({ id, title, text }) => ({
          id,
          title,
          text,
        })),
      }));
  } catch {
    return [];
  }
}

/** Review metadata is never career or preference evidence for a provider. */
export function withoutSkillDiscoveryMetadata(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, 'skillDiscovery')
    )
      return raw;
    const { skillDiscovery: _review, ...preferences } = value;
    return JSON.stringify(preferences);
  } catch {
    return raw;
  }
}
