import {
  type PublicSearchInput,
  publicSearchInputSchema,
} from './public-opportunity-contract.js';
import {
  canonicalSkillSlug,
  SKILL_CANONICAL_ALIASES,
} from './skill-canonical.js';
import { CAREER_SKILL_TERMS } from './skill-vocabulary-data.js';

const MAX_RAW_QUERY_LENGTH = 1000;
const MAX_QUERY_LENGTH = 200;
const MAX_QUERY_TERMS = 8;

export type SearchChip = {
  kind: 'skill' | 'seniority' | 'work_mode' | 'employment_type' | 'country';
  value: string;
  label: string;
};

export type SearchInterpretation = {
  originalQuery: string;
  input: PublicSearchInput;
  chips: SearchChip[];
  warnings: string[];
};

type Extracted = { value: string; label: string; pattern: RegExp };

// Search suggestions only, never assertions about a candidate's capabilities.
const OCCUPATION_SKILLS: readonly {
  pattern: RegExp;
  labels: readonly string[];
}[] = [
  { pattern: /\b(?:welder|welders)\b/giu, labels: ['Welding'] },
  {
    pattern: /\b(?:nurse|nurses|nursing)\b/giu,
    labels: ['Patient care', 'Clinical documentation'],
  },
  {
    pattern: /\b(?:teacher|teachers)\b/giu,
    labels: ['Lesson planning', 'Classroom management'],
  },
  {
    pattern: /\b(?:carpenter|carpenters)\b/giu,
    labels: ['Carpentry', 'Blueprint reading'],
  },
  {
    pattern: /\b(?:electrician|electricians)\b/giu,
    labels: ['Electrical installation', 'Site safety'],
  },
  { pattern: /\b(?:plumber|plumbers)\b/giu, labels: ['Plumbing'] },
  { pattern: /\b(?:bookkeeper|bookkeepers)\b/giu, labels: ['Bookkeeping'] },
  {
    pattern: /\b(?:accountant|accountants)\b/giu,
    labels: ['Financial reporting'],
  },
  {
    pattern: /\b(?:chef|chefs|cook|cooks)\b/giu,
    labels: ['Food preparation', 'Food safety'],
  },
  { pattern: /\b(?:recruiter|recruiters)\b/giu, labels: ['Recruitment'] },
  { pattern: /\b(?:photographer|photographers)\b/giu, labels: ['Photography'] },
];

const COUNTRIES: readonly Extracted[] = [
  { value: 'CA', label: 'Canada', pattern: /\bcanada\b/giu },
  {
    value: 'US',
    label: 'United States',
    pattern: /\b(?:united states|u\.?s\.?a?\.?|america)\b/giu,
  },
  {
    value: 'GB',
    label: 'United Kingdom',
    pattern: /\b(?:united kingdom|u\.?k\.?|britain|great britain)\b/giu,
  },
  { value: 'AU', label: 'Australia', pattern: /\baustralia\b/giu },
  { value: 'DE', label: 'Germany', pattern: /\bgermany\b/giu },
  { value: 'FR', label: 'France', pattern: /\bfrance\b/giu },
  { value: 'IE', label: 'Ireland', pattern: /\bireland\b/giu },
  {
    value: 'NL',
    label: 'Netherlands',
    pattern: /\b(?:netherlands|holland)\b/giu,
  },
  { value: 'NZ', label: 'New Zealand', pattern: /\bnew zealand\b/giu },
  { value: 'JP', label: 'Japan', pattern: /\bjapan\b/giu },
];

const SENIORITY: readonly Extracted[] = [
  { value: 'intern', label: 'Intern', pattern: /\b(?:intern|internship)\b/giu },
  { value: 'junior', label: 'Junior', pattern: /\b(?:junior|jr\.?)\b/giu },
  {
    value: 'mid',
    label: 'Mid-level',
    pattern: /\b(?:mid[ -]?level|intermediate)\b/giu,
  },
  { value: 'senior', label: 'Senior', pattern: /\b(?:senior|sr\.?)\b/giu },
  {
    value: 'staff',
    label: 'Staff',
    pattern:
      /\bstaff\s+(?=(?:software|engineer|engineering|developer|product|data|platform)\b)/giu,
  },
  { value: 'principal', label: 'Principal', pattern: /\bprincipal\b/giu },
  { value: 'director', label: 'Director', pattern: /\bdirector\b/giu },
  {
    value: 'exec',
    label: 'Executive',
    pattern: /\b(?:executive|vp|vice president|chief)\b/giu,
  },
];

const WORK_MODES: readonly Extracted[] = [
  {
    value: 'remote',
    label: 'Remote',
    pattern: /\b(?:remote|work from home|wfh)\b/giu,
  },
  { value: 'hybrid', label: 'Hybrid', pattern: /\bhybrid\b/giu },
  {
    value: 'onsite',
    label: 'On-site',
    pattern: /\b(?:on[ -]?site|in[ -]?office)\b/giu,
  },
];

const EMPLOYMENT_TYPES: readonly Extracted[] = [
  {
    value: 'full_time',
    label: 'Full-time',
    pattern: /\b(?:full[ -]?time|permanent)\b/giu,
  },
  { value: 'fractional', label: 'Part-time', pattern: /\bpart[ -]?time\b/giu },
  {
    value: 'contract',
    label: 'Contract',
    pattern: /\b(?:contract|contractor|freelance)\b/giu,
  },
];

const UNSUPPORTED_CONSTRAINTS: readonly [RegExp, string][] = [
  [
    /\b(?:visa|sponsorship|authorized to work|work authorization)\b/giu,
    'Work authorization and sponsorship constraints are not applied.',
  ],
  [
    /\b(?:relocat(?:e|ion)|commut(?:e|ing)|timezone|time zone)\b/giu,
    'Location, relocation, and timezone constraints are not applied.',
  ],
];

const AMBIGUOUS_SALARY =
  /(?:\$\s*\d+(?:[,.]\d+)?\s*k?|\b(?:salary|compensation|pay)\b)/giu;
const EXPLICIT_SALARY =
  /\b(?:at\s+least|minimum|min\.?|>=)\s+([A-Z]{3})\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(?:per|\/)\s*(hour|day|week|month|year)\b/giu;

const CONNECTORS =
  /\b(?:i|a|an|the|for|in|at|with|and|or|roles?|jobs?|positions?|looking|seeking|want|need|only|from|within|no|not|without|exclude)\b/giu;

function removeUnsupportedConstraints(
  source: string,
  warnings: string[],
): string {
  let residual = source;
  for (const [pattern, message] of UNSUPPORTED_CONSTRAINTS) {
    if (pattern.test(source)) warnings.push(message);
    pattern.lastIndex = 0;
    residual = remove(pattern, residual);
  }
  return residual;
}

function extractSalary(
  source: string,
  warnings: string[],
): {
  salary: Pick<
    PublicSearchInput,
    'salary_min' | 'salary_currency' | 'salary_period'
  >;
  residual: string;
} {
  const match = EXPLICIT_SALARY.exec(source);
  EXPLICIT_SALARY.lastIndex = 0;
  if (match) {
    const amount = Number(match[2].replaceAll(',', ''));
    const period = match[3].toLowerCase() as NonNullable<
      PublicSearchInput['salary_period']
    >;
    return {
      salary: {
        salary_min: amount,
        salary_currency: match[1].toUpperCase(),
        salary_period: period,
      },
      residual: remove(EXPLICIT_SALARY, source),
    };
  }
  if (AMBIGUOUS_SALARY.test(source)) {
    warnings.push(
      'Salary constraints need an explicit currency and period, for example CAD 100000 per year.',
    );
    AMBIGUOUS_SALARY.lastIndex = 0;
    return { salary: {}, residual: remove(AMBIGUOUS_SALARY, source) };
  }
  AMBIGUOUS_SALARY.lastIndex = 0;
  return { salary: {}, residual: source };
}

function blankInput(): PublicSearchInput {
  return publicSearchInputSchema.parse({});
}

/** Validate loader-bound input against the one public search contract. */
export function validateOpportunitySearchInput(
  input: unknown,
): PublicSearchInput {
  return publicSearchInputSchema.parse(input);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function remove(pattern: RegExp, value: string): string {
  return value.replace(pattern, ' ');
}

function negatedAt(value: string, start: number): boolean {
  return /(?:\bno|\bnot|\bwithout|\bexclude)\s+(?:(?:in|from|within)\s+)?(?:[\p{L}\p{N}+#.]+\s+(?:and|or)\s+)*$/iu.test(
    value.slice(0, start),
  );
}

function skillsFrom(
  value: string,
  chips: SearchChip[],
  warnings: string[],
): { skills: string[]; matchedPhrases: string[] } {
  const catalogLabelBySlug = new Map<string, string>();
  for (const label of CAREER_SKILL_TERMS) {
    const slug = canonicalSkillSlug(label);
    if (!catalogLabelBySlug.has(slug)) catalogLabelBySlug.set(slug, label);
  }
  const aliases = new Map<string, { label: string; slug: string }>();
  for (const label of CAREER_SKILL_TERMS)
    aliases.set(label.toLowerCase(), {
      label,
      slug: canonicalSkillSlug(label),
    });
  for (const [alias, slug] of Object.entries(SKILL_CANONICAL_ALIASES))
    aliases.set(alias, {
      label: catalogLabelBySlug.get(slug) ?? alias,
      slug,
    });
  const matches: { label: string; slug: string; start: number; end: number }[] =
    [];
  for (const [phrase, skill] of [...aliases.entries()].sort(
    ([a], [b]) => b.length - a.length || a.localeCompare(b),
  )) {
    const pattern = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])(${phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})(?=$|[^\\p{L}\\p{N}])`,
      'giu',
    );
    for (const match of value.matchAll(pattern)) {
      const start = (match.index ?? 0) + match[0].indexOf(match[1]);
      matches.push({
        label: skill.label,
        slug: skill.slug,
        start,
        end: start + match[1].length,
      });
    }
  }
  const skills: string[] = [];
  const matchedPhrases = new Set<string>();
  const occupied: { start: number; end: number }[] = [];
  for (const match of matches.sort(
    (a, b) => a.start - b.start || b.label.length - a.label.length,
  )) {
    if (
      occupied.some((span) => match.start < span.end && match.end > span.start)
    )
      continue;
    occupied.push({ start: match.start, end: match.end });
    matchedPhrases.add(value.slice(match.start, match.end));
    if (negatedAt(value, match.start)) {
      warnings.push('Skill exclusions are not applied.');
      continue;
    }
    if (!skills.includes(match.slug)) {
      skills.push(match.slug);
      chips.push({ kind: 'skill', value: match.slug, label: match.label });
    }
  }
  return { skills, matchedPhrases: [...matchedPhrases] };
}

function extract(
  source: string,
  kind: SearchChip['kind'],
  entries: readonly Extracted[],
  chips: SearchChip[],
  warnings: string[],
): { values: string[]; residual: string } {
  const values: string[] = [];
  let residual = source;
  for (const entry of entries) {
    for (const match of source.matchAll(entry.pattern)) {
      const start = match.index ?? 0;
      if (negatedAt(source, start)) {
        warnings.push(`${entry.label} exclusions are not applied.`);
      } else {
        values.push(entry.value);
        chips.push({ kind, value: entry.value, label: entry.label });
      }
      residual = residual.replace(match[0], ' ');
    }
    entry.pattern.lastIndex = 0;
  }
  return { values: unique(values), residual };
}

function boundedRoleQuery(value: string, warnings: string[]): string {
  const words = value
    .replace(CONNECTORS, ' ')
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length > MAX_QUERY_TERMS) {
    warnings.push(`Only the first ${MAX_QUERY_TERMS} role terms were used.`);
    words.length = MAX_QUERY_TERMS;
  }
  let query = words.join(' ');
  if (query.length > MAX_QUERY_LENGTH) {
    query = query.slice(0, MAX_QUERY_LENGTH).trimEnd();
    warnings.push(
      `Role search text was shortened to ${MAX_QUERY_LENGTH} characters.`,
    );
  }
  return query;
}

/**
 * Translate a natural-language public catalog query into only documented,
 * editable public filters. This makes no assertions about a person's profile,
 * eligibility, or capabilities.
 */
export function interpretOpportunitySearch(raw: string): SearchInterpretation {
  const originalQuery = String(raw ?? '');
  const warnings: string[] = [];
  let source = originalQuery;
  if (source.length > MAX_RAW_QUERY_LENGTH) {
    source = source.slice(0, MAX_RAW_QUERY_LENGTH);
    warnings.push(
      `Only the first ${MAX_RAW_QUERY_LENGTH} characters were interpreted.`,
    );
  }
  source = removeUnsupportedConstraints(source, warnings);
  const salary = extractSalary(source, warnings);
  source = salary.residual;
  const chips: SearchChip[] = [];
  const skillResult = skillsFrom(source, chips, warnings);
  for (const occupation of OCCUPATION_SKILLS) {
    for (const match of source.matchAll(occupation.pattern)) {
      if (negatedAt(source, match.index ?? 0)) continue;
      for (const label of occupation.labels) {
        const slug = canonicalSkillSlug(label);
        // An explicit skill negation must not be reintroduced by a role suggestion.
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const explicitlyNegated = [
          ...source.matchAll(new RegExp(escaped, 'giu')),
        ].some((skillMatch) => negatedAt(source, skillMatch.index ?? 0));
        if (!explicitlyNegated && !skillResult.skills.includes(slug)) {
          skillResult.skills.push(slug);
          chips.push({ kind: 'skill', value: slug, label });
        }
      }
    }
  }

  let residual = source;
  for (const phrase of skillResult.matchedPhrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    residual = residual.replace(new RegExp(`\\b${escaped}\\b`, 'giu'), ' ');
  }
  const country = extract(residual, 'country', COUNTRIES, chips, warnings);
  residual = country.residual;
  const workMode = extract(residual, 'work_mode', WORK_MODES, chips, warnings);
  residual = workMode.residual;
  const seniority = extract(residual, 'seniority', SENIORITY, chips, warnings);
  residual = seniority.residual;
  const employmentType = extract(
    residual,
    'employment_type',
    EMPLOYMENT_TYPES,
    chips,
    warnings,
  );
  residual = employmentType.residual;

  return {
    originalQuery,
    input: validateOpportunitySearchInput({
      ...blankInput(),
      q: boundedRoleQuery(residual, warnings),
      skills: skillResult.skills,
      country: country.values,
      ['work_mode']: workMode.values,
      seniority: seniority.values,
      ['employment_type']: employmentType.values,
      ...salary.salary,
    }),
    chips,
    warnings: unique(warnings),
  };
}
