import { createHash } from 'node:crypto';
import {
  canonicalSkillSlug,
  SKILL_CANONICAL_ALIASES,
} from '../skill-canonical.js';
import { candidateWorkEligibilityFromProfile } from './candidate-work-eligibility.js';
import {
  matchPublicSkills,
  type PublicMatchOpportunity,
  type PublicMatchResult,
  requirementCoverageScore,
} from './public-search/match.js';
import type {
  CandidateEvidenceSource,
  WorkspaceCandidateEvidence,
} from './resume-data.js';

export const MATCH_CONTRACT = 'opportunity-match/v1';
export const MATCH_PROJECTION = 'opportunity-recommendation-rank/v3';
export const MATCH_MODEL = 'staged-private/v1';
export const contentHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const skillPatterns = new Map<string, RegExp[]>();
export function evidenceContainsSkill(
  item: CandidateEvidenceSource,
  skill: string,
): boolean {
  const slug = canonicalSkillSlug(skill);
  if (
    canonicalSkillSlug(item.text) === slug ||
    canonicalSkillSlug(item.title) === slug
  )
    return true;
  let patterns = skillPatterns.get(slug);
  if (!patterns) {
    const aliases = [
      slug.replaceAll('-', ' '),
      ...Object.entries(SKILL_CANONICAL_ALIASES)
        .filter(([, canonical]) => canonical === slug)
        .map(([alias]) => alias),
    ];
    patterns = aliases
      .filter(Boolean)
      .map(
        (term) =>
          new RegExp(
            `(^|[^a-z0-9+#])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9+#])`,
            'i',
          ),
      );
    if (skillPatterns.size >= 10000) skillPatterns.clear();
    skillPatterns.set(slug, patterns);
  }
  return patterns.some((pattern) => pattern.test(item.text));
}
export function candidateSkills(
  evidence: WorkspaceCandidateEvidence,
  opportunities: readonly PublicMatchOpportunity[],
): string[] {
  const terms = new Set(
    opportunities.flatMap((o) => [
      ...(o.skills?.required ?? []),
      ...(o.skills?.preferred ?? []),
      ...(o.requirements ?? []).flatMap((r) => r.skills ?? []),
    ]),
  );
  return [...terms].filter((term) =>
    evidence.evidence.some((item) => evidenceContainsSkill(item, term)),
  );
}
/** Merge overlapping intervals rather than double-counting concurrent roles. */
export function experienceYears(
  items: readonly CandidateEvidenceSource[],
  skills: readonly string[],
  now: number,
): number | undefined {
  const intervals = items
    .filter(
      (item) =>
        item.kind === 'employment' &&
        skills.every((skill) => evidenceContainsSkill(item, skill)),
    )
    .flatMap((item) => {
      const range = item.text.match(
        /\b((?:19|20)\d{2})(?:-(0[1-9]|1[0-2]))?(?:-\d{2})?\s*[-–]\s*(?:((?:19|20)\d{2})(?:-(0[1-9]|1[0-2]))?(?:-\d{2})?|(present|current|now))\b/i,
      );
      if (!range) return [];
      const start = Date.UTC(Number(range[1]), Number(range[2] ?? 1) - 1);
      const end = range[3]
        ? Date.UTC(Number(range[3]), Number(range[4] ?? 1) - 1)
        : now;
      return Number.isFinite(end) && end > start && end <= now
        ? [[start, end] as [number, number]]
        : [];
    })
    .sort((a, b) => a[0] - b[0]);
  if (!intervals.length) return undefined;
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1])
      last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const year = 365.25 * 86400000;
  return merged.reduce((sum, [start, end]) => {
    const age = Math.max(0, (now - end) / year);
    const recency = age <= 3 ? 1 : Math.max(0.5, 1 - (age - 3) / 14);
    return sum + ((end - start) / year) * recency;
  }, 0);
}
export function matchCandidateEvidence(
  evidence: WorkspaceCandidateEvidence,
  opportunities: readonly PublicMatchOpportunity[],
  now = Date.now(),
  adjacency: ReadonlyMap<string, readonly string[]> = new Map(),
): PublicMatchResult[] {
  const publicSkills = new Set(
    opportunities.flatMap((o) => [
      ...(o.skills?.required ?? []),
      ...(o.skills?.preferred ?? []),
      ...(o.requirements ?? []).flatMap((r) => r.skills ?? []),
    ]),
  );
  const skillEvidence = new Map(
    [...publicSkills].map((skill) => [
      skill,
      evidence.evidence.filter((item) => evidenceContainsSkill(item, skill)),
    ]),
  );
  const relevantFor = (skill: string): CandidateEvidenceSource[] => {
    let rows = skillEvidence.get(skill);
    if (!rows) {
      rows = evidence.evidence.filter((item) =>
        evidenceContainsSkill(item, skill),
      );
      skillEvidence.set(skill, rows);
    }
    return rows;
  };
  const skills = [...publicSkills].filter((skill) => relevantFor(skill).length);
  const tenure = new Map<string, number | undefined>();
  const eligibility = candidateWorkEligibilityFromProfile(
    evidence.candidate as unknown as Record<string, unknown>,
  );
  const countries = eligibility.targetWorkCountry
    ? [eligibility.targetWorkCountry.code]
    : undefined;
  const title = evidence.candidate.title.toLowerCase();
  const seniority = [
    'principal',
    'staff',
    'senior',
    'junior',
    'director',
    'manager',
    'intern',
  ].find((level) => title.includes(level));
  // Empty evidence still gives an explainable unknown result for each posting.
  const matched = matchPublicSkills(
    {
      skills,
      countries,
      seniority,
    },
    opportunities,
    { allowEmptySkills: true },
  );
  const byId = new Map(opportunities.map((o) => [o.id, o]));
  for (const row of matched) {
    const opportunity = byId.get(row.id)!;
    for (const requirement of row.explanation.requirements) {
      const source = opportunity.requirements?.find(
        (r) => r.hash === requirement.hash,
      );
      const requiredSkills = source?.skills ?? [requirement.requirement];
      const relevant = [...new Set(requiredSkills.flatMap(relevantFor))];
      if (requirement.coverage < 1 && source?.skills?.length) {
        const coverage = source.skills.map((skill) => {
          if (relevantFor(skill).length) return 1;
          const related = adjacency.get(canonicalSkillSlug(skill)) ?? [];
          const relatedEvidence = [...new Set(related.flatMap(relevantFor))];
          relevant.push(...relatedEvidence);
          return relatedEvidence.length ? 0.35 : 0;
        });
        requirement.coverage =
          coverage.reduce<number>((sum, value) => sum + value, 0) /
          coverage.length;
      }
      if (source?.category === 'education') {
        const degree = (source.text ?? '')
          .match(/\b(bachelor|master|doctorate|phd|associate)(?:'s|s)?\b/i)?.[1]
          ?.toLowerCase();
        const education = degree
          ? evidence.evidence.filter(
              (item) =>
                item.kind === 'education' &&
                new RegExp(`\\b${degree}(?:'s|s)?\\b`, 'i').test(item.text),
            )
          : [];
        if (education.length) {
          requirement.coverage = 0.5;
          relevant.push(...education);
        }
        // Degree level alone is partial: discipline/equivalency still needs a decision.
      }
      requirement.evidenceRefs = relevant.slice(0, 3).map((item) => item.id);
      requirement.submittedSkillIndices = [];
      if (source?.years && source.years > 0) {
        const tenureKey = JSON.stringify([...(source.skills ?? [])].sort());
        if (!tenure.has(tenureKey))
          tenure.set(
            tenureKey,
            experienceYears(evidence.evidence, source.skills ?? [], now),
          );
        const years = tenure.get(tenureKey);
        requirement.coverage =
          years === undefined
            ? Math.min(requirement.coverage, 0.5)
            : Math.min(1, years / source.years);
      }
      // Introductory exposure cannot become full proficiency merely by naming a skill.
      if (
        relevant.length &&
        relevant.every((item) => /introductory exposure only/.test(item.text))
      )
        requirement.coverage = Math.min(0.25, requirement.coverage);
      requirement.decision =
        requirement.coverage === 1
          ? 'meets'
          : requirement.coverage > 0
            ? 'partial'
            : 'unknown';
      requirement.status =
        requirement.coverage === 1
          ? 'matched'
          : requirement.coverage > 0
            ? 'missing'
            : 'unknown';
      requirement.confidence = requirement.coverage > 0 ? 1 : 0;
    }
    const requiredCountries =
      opportunity.eligibility?.workAuthorization?.required ?? [];
    const rights = eligibility.authorizedWorkCountries
      .filter((right) => right.scope === 'country' && !right.condition)
      .map((right) => right.country.code);
    if (
      requiredCountries.length &&
      !requiredCountries.some((country) => rights.includes(country))
    )
      row.explanation.eligibilityNotes.push(
        'Required work authorization is not established; conditional rights and citizenship are not unrestricted authorization.',
      );
    if (
      eligibility.sponsorshipRequired === true &&
      opportunity.eligibility?.workAuthorization?.sponsorship === 'no'
    ) {
      row.mustHaveConflictCount += 1;
      row.explanation.eligibilityNotes.push(
        'Explicit conflict: candidate requires sponsorship and posting states no sponsorship.',
      );
    }
    row.score = Math.round(
      requirementCoverageScore(row.explanation.requirements) *
        Math.max(0, 1 - row.seniorityDelta * 0.15),
    );
  }
  return matched.sort(
    (a, b) =>
      a.mustHaveConflictCount - b.mustHaveConflictCount ||
      b.score - a.score ||
      a.id.localeCompare(b.id),
  );
}
