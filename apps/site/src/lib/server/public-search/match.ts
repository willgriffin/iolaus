/** Stateless public matching. Inputs contain only submitted facts and public analysis. */
import { canonicalSkillSlug } from '../../skill-canonical.js';

export type PublicMatchRequirement = {
  hash?: string;
  kind?: 'must' | 'nice' | 'should';
  category?: string;
  years?: number;
  skills?: readonly string[];
  text?: string;
};
export type PublicMatchOpportunity = {
  id: string;
  seniority?: string;
  eligibility?: {
    flags?: number;
    countries?: readonly string[];
    remote?: boolean | null;
    workAuthorization?: { required: readonly string[]; sponsorship: string };
  };
  requirements?: readonly PublicMatchRequirement[];
  skills?: { preferred?: readonly string[]; required?: readonly string[] };
};
export type PublicMatchInput = {
  countries?: readonly string[];
  remoteOk?: boolean;
  seniority?: string;
  years?: number;
  skills: readonly string[];
};
export type RequirementMatch = {
  hash: string;
  requirement: string;
  kind: 'must' | 'should' | 'nice';
  status: 'matched' | 'missing' | 'unknown';
  decision: 'meets' | 'partial' | 'no' | 'unknown';
  confidence: number;
  coverage: number;
  submittedSkillIndices: number[];
  evidenceRefs: string[];
};
export type PublicMatchExplanation = {
  matchedSkills: string[];
  missingSkills: string[];
  eligibilityNotes: string[];
  requirements: RequirementMatch[];
};
export type PublicMatchResult = {
  explanation: PublicMatchExplanation;
  id: string;
  score: number;
  mustHaveConflictCount: number;
  seniorityDelta: number;
};
const weights = { must: 1, should: 0.5, nice: 0.2 };
export function seniorityLevel(value?: string): number | undefined {
  const levels: Record<string, number> = {
    intern: 0,
    junior: 1,
    mid: 2,
    senior: 3,
    staff: 4,
    principal: 5,
    manager: 4,
    director: 5,
    exec: 6,
  };
  return value ? levels[value] : undefined;
}
export function requirementCoverageScore(
  rows: readonly RequirementMatch[],
): number {
  const denominator = rows.reduce((sum, row) => sum + weights[row.kind], 0);
  return denominator
    ? (100 *
        rows.reduce((sum, row) => sum + weights[row.kind] * row.coverage, 0)) /
        denominator
    : 0;
}
export function matchPublicSkills(
  input: PublicMatchInput,
  opportunities: readonly PublicMatchOpportunity[],
  options: { allowEmptySkills?: boolean } = {},
): PublicMatchResult[] {
  const canonical = new Map<string, string>();
  const normalizeSkill = (value: string): string => {
    let term = canonical.get(value);
    if (term === undefined) {
      term = canonicalSkillSlug(value);
      canonical.set(value, term);
    }
    return term;
  };
  const submitted = input.skills.map(normalizeSkill);
  const submittedSet = new Set(submitted);
  const indicesBySkill = new Map<string, number[]>();
  submitted.forEach((skill, index) => {
    indicesBySkill.set(skill, [...(indicesBySkill.get(skill) ?? []), index]);
  });
  if (!submitted.some(Boolean) && !options.allowEmptySkills) return [];
  const contains = (skill: string) => submittedSet.has(normalizeSkill(skill));
  return opportunities
    .map((opportunity) => {
      const required = [...new Set(opportunity.skills?.required ?? [])];
      const preferred = [...new Set(opportunity.skills?.preferred ?? [])];
      const requirements: PublicMatchRequirement[] = [
        ...(opportunity.requirements ?? []),
      ];
      // Keep public skill coverage when an analysis lacks atomized requirements.
      for (const [skills, kind] of [
        [required, 'must'],
        [preferred, 'nice'],
      ] as const) {
        for (const skill of skills)
          if (
            !requirements.some((r) =>
              r.skills?.some(
                (s) => normalizeSkill(s) === normalizeSkill(skill),
              ),
            )
          )
            requirements.push({
              hash: `skill:${normalizeSkill(skill)}`,
              text: skill,
              kind,
              skills: [skill],
            });
      }
      const rows = requirements.map((r, index): RequirementMatch => {
        const skills = [...new Set(r.skills ?? [])];
        const indices = [
          ...new Set(
            skills.flatMap(
              (skill) => indicesBySkill.get(normalizeSkill(skill)) ?? [],
            ),
          ),
        ].sort((a, b) => a - b);
        let coverage = skills.length
          ? skills.filter(contains).length / skills.length
          : 0;
        let known = skills.length > 0;
        if (r.years !== undefined && Number.isFinite(r.years) && r.years > 0) {
          // A total-years answer is not proof of years in a particular technology.
          const yearsCoverage =
            input.years !== undefined && !skills.length
              ? Math.min(1, Math.max(0, input.years) / r.years)
              : undefined;
          if (yearsCoverage !== undefined) {
            coverage = yearsCoverage;
            known = true;
          } else coverage = Math.min(coverage, 0.5);
        }
        return {
          hash: r.hash ?? `requirement:${index}`,
          requirement: r.text ?? 'Requirement',
          kind: r.kind ?? 'should',
          status: !known ? 'unknown' : coverage === 1 ? 'matched' : 'missing',
          decision:
            coverage === 1 ? 'meets' : coverage > 0 ? 'partial' : 'unknown',
          confidence: coverage > 0 ? 1 : 0,
          coverage,
          submittedSkillIndices: indices,
          evidenceRefs: [],
        };
      });
      const eligibilityNotes: string[] = [];
      const countries = opportunity.eligibility?.countries ?? [];
      if (
        countries.length &&
        input.countries?.length &&
        !countries.some((c) =>
          input.countries?.some((i) => i.toUpperCase() === c.toUpperCase()),
        )
      )
        eligibilityNotes.push(
          'Posted countries do not overlap submitted countries; relocation and work authorization are unverified.',
        );
      if (input.remoteOk === true && opportunity.eligibility?.remote === false)
        eligibilityNotes.push('This posting is not marked remote.');
      if (!opportunity.eligibility || !input.countries?.length)
        eligibilityNotes.push(
          'Eligibility is not fully established by submitted facts.',
        );
      const candidateLevel = seniorityLevel(input.seniority);
      const postingLevel = seniorityLevel(opportunity.seniority);
      const seniorityDelta =
        candidateLevel !== undefined && postingLevel !== undefined
          ? Math.abs(candidateLevel - postingLevel)
          : 0;
      return {
        id: opportunity.id,
        score: Math.round(
          requirementCoverageScore(rows) *
            Math.max(0, 1 - seniorityDelta * 0.15),
        ),
        mustHaveConflictCount: 0,
        seniorityDelta,
        explanation: {
          matchedSkills: [
            ...new Set(
              [...required, ...preferred].filter(contains).map(normalizeSkill),
            ),
          ].sort(),
          missingSkills: required
            .filter((s) => !contains(s))
            .map(normalizeSkill)
            .sort(),
          eligibilityNotes,
          requirements: rows,
        },
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
