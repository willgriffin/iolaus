/**
 * Stateless, zero-model matching for the public catalog.
 *
 * This module deliberately accepts its catalog as an argument.  That keeps the
 * public boundary explicit: callers may supply only fields produced by the
 * shared opportunity analysis, never a workspace profile or private evidence.
 */
import { normalizeSkill } from '../../skill-matching.js';

export type PublicMatchRequirement = {
  hash?: string;
  kind?: 'must' | 'nice' | 'should';
  skills?: readonly string[];
  text?: string;
};

export type PublicMatchOpportunity = {
  id: string;
  eligibility?: {
    flags?: number;
    countries?: readonly string[];
    remote?: boolean | null;
  };
  requirements?: readonly PublicMatchRequirement[];
  skills?: { preferred?: readonly string[]; required?: readonly string[] };
};

export type PublicMatchInput = {
  countries?: readonly string[];
  remoteOk?: boolean;
  skills: readonly string[];
};

export type PublicMatchExplanation = {
  matchedSkills: string[];
  missingSkills: string[];
  requirements: Array<{
    requirement: string;
    status: 'matched' | 'missing' | 'unknown';
  }>;
};

export type PublicMatchResult = {
  explanation: PublicMatchExplanation;
  id: string;
  score: number;
};

function terms(values: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSkill(value);
    if (normalized) result.add(normalized);
  }
  return result;
}

function intersect(left: Set<string>, right: Iterable<string>): string[] {
  return [...terms(right)].filter((value) => left.has(value)).sort();
}

function missing(left: Set<string>, right: Iterable<string>): string[] {
  return [...terms(right)].filter((value) => !left.has(value)).sort();
}

/**
 * Matches only caller-submitted skills.  A missing skill reduces coverage but
 * is not a hard conflict; unknown requirements stay visible as unknown.
 */
export function matchPublicSkills(
  input: PublicMatchInput,
  opportunities: readonly PublicMatchOpportunity[],
): PublicMatchResult[] {
  const submitted = terms(input.skills);
  if (submitted.size === 0) return [];
  return opportunities
    .map((opportunity) => {
      const required = opportunity.skills?.required ?? [];
      const preferred = opportunity.skills?.preferred ?? [];
      const matchedRequired = intersect(submitted, required);
      const matchedPreferred = intersect(submitted, preferred);
      const missingRequired = missing(submitted, required);
      const requirementRows = (opportunity.requirements ?? []).map(
        (requirement) => {
          const requiredSkills = requirement.skills ?? [];
          const known = requiredSkills.length > 0;
          const status: PublicMatchExplanation['requirements'][number]['status'] =
            !known
              ? 'unknown'
              : intersect(submitted, requiredSkills).length > 0
                ? 'matched'
                : 'missing';
          return {
            requirement: requirement.text ?? requirement.hash ?? 'Requirement',
            status,
          };
        },
      );
      const requiredWeight = required.length * 2;
      const preferredWeight = preferred.length;
      const coveredWeight =
        matchedRequired.length * 2 + matchedPreferred.length;
      const score = Math.round(
        (100 * coveredWeight) / Math.max(1, requiredWeight + preferredWeight),
      );
      return {
        explanation: {
          matchedSkills: [
            ...new Set([...matchedRequired, ...matchedPreferred]),
          ].sort(),
          missingSkills: [...new Set(missingRequired)].sort(),
          requirements: requirementRows,
        },
        id: opportunity.id,
        score,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
    );
}
