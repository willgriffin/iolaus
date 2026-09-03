// Shared skill matching for opportunity skill chips.
//
// A required skill from a job posting is "have" when it overlaps, on whole-word
// boundaries, with the candidate's reviewed evidence: catalog skill ids and
// labels (e.g. "PostgreSQL", "Infrastructure as Code"), curated aliases, and
// achievement titles/tags from the resume (e.g. "Hybrid Cloud Infrastructure").
//
// Matching is token-based, not substring-based: owning "RAG" must not light up a
// "Storage" requirement just because "sto-rag-e" contains those letters. Variants
// such as Postgres/PostgreSQL are handled by curating the label or an alias, not
// by fuzzy string containment.

export type SkillDatum = {
  aliases?: string[];
  id?: string;
  label?: string;
};

export type SkillCategoryDatum = {
  aliases?: string[];
  label?: string;
  skills?: SkillDatum[];
};

export type SkillGroupDatum = {
  aliases?: string[];
  label?: string;
  skills?: string[];
};

export type SkillsDatum = {
  groups?: SkillCategoryDatum[];
  skillGroups?: SkillGroupDatum[];
};

export type ExperienceAchievementDatum = {
  tags?: string[];
  title?: string;
};

export type ExperiencePositionDatum = {
  achievements?: ExperienceAchievementDatum[];
};

export type ExperienceOtherDatum = {
  tags?: string[];
};

export type ExperienceDatum = {
  other?: ExperienceOtherDatum[];
  positions?: ExperiencePositionDatum[];
};

export function normalizeSkill(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeSkill(value);
  return normalized ? normalized.split(' ') : [];
}

// True when `needle` appears as a contiguous run of whole tokens in `haystack`:
// ["github"] is in ["github", "actions"], ["cloud", "infrastructure"] is in
// ["hybrid", "cloud", "infrastructure"], but ["rag"] is not in ["storage"].
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function tokensOverlap(a: string[], b: string[]): boolean {
  // Either side may be the broader phrase: a posting's "cloud infrastructure"
  // matches owned "hybrid cloud infrastructure", and owned "github" matches a
  // posting's "github actions".
  return containsPhrase(a, b) || containsPhrase(b, a);
}

function addTerm(terms: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const normalized = normalizeSkill(value);
  if (normalized) terms.add(normalized);
}

export function candidateSkillTermsFromData(options: {
  experience?: ExperienceDatum;
  skills?: SkillsDatum;
}): string[] {
  const terms = new Set<string>();
  const skills = options.skills;

  for (const group of skills?.skillGroups ?? []) {
    addTerm(terms, group.label);
    for (const alias of group.aliases ?? []) addTerm(terms, alias);
    for (const skill of group.skills ?? []) addTerm(terms, skill);
  }

  for (const category of skills?.groups ?? []) {
    addTerm(terms, category.label);
    for (const alias of category.aliases ?? []) addTerm(terms, alias);
    for (const skill of category.skills ?? []) {
      addTerm(terms, skill.id);
      addTerm(terms, skill.label);
      for (const alias of skill.aliases ?? []) addTerm(terms, alias);
    }
  }

  // Curated achievement titles and tags are strong, reviewed evidence phrases.
  // They catch broad posting requirements such as "cloud infrastructure" or
  // "high availability" that no single catalog slug spells out.
  const experience = options.experience;
  for (const position of experience?.positions ?? []) {
    for (const achievement of position.achievements ?? []) {
      addTerm(terms, achievement.title);
      for (const tag of achievement.tags ?? []) addTerm(terms, tag);
    }
  }
  for (const item of experience?.other ?? []) {
    for (const tag of item.tags ?? []) addTerm(terms, tag);
  }

  return Array.from(terms).sort();
}

// Builds a reusable predicate from candidate terms. Tokenizes each owned term
// once so repeated lookups (one per posting skill chip) stay cheap.
export function createCandidateSkillMatcher(
  candidateTerms: Iterable<string>,
): (skill: string) => boolean {
  const ownedTokenLists: string[][] = [];
  for (const term of candidateTerms) {
    const tokens = tokenize(term);
    if (tokens.length > 0) ownedTokenLists.push(tokens);
  }

  return (skill: string): boolean => {
    const target = tokenize(skill);
    if (target.length === 0) return false;
    return ownedTokenLists.some((owned) => tokensOverlap(target, owned));
  };
}

export function hasCandidateSkill(
  skill: string,
  candidateTerms: Iterable<string>,
): boolean {
  return createCandidateSkillMatcher(candidateTerms)(skill);
}
