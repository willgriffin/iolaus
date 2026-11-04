import {
  countryReferenceFromCode,
  onboardingCountryCodes,
} from './country-reference.js';
import type {
  MatchingSourceExtraction,
  MatchingSourceSpan,
} from './matching-source-extraction-contract.js';

export const MATCHING_POLICY_VERSION = 'normalized-v8';

export interface MatchingVocabularyTerm {
  slug: string;
  label: string;
  aliases?: readonly string[];
  related?: readonly string[];
  /** The child can establish the parent. The reverse does not hold. */
  narrowerThan?: readonly string[];
}

interface MatchingVocabulary {
  aliases: ReadonlyMap<string, string | null>;
  labels: ReadonlyMap<string, string>;
  broader: ReadonlyMap<string, ReadonlySet<string>>;
  related: ReadonlyMap<string, ReadonlySet<string>>;
  narrower: ReadonlyMap<string, ReadonlySet<string>>;
}

const capabilityTerms: readonly MatchingVocabularyTerm[] = [
  { slug: 'networking', label: 'Networking', aliases: ['computer networking'] },
  { slug: 'ip-routing', label: 'IP routing', narrowerThan: ['networking'] },
  { slug: 'mentoring', label: 'Mentoring', related: ['people-management'] },
  {
    slug: 'people-management',
    label: 'People management',
    aliases: ['managing direct reports', 'managing people'],
  },
];

function phrase(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function compileMatchingVocabulary(
  terms: readonly MatchingVocabularyTerm[],
): MatchingVocabulary {
  const graph = new Map(capabilityTerms.map((term) => [term.slug, term]));
  // An approved persisted definition replaces the built-in definition.
  for (const term of terms) graph.set(term.slug, term);
  const aliases = new Map<string, string | null>();
  const related = new Map<string, Set<string>>();
  for (const term of graph.values()) {
    for (const alias of [term.slug, term.label, ...(term.aliases ?? [])]) {
      const key = phrase(alias);
      if (!key) continue;
      aliases.set(
        key,
        aliases.has(key) && aliases.get(key) !== term.slug ? null : term.slug,
      );
    }
    for (const slug of term.related ?? []) {
      if (!graph.has(slug) || slug === term.slug) continue;
      for (const [from, to] of [
        [term.slug, slug],
        [slug, term.slug],
      ]) {
        const neighbors = related.get(from) ?? new Set<string>();
        neighbors.add(to);
        related.set(from, neighbors);
      }
    }
  }
  const broader = new Map<string, Set<string>>();
  for (const slug of graph.keys()) {
    const parents = new Set<string>();
    const pending = [...(graph.get(slug)?.narrowerThan ?? [])];
    while (pending.length) {
      const parent = pending.pop() as string;
      if (parents.has(parent) || !graph.has(parent)) continue;
      if (parent === slug)
        throw new Error('Matching vocabulary contains a narrower-than cycle.');
      parents.add(parent);
      pending.push(...(graph.get(parent)?.narrowerThan ?? []));
    }
    broader.set(slug, parents);
  }
  const narrower = new Map<string, Set<string>>();
  for (const [child, parents] of broader) {
    for (const parent of parents) {
      const children = narrower.get(parent) ?? new Set<string>();
      children.add(child);
      narrower.set(parent, children);
    }
  }
  return {
    aliases,
    labels: new Map([...graph].map(([slug, term]) => [slug, term.label])),
    broader,
    narrower,
    related,
  };
}

type CitationField =
  | 'title'
  | 'description'
  | 'location'
  | 'workplace'
  | 'target-role'
  | 'target-location'
  | 'target-mode'
  | 'evidence'
  | 'question';

interface Citation {
  field: CitationField;
  id?: string;
  start: number;
  end: number;
  text: string;
}

function cite(
  field: CitationField,
  raw: string,
  start = 0,
  end = raw.length,
  id?: string,
): Citation {
  return { field, id, start, end, text: raw.slice(start, end) };
}

type Level = 'entry' | 'mid' | 'senior' | 'staff' | 'principal' | 'lead';
type Role = {
  family: string;
  specialty?: string;
  level?: Level;
  citation: Citation;
};

const roleAliases = new Map<string, Omit<Role, 'citation' | 'level'>>();
const roleFamilies: readonly [string, string | undefined, string][] = [
  [
    'software-engineering',
    undefined,
    'software engineer|software developer|software development engineer|application developer|application engineer|software programmer|programmer|sde',
  ],
  [
    'software-engineering',
    'backend',
    'backend engineer|back end engineer|backend developer|back end developer|backend software engineer|back end software engineer|software engineer backend|software engineer back end|software developer backend|api engineer|api developer',
  ],
  [
    'software-engineering',
    'frontend',
    'frontend engineer|front end engineer|frontend developer|front end developer|frontend software engineer|front end software engineer|software engineer frontend|software engineer front end|software developer frontend|ui engineer',
  ],
  [
    'software-engineering',
    'full-stack',
    'full stack engineer|full stack developer|full stack software engineer|software engineer full stack|software developer full stack',
  ],
  [
    'software-engineering',
    'mobile',
    'mobile engineer|mobile developer|mobile software engineer|software engineer mobile|ios engineer|ios developer|android engineer|android developer',
  ],
  [
    'engineering-management',
    undefined,
    'engineering manager|software engineering manager|software development manager|manager software engineering|manager software development|director of engineering|director of software engineering|engineering director|head of engineering|head of software engineering',
  ],
  [
    'platform-engineering',
    undefined,
    'platform engineer|software platform engineer|infrastructure engineer|site reliability engineer|sre|devops engineer|devops developer|cloud engineer|cloud infrastructure engineer',
  ],
  [
    'network-engineering',
    undefined,
    'network engineer|network administrator|network architect',
  ],
  [
    'security-engineering',
    undefined,
    'security engineer|cybersecurity engineer|application security engineer|security analyst',
  ],
  [
    'data-engineering',
    undefined,
    'data engineer|analytics engineer|data platform engineer',
  ],
  ['data-science', undefined, 'data scientist|applied scientist'],
  [
    'machine-learning-engineering',
    undefined,
    'machine learning engineer|ml engineer|ai engineer|applied ai engineer|ai ml engineer',
  ],
  [
    'data-analysis',
    undefined,
    'data analyst|business intelligence analyst|bi analyst',
  ],
  [
    'product-management',
    undefined,
    'product manager|technical product manager|product owner|product lead|director of product management',
  ],
  [
    'project-management',
    undefined,
    'project manager|technical project manager|program manager|technical program manager|delivery manager|scrum master',
  ],
  [
    'product-design',
    undefined,
    'product designer|ux designer|user experience designer|ui designer|ux researcher',
  ],
  [
    'quality-engineering',
    undefined,
    'qa engineer|quality assurance engineer|test engineer|software development engineer in test|sdet',
  ],
  [
    'customer-support',
    undefined,
    'customer support specialist|customer support representative|customer service representative|technical support specialist|technical support engineer|support engineer',
  ],
  [
    'sales',
    undefined,
    'account executive|enterprise account executive|commercial account executive|sales representative|sales development representative|business development representative|account manager|sales manager',
  ],
  [
    'solutions-engineering',
    undefined,
    'solutions engineer|solution engineer|solutions architect|solution architect|customer engineer|pre sales engineer|sales engineer',
  ],
  [
    'customer-success',
    undefined,
    'customer success manager|customer success specialist|customer success engineer',
  ],
  [
    'business-analysis',
    undefined,
    'business analyst|business systems analyst|systems analyst',
  ],
  [
    'marketing',
    undefined,
    'marketing manager|product marketing manager|growth marketing manager|marketing specialist|marketing coordinator|digital marketing manager',
  ],
  [
    'operations',
    undefined,
    'operations manager|business operations manager|operations analyst|operations coordinator|operations specialist',
  ],
  [
    'recruiting',
    undefined,
    'recruiter|technical recruiter|talent acquisition specialist|talent acquisition partner',
  ],
  [
    'technical-writing',
    undefined,
    'technical writer|documentation engineer|technical author',
  ],
  [
    'research',
    undefined,
    'research scientist|research engineer|research associate',
  ],
  [
    'finance',
    undefined,
    'financial analyst|finance manager|financial controller',
  ],
  ['accounting', undefined, 'accountant|bookkeeper|financial accountant'],
  ['nursing', undefined, 'nurse'],
  ['nursing', 'registered', 'registered nurse|rn'],
  ['nursing', 'practical', 'licensed practical nurse|lpn'],
  ['electrician', undefined, 'electrician|industrial electrician'],
];
for (const [family, specialty, aliases] of roleFamilies)
  for (const alias of aliases.split('|'))
    roleAliases.set(alias, { family, specialty });

const levels: Record<string, Level> = {
  junior: 'entry',
  jr: 'entry',
  entry: 'entry',
  'entry level': 'entry',
  associate: 'entry',
  mid: 'mid',
  'mid level': 'mid',
  intermediate: 'mid',
  senior: 'senior',
  sr: 'senior',
  staff: 'staff',
  principal: 'principal',
  lead: 'lead',
};

const levelPrefix =
  /^(entry level|mid level|junior|jr|entry|associate|mid|intermediate|senior|sr|staff|principal|lead) (.+)$/u;
const contextualTitleSuffix =
  /^(?:(?:fully )?remote|hybrid|on site|onsite|full time|part time|contract|temporary|[a-z]{2}-[a-z]{2}|(?:m|f|w|d|x)(?:[ /-](?:m|f|w|d|x)){1,4})$/u;
const productDomain =
  /^(?:payments|billing|identity|fraud|search|growth|developer experience|developer tools|commerce|ecommerce|observability|core product|core services|infrastructure|data infrastructure|security platform|ai infrastructure|ai platform|machine learning platform|cloud platform|platform|integrations|distributed systems|api platform|web platform|database platform|storage|networking|mobile app|supply chain)$/u;

function normalizedTitle(value: string): string {
  return phrase(value.replace(/[.,()\-–—]/gu, ' '));
}

function exactRole(value: string, citation: Citation): Role | undefined {
  const normalized = normalizedTitle(value);
  const level = normalized.match(levelPrefix);
  const name = level?.[2] ?? normalized;
  const role =
    roleAliases.get(name) ??
    roleAliases.get(name.replace(/ (?:i|ii|iii|iv|v)$/u, ''));
  return role
    ? { ...role, level: levels[level?.[1] ?? ''], citation }
    : undefined;
}

function normalizeRole(raw: string, citation: Citation): Role | undefined {
  const exact = exactRole(raw, citation);
  if (exact) return exact;
  // Delimiters are an explicit title structure. Never search for a known job
  // title inside an unrecognized title or remove an arbitrary modifier.
  const parts = raw
    .replace(/\s*\(([^()]+)\)\s*$/u, ' | $1')
    .split(/\s+[-–—/]\s+|\s*[|,]\s*/u);
  if (parts.length < 2) return undefined;
  const [head, ...suffixes] = parts;
  if (!head) return undefined;
  const first = exactRole(head, citation);
  if (!first) return undefined;
  let result = first;
  for (const suffix of suffixes) {
    const detail = normalizedTitle(suffix);
    const specific = exactRole(`${head} ${suffix}`, citation);
    if (specific) result = specific;
    else if (
      !contextualTitleSuffix.test(detail) &&
      !productDomain.test(detail) &&
      !(detail.length > 2 && countryNames.has(detail))
    )
      return undefined;
  }
  return result;
}

type Mode = 'remote' | 'hybrid' | 'onsite';

function workMode(value: string): Mode | undefined {
  switch (phrase(value).replace(/[- ]/gu, '')) {
    case 'remote':
    case 'fullyremote':
      return 'remote';
    case 'hybrid':
      return 'hybrid';
    case 'onsite':
    case 'inoffice':
      return 'onsite';
    default:
      return undefined;
  }
}

const countryNames = new Map<string, string>();
for (const code of onboardingCountryCodes) {
  const country = countryReferenceFromCode(code);
  if (country) countryNames.set(phrase(country.label), code);
}
for (const [name, code] of [
  ['united states of america', 'US'],
  ['the united states', 'US'],
  ['the us', 'US'],
  ['usa', 'US'],
  ['u.s.', 'US'],
  ['uk', 'GB'],
  ['the uk', 'GB'],
  ['u.k.', 'GB'],
  ['great britain', 'GB'],
])
  countryNames.set(name, code);

function countryCode(value: string): string | undefined {
  const code = value.trim().toUpperCase();
  return onboardingCountryCodes.has(code)
    ? code
    : countryNames.get(phrase(value));
}

interface Region {
  /** An explicit country, never inferred from a city or province name. */
  country?: string;
  locality?: string;
}
interface Geography {
  mode?: Mode;
  regions: readonly Region[];
  worldwide: boolean;
  citation: Citation;
}
function region(value: string, source = false): Region | undefined {
  const normalized = phrase(value);
  if (!normalized || normalized.length > 120) return undefined;
  // A posting's short labels can be local abbreviations (e.g. CA or IN).
  // Explicit candidate country choices have a separate country-code contract.
  if (
    source &&
    /^[a-z]{2}$/iu.test(normalized) &&
    !['us', 'uk'].includes(normalized)
  )
    return undefined;
  const country = countryCode(value);
  if (country) return { country };
  // A locality must be a name, with optional administrative divisions.
  // Country scopes (e.g. EMEA, EU) are intentionally left unresolved.
  if (
    !/^[\p{L}][\p{L} .’'-]*(?:, [\p{L}][\p{L} .’'-]*){0,2}$/u.test(
      normalized,
    ) ||
    /\b(?:anywhere|worldwide|global|remote|hybrid|onsite|only|except|within|and|or|any|region|office|time zone|flexible|must|can|cannot|based|eligible|optional|various|multiple|unlisted|unknown|unspecified)\b/u.test(
      normalized,
    ) ||
    /^(?:emea|europe|eu|apac|latam|north america|south america|asia)$/u.test(
      normalized,
    )
  )
    return undefined;
  const parts = normalized.split(', ');
  const final = parts.at(-1);
  // In city lists CA and IN can denote subdivisions. An uppercase code
  // alone is explicit, but an abbreviation after a city is ambiguous.
  const suffix =
    parts.length > 1 && final && final.length > 2
      ? countryCode(final)
      : undefined;
  return suffix
    ? { country: suffix, locality: parts.slice(0, -1).join(', ') }
    : { locality: normalized };
}

function parseGeography(
  raw: string,
  mode: Mode | undefined,
  citation: Citation,
): Geography | undefined {
  let text = raw.trim();
  const prefix = text.match(
    /^(fully remote|remote|hybrid|on[- ]?site)\b\s*(?:[-–—:|,]\s*|in\s+|within\s+)?(.*)$/iu,
  );
  if (prefix) {
    const explicitMode = workMode(prefix[1] ?? '');
    if (mode && explicitMode !== mode) return undefined;
    mode = explicitMode;
    text = (prefix[2] ?? '').trim();
  } else {
    const suffix = text.match(/^(.*?)\s*\((remote|hybrid|on[- ]?site)\)$/iu);
    if (suffix) {
      const explicitMode = workMode(suffix[2] ?? '');
      if (mode && explicitMode !== mode) return undefined;
      mode = explicitMode;
      text = (suffix[1] ?? '').trim();
    }
  }
  text = text
    .replace(/^\((.*)\)$/u, '$1')
    .replace(/\s+only$/iu, '')
    .trim();
  const worldwide = /^(?:worldwide|global|anywhere|work from anywhere)$/iu.test(
    text,
  );
  if (worldwide)
    return mode === 'remote'
      ? { mode, regions: [], worldwide, citation }
      : undefined;
  const values = text.split(/\s*(?:[;|]|\s+or\s+|\s+and\s+)\s*/iu);
  const regions = values.flatMap((value) => {
    const comma = value.split(/,\s*/u);
    if (comma.length > 1 && comma.every((part) => countryCode(part)))
      return comma.map((part) => region(part, true));
    return [region(value, true)];
  });
  if (!regions.length || regions.some((entry) => !entry)) return undefined;
  const known = regions.filter((entry): entry is Region => !!entry);
  // A remote location field can be a board's office metadata. The caller
  // invokes this with an explicitly remote location or permission statement.
  if (
    mode === 'remote' &&
    known.some((entry) => !entry.country || entry.locality)
  )
    return undefined;
  return { mode, regions: known, worldwide: false, citation };
}

interface Qualification {
  slug: string;
  label?: string;
  years?: number;
  context?: 'production' | 'professional';
}
interface Group {
  alternatives: readonly Qualification[];
  citation: Citation;
}
interface Evidence extends Qualification {
  polarity: 'positive' | 'negative';
  citation: Citation;
}

export interface MatchingPostingInput {
  title: string;
  description: string;
  location: string;
  workplaceType?: string;
}

export interface MatchingCandidateInput {
  targetRoles: readonly string[];
  locations: readonly string[];
  remoteCountries?: readonly string[];
  workModes?: readonly string[];
  evidence: readonly {
    id: string;
    text: string;
    kind?: 'skill' | 'fact' | 'experience';
  }[];
  questions?: readonly {
    id: string;
    text: string;
    required: boolean;
    desiredAnswer?: 'yes' | 'no';
    kind?: 'source' | 'fit';
  }[];
  /** The snapshot reader marks missing or corrupt private inputs explicitly. */
  incomplete?: boolean;
}

interface MatchingQuestion {
  citation: Citation;
  desiredAnswer: 'yes' | 'no';
  query?: { type: 'mode'; value: Mode } | { type: 'country'; value: string };
}

export interface NormalizedMatchingPosting {
  role?: Role;
  geography?: Geography;
  required: readonly Group[];
  preferred: readonly Group[];
  preferredUncertainties: readonly MatchingReason[];
  uncertainties: readonly MatchingReason[];
}

export interface NormalizedMatchingCandidate {
  roles: readonly Role[];
  locations: readonly (Region & { citation: Citation })[];
  remoteCountries: readonly (Region & { citation: Citation })[];
  anywhere: boolean;
  unknownLocations: readonly Citation[];
  explicitRemoteCountries: boolean;
  unknownRemoteCountries: readonly Citation[];
  modes: readonly Mode[];
  evidence: readonly (Evidence & {
    satisfies: readonly string[];
    rulesOut: readonly string[];
    related: readonly string[];
  })[];
  questions: readonly MatchingQuestion[];
  uncertainties: readonly MatchingReason[];
}

export interface MatchingReason {
  code: string;
  outcome: 'supported' | 'conflict' | 'unknown';
  message: string;
  citations: readonly Citation[];
}

export interface NormalizedMatchDecision {
  status: 'qualified' | 'conflict' | 'insufficient-evidence';
  score: number;
  reasons: readonly MatchingReason[];
}

function reason(
  code: string,
  outcome: MatchingReason['outcome'],
  message: string,
  ...citations: Citation[]
): MatchingReason {
  return { code, outcome, message, citations };
}

function qualification(
  value: string,
  vocabulary: MatchingVocabulary,
): Qualification | undefined {
  const text = phrase(value);
  const bare = vocabulary.aliases.get(text);
  if (bare) return { slug: bare };
  const normalized = text
    .replace(
      /^(?:you (?:have|bring|possess)|demonstrated|strong|solid|deep|extensive)\s+/u,
      '',
    )
    .replace(/^(?:demonstrated|strong|solid|deep|extensive)\s+/u, '');
  const duration =
    normalized.match(
      /^(?:at least |minimum of )?(\d{1,2})\+? years?(?:['’])? (?:of )?(?:relevant )?(?:(professional|production) )?(?:hands-on )?experience (?:with|in|using|developing with|working with) (.+)$/u,
    ) ??
    normalized.match(
      /^(?:at least |minimum of )?(\d{1,2})\+? years?(?:['’])? (?:of )?(?:(professional|production) )?(.+?) experience$/u,
    );
  const context = normalized.match(
    /^(professional|production) experience (?:with|in|using) (.+)$/u,
  );
  const named = normalized.match(
    /^(?:(?:hands-on )?experience|proficiency|proficient|(?:working )?knowledge|understanding|familiarity) (?:with|in|of|using) (.+)$/u,
  );
  const name = duration?.[3] ?? context?.[2] ?? named?.[1];
  const slug = name && vocabulary.aliases.get(name);
  const qualifier = duration?.[2] ?? context?.[1];
  if (!slug) return undefined;
  return {
    slug,
    years: duration ? Number(duration[1]) : undefined,
    context:
      qualifier === 'professional' || qualifier === 'production'
        ? qualifier
        : undefined,
  };
}

/** Simple explicit conjunctive form. Mixed ungrouped conjunction and disjunction is ambiguous. */
function parseGroups(
  value: string,
  citation: Citation,
  vocabulary: MatchingVocabulary,
): Group[] | undefined {
  const body = value.trim().replace(/[.;]$/u, '');
  const exact = vocabulary.aliases.get(phrase(body));
  if (exact) return [{ citation, alternatives: [{ slug: exact }] }];
  // An Oxford-comma OR list is explicitly disjunctive if its members
  // are simple atoms. Mixed and/or stays subject to the grouping rules below.
  if (/^(?:either|one of)\s+/iu.test(body) || /,\s*or\s+/iu.test(body)) {
    const alternatives = body
      .replace(/^(?:either|one of)\s+/iu, '')
      .replace(/,\s*or\s+/giu, ' or ')
      .split(/\s+or\s+|,\s*/iu)
      .map((atom) => qualification(atom, vocabulary));
    if (
      alternatives.length > 1 &&
      alternatives.every((atom) => atom && !atom.years && !atom.context)
    )
      return [
        {
          citation,
          alternatives: alternatives.filter(
            (atom): atom is Qualification => !!atom,
          ),
        },
      ];
  }
  const conjunctions = body
    .replace(/,\s+and\s+/giu, ' and ')
    .split(/\s+and\s+|,\s*/iu);
  if (
    conjunctions.length > 1 &&
    /\sor\s/iu.test(body) &&
    conjunctions.some(
      (item, index) =>
        /\sor\s/iu.test(item) &&
        !(
          /^\(.*\)$/u.test(item.trim()) ||
          (index === conjunctions.length - 1 && /^either\s+/iu.test(item))
        ),
    )
  )
    return undefined;
  const groups = conjunctions.map((item) => {
    const unit = item
      .trim()
      .replace(/^\((.*)\)$/u, '$1')
      .replace(/^either\s+/iu, '');
    return unit
      .split(/\s+or\s+/iu)
      .map((atom) => qualification(atom, vocabulary));
  });
  if (groups.some((alternatives) => alternatives.some((atom) => !atom)))
    return undefined;
  // A leading duration or context can scope the entire list. Require
  // each alternative to spell out its qualifier if one is present.
  const atoms = groups.flat();
  if (
    atoms.length > 1 &&
    atoms.some((atom) => atom?.years || atom?.context) &&
    atoms.some((atom) => !atom?.years && !atom?.context)
  )
    return undefined;
  return groups.map((alternatives) => ({
    citation,
    alternatives: alternatives.filter((atom): atom is Qualification =>
      Boolean(atom),
    ),
  }));
}

const maxDescriptionLength = 40_000;

function descriptionLines(raw: string) {
  // Blanking markup preserves offsets into the captured source.
  const normalized = raw
    .slice(0, maxDescriptionLength)
    .replace(
      /<[^<>\n]+>/gu,
      (tag) =>
        (/^<\/?(?:p|li|div|h[1-6]|section|ul|ol|br)\b/iu.test(tag)
          ? '\n'
          : ' ') + ' '.repeat(tag.length - 1),
    )
    .replace(/&nbsp;/gu, ' '.repeat(6));
  const lines: Array<{ text: string; citation: Citation }> = [];
  for (const match of normalized.matchAll(/[^\r\n]+/gu)) {
    const full = match[0];
    const cleaned = full.replace(/^\s*(?:[-*•]\s+)?/u, '').trimEnd();
    if (!cleaned) continue;
    const start = match.index + full.indexOf(cleaned);
    lines.push({
      text: cleaned,
      citation: cite('description', raw, start, start + cleaned.length),
    });
  }
  return lines;
}

const requiredHeader =
  /^(?:required(?: skills| qualifications| experience| skills and experience)?|minimum (?:skills|qualifications|requirements)|basic qualifications|core qualifications|qualifications|requirements|skills and qualifications|about you|who you are|must[- ]haves|what (?:you.ll|you will) (?:need|bring)|what you bring|what we(?:.re| are)? look(?:ing)? for|what makes you a great fit|your skills and experience)\s*[:：]?\s*$/iu;
const preferredHeader =
  /^(?:preferred(?: skills| qualifications| experience| skills and experience)?|nice[- ]to[- ]haves?|bonus(?: skills| points)?|bonus points (?:if|for)|desired qualifications|optional qualifications|it.d be great if you (?:have|also have))\s*[:：]?\s*$/iu;
const dutiesHeader =
  /^(?:responsibilities|(?:key|job|role) responsibilities|duties|what (?:you.ll|you will) (?:do|be doing)|your (?:impact|mission)|how you.ll make an impact|about (?:us|the (?:role|team|job|company|position))|the (?:role|opportunity|team)|who we are|what is the role)\s*[:：]?\s*$/iu;
const explicitDutiesHeader =
  /^(?:responsibilities|(?:key|job|role) responsibilities|duties|what (?:you.ll|you will) (?:do|be doing))\s*[:：]?\s*$/iu;
const administrativeHeader =
  /^(?:(?:our )?benefits(?: and (?:compensation|perks)| built for you)?|perks(?: and benefits)?|compensation(?: and benefits| range)?|total rewards|(?:(?:base|annual|local|[a-z]{2}) )?(?:pay|salary) range|base (?:salary|pay)|salary|equity (?:grant|compensation)|what we offer|what.s in it for you|why (?:join|work with|work for) us|how to apply|application (?:process|deadline)|(?:recruiting|interview) process|(?:our |about our )?hiring process|hiring and how we work|equal (?:employment )?opportunit(?:y|ies)(?: statement| employer)?|diversity (?:and|&) inclusion|our commitment to (?:diversity|inclusion)|accommodations|reasonable accommodation|privacy(?: notice| statement)|candidate privacy(?: notice)?)\s*[:：]?\s*$/iu;
// These predicates identify actual employment conditions even in footer prose.
const employmentCondition =
  /\b(?:(?:candidates?|applicants?|you|employees?) (?:will |also )?(?:must|are required to|is required to|need to)|must (?:also |currently )?(?:be|have|hold|possess|work|live|reside|travel|speak|demonstrate|pass|provide|maintain|complete|meet|commit)|(?:employment|hire|offer) is (?:conditional|contingent)|(?:existing|valid|unrestricted) (?:work authori[sz]ation|security clearance)|(?:work|visa) sponsorship (?:is not|not|(?:is )?unavailable)|(?:we|the company) (?:cannot|can not|do not|don.t|will not|won.t) sponsor|right to work|authori[sz]ed to work|willingness to travel|(?:required|expected) to travel|only (?:candidates|applicants) (?:in|based|located)|(?:will|must) require (?:travel|relocation)|required (?:work|office) hours)\b/iu;
const essentialCondition =
  /\b(?:you(?:['’]ll| will) need(?: to)?|you need to|(?:is|are) essential|essential (?:qualifications|requirements|skills|experience))\b/iu;
const hardLanguage =
  /\b(?:must|required|mandatory|essential|minimum|at least|work authori[sz]ation|citizenship|background check|clearance|licen[cs]e|certification|degree|on[- ]call|weekends?|relocation|time ?zones?|working hours|business hours|office attendance|shift)\b/iu;
const administrativeProse =
  /^(?:we are (?:an? )?equal (?:employment )?opportunity employer|all qualified applicants will receive consideration|qualified applicants will be considered without regard|if you (?:require|need) (?:a reasonable )?accommodation|in accordance with (?:applicable|local|state) law|the (?:base )?(?:salary|pay|compensation)(?: range)? (?:for|is|listed))\b/iu;
const optionalLanguage =
  /^(?:preferred|optional|nice[- ]to[- ]have|bonus)\b|\b(?:preferred|a plus|optional|desirable|nice[- ]to[- ]have|not required)(?: but not required)?\s*\.?$/iu;
const noRequirements =
  /^(?:no (?:additional )?(?:(?:mandatory|required|minimum|hard|formal|prior) )?(?:skills|qualifications|requirements|experience)(?: (?:(?:are|is) )?required)?|none)[.!]?$/iu;
const requiredInAdministrativeText =
  /\b(?:(?:work authori[sz]ation|citizenship|security clearance|background check|(?:driver.s|professional|occupational) licen[cs]e|residency|residence) .{0,70}\b(?:required|mandatory)|(?:required|mandatory) .{0,50}\b(?:work authori[sz]ation|citizenship|security clearance|background check))\b/iu;
const genericRoleLabel =
  /^(?:(?:full[- ]time |contract )?(?:position|opportunity|opening|vacancy)|job opening)$/iu;
const geographicLine =
  /^(?:(?:work )?location\s*:\s*(.+)|(?:(?:this|the) (?:role|position|job) is )?((?:fully )?remote\s+(?:in|within|from)\s+.+)|((?:candidates|applicants) must be based in .+))$/iu;

function postingRole(
  raw: MatchingPostingInput,
  lines: ReturnType<typeof descriptionLines>,
) {
  const title = cite('title', raw.title);
  const explicit = normalizeRole(raw.title, title);
  if (explicit) return explicit;
  // A direct hiring statement can resolve a generic label. If the title
  // names another occupation or multiple roles, preserve the uncertainty.
  if (!genericRoleLabel.test(raw.title.trim())) return undefined;
  const declared = lines.slice(0, 20).flatMap(({ text, citation }) => {
    const statement = text.match(
      /^(?:we are|we.re) (?:hiring|seeking|looking for) (?:a|an) (.{1,100}?)(?: (?:to|who will|who can|for our|for the)\b|[.!]?$)/iu,
    );
    const role = statement?.[1] && normalizeRole(statement[1], citation);
    return role ? [role] : [];
  });
  const first = declared[0];
  return first &&
    declared.every(
      ({ family, specialty, level }) =>
        family === first.family &&
        specialty === first.specialty &&
        level === first.level,
    )
    ? first
    : undefined;
}

function sameGeography(left: Geography, right: Geography): boolean {
  if (
    left.worldwide !== right.worldwide ||
    (left.mode && right.mode && left.mode !== right.mode)
  )
    return false;
  const key = (entry: Region) =>
    `${entry.country ?? ''}:${entry.locality ?? ''}`;
  return (
    left.regions.map(key).sort().join('|') ===
    right.regions.map(key).sort().join('|')
  );
}

function stripRequirementWording(content: string) {
  return content
    .replace(
      /^(?:(?:you |candidates? |applicants? )?must (?:have|possess|demonstrate)|you (?:have|bring|possess))\s+/iu,
      '',
    )
    .replace(/^(?:preferred|optional|nice[- ]to[- ]have|bonus)\s*:\s*/iu, '')
    .replace(
      /\s+(?:is |are )?(?:required|preferred|optional|a plus|desirable)(?: but not required)?\s*\.?$/iu,
      '',
    );
}

function sameGroup(
  left: readonly Qualification[],
  right: readonly Qualification[],
) {
  const key = ({ slug, label, years, context }: Qualification) =>
    JSON.stringify([slug || phrase(label ?? ''), years, context]);
  return (
    JSON.stringify(left.map(key).sort()) ===
    JSON.stringify(right.map(key).sort())
  );
}

function sourceSpan(
  raw: MatchingPostingInput,
  span: MatchingSourceSpan,
): Citation | undefined {
  const value = raw[span.field];
  if (
    span.start < 0 ||
    span.end <= span.start ||
    value.slice(span.start, span.end) !== span.quote
  )
    return undefined;
  return cite(span.field, value, span.start, span.end);
}

interface VerifiedExtractionGroup {
  selected: Group;
  clause: Citation;
}

const supplementalLimit =
  /\b(?:certifications?|licen[cs]es?|licensed|security clearance|background checks?|degrees?|diplomas?|citizenship|sponsorship|work authori[sz]ation|right to work|authori[sz]ed to work|time ?zones?|business hours|shifts?|weekends?|travel|relocation|residency|on[- ]call|recen(?:t|tly|cy)|large[- ]scale|high[- ]throughput|at scale|enterprise[- ]scale|direct reports?|minimum team size)\b/iu;
const omittedLogic =
  /\b(?:and|or|plus|as well as|together with|along with|no|not|never|without|unless|except|excluding|instead of|equivalent to)\b|[,;&|/]/iu;
const independentHardCue =
  /\b(?:must|required|mandatory|essential|minimum|at least|only candidates|condition of employment)\b/iu;

function hasGovernedCapabilityOutsideProof(
  value: string,
  vocabulary: MatchingVocabulary,
) {
  const text = phrase(value);
  const word = /[\p{L}\p{N}_]/u;
  for (const start of text.matchAll(/(?<![\p{L}\p{N}_])[\p{L}\p{N}]/gu)) {
    // Short aliases are ambiguous in ordinary prose. Explicit conjunctions
    // still protect their omission. Bound work independently of graph size.
    const limit = Math.min(text.length, start.index + 150);
    for (let end = start.index + 4; end <= limit; end += 1) {
      if (
        !word.test(text[end] ?? '') &&
        vocabulary.aliases.has(text.slice(start.index, end))
      )
        return true;
    }
  }
  return false;
}

function supplementalQualification(
  clause: Citation,
  capabilities: readonly Citation[],
  mapped: readonly Qualification[],
  vocabulary: MatchingVocabulary,
) {
  let previous = clause.start;
  const gaps = capabilities.map((capability) => {
    const gap = clause.text.slice(
      previous - clause.start,
      capability.start - clause.start,
    );
    previous = capability.end;
    return gap;
  });
  gaps.push(clause.text.slice(previous - clause.start));
  const first = gaps[0] ?? '';
  const last = gaps.at(-1) ?? '';
  const middle = gaps.slice(1, -1);
  // Anything outside the named witness must preserve its qualifiers and
  // cannot hide additional capabilities, conditions, or logical operators.
  if (
    supplementalLimit.test(clause.text) ||
    omittedLogic.test(first) ||
    omittedLogic.test(last) ||
    gaps.some((gap) => hasGovernedCapabilityOutsideProof(gap, vocabulary)) ||
    /(?:\be\.g\.|\b(?:such as|for example|including|depending on|subject to)\b)/iu.test(
      clause.text,
    )
  )
    return false;
  const oxford =
    middle.length > 1 && /^\s*,\s*or\s*$/iu.test(middle.at(-1) ?? '');
  if (
    middle.some(
      (gap, index) =>
        !(oxford && index < middle.length - 1 && /^\s*,\s*$/u.test(gap)) &&
        !/^\s*,?\s*or\s*$/iu.test(gap),
    )
  )
    return false;
  const years = [...clause.text.matchAll(/\b(\d{1,2})\+?\s+years?\b/giu)].map(
    (match) => Number(match[1]),
  );
  const contexts = [
    ...clause.text.matchAll(/\b(professional|production)\b/giu),
  ].map((match) => match[1]?.toLowerCase());
  const durationWords = [
    ...clause.text.matchAll(/\b(?:years?|months?|weeks?)\b/giu),
  ];
  return (
    years.length === durationWords.length &&
    new Set(years).size <= 1 &&
    new Set(contexts).size <= 1 &&
    !/\b\d+(?:[.,]\d+|\s*(?:[-–—]|to)\s*\d+)\+?\s*years?\b/iu.test(
      clause.text,
    ) &&
    mapped.every(
      (atom) => atom.years === years[0] && atom.context === contexts[0],
    )
  );
}

function supportedExtractionGroup(
  raw: MatchingPostingInput,
  lines: ReturnType<typeof descriptionLines>,
  input: MatchingSourceExtraction['required'][number],
  vocabulary: MatchingVocabulary,
  hard: boolean,
): VerifiedExtractionGroup | undefined {
  const clause = sourceSpan(raw, input.clause);
  if (clause?.field !== 'description') return undefined;
  const line = lines.find(
    ({ citation }) =>
      citation.start <= clause.start && citation.end >= clause.end,
  );
  if (!line) return undefined;
  const proofs = input.alternatives
    .flatMap(({ capability, years, context }) => {
      const citation = sourceSpan(raw, capability);
      if (
        citation?.field !== 'description' ||
        citation.start < clause.start ||
        citation.end > clause.end
      )
        return [];
      const slug = vocabulary.aliases.get(phrase(citation.text));
      // A quoted but ungoverned atomic term can still occupy a verified
      // alternative. It cannot prove any capability, and compound or
      // otherwise ambiguous unknown text cannot hide a conjunct.
      if (
        !slug &&
        (!/^[\p{L}\p{N}][\p{L}\p{N} .+#()-]{0,69}$/u.test(citation.text) ||
          omittedLogic.test(citation.text) ||
          supplementalLimit.test(citation.text) ||
          independentHardCue.test(citation.text))
      )
        return [];
      return [
        {
          citation,
          slug: slug ?? '',
          label: slug ? vocabulary.labels.get(slug) : citation.text,
          years: years ?? undefined,
          context: context ?? undefined,
        },
      ];
    })
    .sort((left, right) => left.citation.start - right.citation.start);
  if (
    !proofs.length ||
    proofs.length !== input.alternatives.length ||
    proofs.some(
      ({ citation }, index) =>
        index > 0 && citation.start < (proofs[index - 1]?.citation.end ?? 0),
    )
  )
    return undefined;
  const mapped = proofs.map(({ slug, label, years, context }) => ({
    slug,
    label,
    years,
    context,
  }));
  const header = line.text.split(/[:：]/u, 1)[0] ?? '';
  if (
    hard &&
    (optionalLanguage.test(clause.text) || preferredHeader.test(header))
  )
    return undefined;
  if (
    !hard &&
    (employmentCondition.test(clause.text) ||
      essentialCondition.test(clause.text) ||
      mixedCandidateCondition(clause.text) ||
      independentHardCue.test(clause.text) ||
      requiredHeader.test(header))
  )
    return undefined;

  const value = stripRequirementWording(
    clause.text.replace(
      /^(?:required(?: skills| qualifications| experience)?|minimum qualifications|requirements|qualifications|preferred(?: skills| qualifications| experience)?)\s*[:：]\s*/iu,
      '',
    ),
  );
  const parsed = parseGroups(value, clause, vocabulary);
  const deterministic =
    parsed?.length === 1 && sameGroup(parsed[0]?.alternatives ?? [], mapped);
  if (
    !deterministic &&
    !supplementalQualification(
      clause,
      proofs.map(({ citation }) => citation),
      mapped,
      vocabulary,
    )
  )
    return undefined;
  return {
    selected: { alternatives: mapped, citation: line.citation },
    clause,
  };
}

function coversRequirementLine(
  citation: Citation,
  groups: readonly VerifiedExtractionGroup[],
) {
  const relevant = groups
    .filter(
      ({ selected }) =>
        selected.citation.start === citation.start &&
        selected.citation.end === citation.end,
    )
    .sort((a, b) => a.clause.start - b.clause.start);
  const first = relevant[0];
  if (!first) return false;
  const prefix = citation.text
    .slice(0, first.clause.start - citation.start)
    .trim();
  const prefixHeader = prefix.replace(/[:：]$/u, '').trim();
  if (
    prefix &&
    !requiredHeader.test(prefixHeader) &&
    !preferredHeader.test(prefixHeader) &&
    !/^[(*_#]+$/u.test(prefix)
  )
    return false;
  for (let i = 1; i < relevant.length; i += 1) {
    const before = relevant[i - 1];
    const after = relevant[i];
    if (!before || !after || before.clause.end > after.clause.start)
      return false;
    const join = citation.text.slice(
      before.clause.end - citation.start,
      after.clause.start - citation.start,
    );
    if (
      !/^\s*(?:(?:[,;]\s*)?(?:and|as well as|along with)|[,;])\s*$/iu.test(join)
    )
      return false;
    // A qualifier at the start of a conjunctive list can scope later
    // capabilities too. A shorter selected clause cannot weaken that scope.
    if (
      !/^\s*;/u.test(join) &&
      before.selected.alternatives.some((atom) => atom.years || atom.context) &&
      after.selected.alternatives.some((atom) => !atom.years && !atom.context)
    )
      return false;
    // A bare mixed A or B and C does not establish an AND-of-OR grouping.
    if (
      before.selected.alternatives.length > 1 &&
      !/^\s*;/u.test(join) &&
      !/^\s*\(.*\)\s*$/u.test(before.clause.text)
    )
      return false;
    if (
      after.selected.alternatives.length > 1 &&
      !/^\s*;/u.test(join) &&
      !/^\s*(?:either\b|\()/iu.test(after.clause.text)
    )
      return false;
  }
  const end = relevant.at(-1)?.clause.end ?? first.clause.end;
  return /^[\s.!?)*_]*$/u.test(citation.text.slice(end - citation.start));
}

function extractedDescriptionLine(
  raw: MatchingPostingInput,
  lines: ReturnType<typeof descriptionLines>,
  span: MatchingSourceSpan | null,
) {
  const citation = span && sourceSpan(raw, span);
  if (citation?.field !== 'description') return undefined;
  return lines.find(
    (line) =>
      line.citation.start === citation.start &&
      line.citation.end === citation.end,
  );
}

const roleStatement =
  /\b(?:hiring|seeking|looking for|join (?:us|our (?:company|team)) as|(?:role|position|opening|job) (?:is|for)|join us in the role of)\b/iu;
const roleQualifier =
  /\b(?:engineer|developer|designer|manager|scientist|director|architect|analyst|lead|head|specialist|account executive|senior|staff|principal|frontend|back[- ]?end|full[- ]?stack|mobile)\b/iu;

function sourceRole(
  raw: MatchingPostingInput,
  lines: ReturnType<typeof descriptionLines>,
  extraction: MatchingSourceExtraction,
) {
  const span = extraction.role;
  const citation = span && sourceSpan(raw, span);
  const title = extraction.roleTitle;
  if (
    citation?.field === 'title' &&
    citation.start === 0 &&
    citation.end === raw.title.length &&
    title &&
    citation.text.startsWith(title)
  ) {
    const suffix = citation.text.slice(title.length);
    if (
      /^\s*(?:[-–—|,]|\()/u.test(suffix) &&
      !roleQualifier.test(suffix) &&
      !/\b(?:or|and|either)\b/iu.test(suffix)
    )
      return normalizeRole(title, citation);
  }
  const line = extractedDescriptionLine(raw, lines, span);
  if (!line) return undefined;
  const explicit = line.text.match(
    /^(?:the primary role is|this position is for) (?:a|an) (.+?)\.?$/iu,
  )?.[1];
  if (explicit) return normalizeRole(explicit, line.citation);
  const offset = title ? line.text.indexOf(title) : -1;
  if (!title || offset < 0) return undefined;
  const prefix = line.text.slice(0, offset);
  const suffix = line.text.slice(offset + title.length);
  return roleStatement.test(prefix) &&
    !/\b(?:no|not|never|instead|or)\b/iu.test(prefix) &&
    !/^\s*(?:or|and\s+(?:a|an)|\/)\b/iu.test(suffix) &&
    (!suffix || /^[\s.,;:()–—-]/u.test(suffix))
    ? normalizeRole(title, line.citation)
    : undefined;
}

function sourceGeography(
  raw: MatchingPostingInput,
  lines: ReturnType<typeof descriptionLines>,
  extraction: MatchingSourceExtraction,
) {
  const span = extraction.geography;
  const line = extractedDescriptionLine(raw, lines, span);
  const declaredMode = workMode(raw.workplaceType ?? '');
  const exact = line?.text.match(
    /^(?:(?:you|employees|staff) (?:may|can)|this (?:role|position) lets you) work remotely (?:from|in|within) (.+?)\.?$/iu,
  )?.[1];
  if (exact && line && (!declaredMode || declaredMode === 'remote')) {
    return (
      parseGeography(
        exact.replace(/^anywhere (?:from |in |within )?/iu, ''),
        'remote',
        line.citation,
      ) ?? parseGeography(exact, 'remote', line.citation)
    );
  }

  const mode = extraction.workplaceType;
  const location = extraction.workLocation;
  const citation =
    line?.citation ??
    (span?.field === 'location' &&
    span.start === 0 &&
    span.end === raw.location.length
      ? sourceSpan(raw, span)
      : undefined);
  if (
    !mode ||
    !location ||
    !citation ||
    (declaredMode && declaredMode !== mode)
  )
    return undefined;
  const text = line?.text ?? citation.text;
  const offset = text.indexOf(location);
  if (offset < 0) return undefined;
  const prefix = text.slice(0, offset);
  const suffix = text.slice(offset + location.length);
  if (
    /\b(?:no|not|never|except|excluding|outside|other than|unless|but|only if)\b/iu.test(
      text,
    ) ||
    !/^\s*(?:only)?\s*[.!)]*\s*$/iu.test(suffix)
  )
    return undefined;
  const modeCue =
    mode === 'remote'
      ? /\bremote(?:ly)?\b/iu
      : mode === 'hybrid'
        ? /\bhybrid\b/iu
        : /\b(?:on[- ]?site|in[- ]office)\b/iu;
  if (!modeCue.test(text)) return undefined;
  if (
    line &&
    !/\b(?:from|within|in|based in|located in|open to)\s+(?:anywhere in\s+)?$/iu.test(
      prefix,
    )
  )
    return undefined;
  if (
    !line &&
    !/^\s*(?:(?:fully )?remote|hybrid|on[- ]?site)\s*[(,;|:–—-]?\s*$/iu.test(
      prefix,
    )
  )
    return undefined;
  return parseGeography(location, mode, citation);
}

// Candidate expectations can be embedded in benefits, duties, or metadata.
// Classify the clause itself before applying any section or preference label.
const capabilityExpectation =
  /\b(?:knowledge|proficien(?:t|cy)|experience|qualifications?|skills?|fluency|background in)\b/iu;
const standaloneQualification =
  /^(?:(?:working |strong |practical |demonstrable |hands-on )?(?:knowledge|proficiency|experience|fluency) (?:in|with|using|of)\b|[\p{L}\p{N}+#. -]{1,60} (?:knowledge|proficiency|fluency|experience)[.!]?$)/iu;

function mixedCandidateCondition(text: string) {
  const role = roleStatement.test(text);
  const metadata =
    role ||
    geographicLine.test(text) ||
    administrativeProse.test(text) ||
    /\b(?:we (?:offer|provide|are)|our (?:benefits|company)|benefits|compensation|remote|hybrid|onsite)\b/iu.test(
      text,
    );
  return (
    /\b(?:expect(?:s|ed|ation)?|prerequisites?|core skills?|core capabilit(?:y|ies)|non[- ]negotiable|candidate (?:criteria|background)|demonstrated (?:ability|proficiency|experience))\b/iu.test(
      text,
    ) ||
    (capabilityExpectation.test(text) &&
      (metadata
        ? /[,;]|\b(?:and|but|while|provided that|subject to)\b/iu.test(text)
        : /\b(?:and|but|while) (?:you|candidates?|applicants?)\b/iu.test(
            text,
          ))) ||
    (role &&
      /\b(?:with|who (?:has|have|brings|bring|knows|know))\b/iu.test(text))
  );
}

function sectionHasCandidateQualification(text: string) {
  return text
    .split(/[,;:]|\b(?:and|but|while)\b/iu)
    .some((clause) => standaloneQualification.test(clause.trim()));
}

function independentApplicantCondition(text: string) {
  return (
    employmentCondition.test(text) ||
    essentialCondition.test(text) ||
    requiredInAdministrativeText.test(text) ||
    mixedCandidateCondition(text)
  );
}

function postingHeading(text: string) {
  const header = text.match(
    /^(?:#{1,6}\s*)?(?:\*\*)?([^:：]+?)(?:\*\*)?(?:\s*[:：]\s*(.*))?$/u,
  );
  return {
    head: header?.[1]?.trim() ?? '',
    tail: header?.[2]?.replace(/^\*\*\s*/u, '').trim(),
  };
}

function sameSourceLine(left: Citation, right: Citation) {
  return (
    left.field === right.field &&
    left.start === right.start &&
    left.end === right.end
  );
}

function hasCompleteDescriptionCoverage(
  lines: ReturnType<typeof descriptionLines>,
  verifiedGroups: readonly VerifiedExtractionGroup[],
  supportedLines: readonly Citation[],
) {
  let inNonRequirementSection = false;
  return lines.every(({ text, citation }) => {
    const { head, tail } = postingHeading(text);
    const administrative = administrativeHeader.test(head);
    const duties = dutiesHeader.test(head);
    const requirement = requiredHeader.test(head) || preferredHeader.test(head);
    if (administrative || duties || requirement) {
      // A general section such as "About the role" can contain requirements.
      // Only an explicit duties/administrative section accounts for its prose.
      inNonRequirementSection =
        administrative || explicitDutiesHeader.test(head);
      if (!tail) return true;
    }
    return (
      (inNonRequirementSection &&
        !independentApplicantCondition(text) &&
        !sectionHasCandidateQualification(text)) ||
      supportedLines.some((proof) => sameSourceLine(proof, citation)) ||
      coversRequirementLine(citation, verifiedGroups)
    );
  });
}

function mergeSourceExtraction(
  raw: MatchingPostingInput,
  lines: ReturnType<typeof descriptionLines>,
  posting: NormalizedMatchingPosting,
  extraction: MatchingSourceExtraction,
  vocabulary: MatchingVocabulary,
): NormalizedMatchingPosting {
  const hard = extraction.required.map((group) =>
    supportedExtractionGroup(raw, lines, group, vocabulary, true),
  );
  const recovered = hard.flatMap((group) => (group ? [group] : []));
  const claims = recovered.map(({ selected }) => selected);
  const coveredLine = (citation: Citation) =>
    coversRequirementLine(citation, recovered);
  const missingConjunct = claims.some(({ citation }) => !coveredLine(citation));
  const newRequired = claims.filter(
    (group) =>
      !posting.required.some(({ alternatives }) =>
        sameGroup(alternatives, group.alternatives),
      ),
  );
  const verifiedPreferred = extraction.preferred.flatMap((group) => {
    const supported = supportedExtractionGroup(
      raw,
      lines,
      group,
      vocabulary,
      false,
    );
    return supported ? [supported] : [];
  });
  const newPreferred = verifiedPreferred
    .map(({ selected }) => selected)
    .filter(
      (group) =>
        !posting.preferred.some(({ alternatives }) =>
          sameGroup(alternatives, group.alternatives),
        ),
    );
  const noHard =
    extraction.noRequirements && sourceSpan(raw, extraction.noRequirements);
  const emptyAttested =
    noHard?.field === 'description' &&
    lines.some(
      ({ text, citation }) =>
        citation.start === noHard.start &&
        citation.end === noHard.end &&
        noRequirements.test(text) &&
        phrase(text) !== 'none',
    );
  const complete =
    extraction.coverage === 'complete' &&
    !extraction.unresolved.length &&
    hard.length === recovered.length &&
    !missingConjunct &&
    (recovered.length > 0 || emptyAttested) &&
    raw.description.length <= maxDescriptionLength;
  const declaredRole = sourceRole(raw, lines, extraction);
  const roleConflict = Boolean(
    declaredRole &&
      posting.role &&
      (declaredRole.family !== posting.role.family ||
        (declaredRole.specialty &&
          posting.role.specialty &&
          declaredRole.specialty !== posting.role.specialty) ||
        (declaredRole.level &&
          posting.role.level &&
          declaredRole.level !== posting.role.level)),
  );
  const role = roleConflict
    ? undefined
    : (posting.role ??
      (genericRoleLabel.test(raw.title.trim()) ||
      declaredRole?.citation.field === 'title'
        ? declaredRole
        : undefined));
  const declaredGeography = sourceGeography(raw, lines, extraction);
  const geographyConflict = Boolean(
    declaredGeography &&
      posting.geography &&
      !sameGeography(declaredGeography, posting.geography),
  );
  // An unresolved original geography may still carry restrictions. Only use
  // description evidence to fill a genuinely absent location.
  const missingLocation =
    !raw.location.trim() ||
    workMode(raw.location) === 'remote' ||
    declaredGeography?.citation.field === 'location';
  const geography = geographyConflict
    ? undefined
    : (posting.geography ??
      (missingLocation &&
      !posting.uncertainties.some(
        ({ code }) => code === 'posting-geography-ambiguous',
      )
        ? declaredGeography
        : undefined));
  // Only a provider-assisted recovery of missing deterministic requirements
  // coverage needs whole-description accounting. Known hard lines still have
  // their independent proof gate whether or not recovery is needed. A role
  // or geography citation does not attest to other conditions on its line.
  const incomplete = posting.uncertainties.some(
    ({ code }) => code === 'posting-requirements-incomplete',
  );
  const mayClearIncomplete =
    complete &&
    (!incomplete ||
      hasCompleteDescriptionCoverage(
        lines,
        [...recovered, ...verifiedPreferred],
        [
          ...posting.preferred.map(({ citation }) => citation),
          ...(emptyAttested ? [noHard] : []),
        ].filter((citation): citation is Citation => !!citation),
      ));
  const uncertainties = posting.uncertainties.filter(({ code, citations }) => {
    if (code === 'posting-role-unknown' && role) return false;
    if (code === 'posting-geography-unknown' && geography) return false;
    if (code === 'posting-requirements-incomplete') return !mayClearIncomplete;
    if (code !== 'posting-requirement-unknown' || !complete) return true;
    return !citations.length || !citations.every(coveredLine);
  });
  if (roleConflict && declaredRole && posting.role)
    uncertainties.push(
      reason(
        'posting-role-ambiguous',
        'unknown',
        'The posting gives conflicting role descriptions.',
        posting.role.citation,
        declaredRole.citation,
      ),
    );
  if (geographyConflict && declaredGeography && posting.geography)
    uncertainties.push(
      reason(
        'posting-geography-ambiguous',
        'unknown',
        'The posting gives conflicting work locations.',
        posting.geography.citation,
        declaredGeography.citation,
      ),
    );
  for (const span of extraction.unresolved) {
    const citation = sourceSpan(raw, span);
    if (citation)
      uncertainties.push(
        reason(
          'posting-requirement-unknown',
          'unknown',
          'A required condition could not be verified from the posting.',
          citation,
        ),
      );
  }
  if (hard.length !== recovered.length || missingConjunct)
    uncertainties.push(
      reason(
        'posting-requirement-unknown',
        'unknown',
        'A required condition could not be verified from the posting.',
      ),
    );
  return {
    ...posting,
    role,
    geography,
    required: [...posting.required, ...newRequired],
    preferred: [...posting.preferred, ...newPreferred],
    uncertainties,
  };
}

export function normalizeMatchingPosting(
  raw: MatchingPostingInput,
  vocabulary: MatchingVocabulary,
  extraction?: MatchingSourceExtraction,
): NormalizedMatchingPosting {
  const title = cite('title', raw.title);
  const lines = descriptionLines(raw.description);
  const role = postingRole(raw, lines);
  const uncertainties: MatchingReason[] = [];
  if (!role)
    uncertainties.push(
      reason(
        'posting-role-unknown',
        'unknown',
        'The posting’s role is unclear.',
        title,
      ),
    );

  const location = cite('location', raw.location);
  const declaredMode = workMode(raw.workplaceType ?? '');
  const explicitRemoteLocation =
    /^\s*(?:fully\s+)?remote\b|\(remote\)\s*$/iu.test(raw.location);
  const mode = declaredMode ?? (explicitRemoteLocation ? 'remote' : undefined);
  let geography =
    mode !== 'remote' || explicitRemoteLocation
      ? parseGeography(raw.location, mode, location)
      : undefined;
  let conflictingGeography = false;
  const required: Group[] = [];
  const preferred: Group[] = [];
  const preferredUncertainties: MatchingReason[] = [];
  let seenHardMaterial = false;
  let section:
    | 'required'
    | 'preferred'
    | 'duties'
    | 'administrative'
    | undefined;
  for (const { text, citation } of lines) {
    const { head, tail } = postingHeading(text);
    const requiredSection = requiredHeader.test(head);
    const preferredSection = preferredHeader.test(head);
    if (requiredSection || preferredSection) {
      section = requiredSection ? 'required' : 'preferred';
      if (!tail) continue;
    } else if (dutiesHeader.test(head) || administrativeHeader.test(head)) {
      section = administrativeHeader.test(head) ? 'administrative' : 'duties';
      if (!tail) continue;
    }
    const geo = text.match(geographicLine);
    if (geo && !mixedCandidateCondition(text)) {
      const assertion =
        geo[1] ??
        (geo[2]
          ? geo[2].replace(/\bremote from\b/iu, 'remote within')
          : undefined) ??
        geo[3]?.replace(
          /^.*?\bbased in\s+/iu,
          mode === 'remote' ? 'remote within ' : '',
        ) ??
        '';
      const currentMode = mode ?? geography?.mode;
      const officeMetadata =
        geo[1] &&
        currentMode === 'remote' &&
        !/^\s*(?:fully\s+)?remote\b|\(remote\)\s*$/iu.test(assertion);
      if (
        officeMetadata &&
        !independentApplicantCondition(text) &&
        !hardLanguage.test(text)
      )
        continue;
      if (officeMetadata) {
        uncertainties.push(
          reason(
            'posting-requirement-unknown',
            'unknown',
            'A required condition could not be verified from the posting.',
            citation,
          ),
        );
        seenHardMaterial = true;
        continue;
      }
      const stated = parseGeography(
        assertion.replace(/\.$/u, ''),
        currentMode,
        citation,
      );
      if (!stated || (geography && !sameGeography(geography, stated))) {
        conflictingGeography = true;
        uncertainties.push(
          reason(
            'posting-geography-ambiguous',
            'unknown',
            'The posting has an unclear or conflicting work location.',
            citation,
          ),
        );
      } else {
        geography = stated;
      }
      continue;
    }
    const content = tail && (requiredSection || preferredSection) ? tail : text;
    if (
      section !== 'preferred' &&
      section !== 'administrative' &&
      noRequirements.test(content) &&
      (section === 'required' || phrase(content) !== 'none')
    ) {
      seenHardMaterial = true;
      continue;
    }
    const requiredWording = content.replace(/\bnot required\b/giu, '');
    const strong =
      independentApplicantCondition(requiredWording) ||
      ((section === 'administrative' || section === 'duties') &&
        sectionHasCandidateQualification(requiredWording));
    const explicitHard =
      strong ||
      /\b(?:must|required|mandatory|minimum)\b/iu.test(requiredWording);
    const optional =
      !explicitHard &&
      (optionalLanguage.test(content) || section === 'preferred');
    if (
      !optional &&
      section !== 'required' &&
      !strong &&
      (section === 'administrative' || !hardLanguage.test(content))
    )
      continue;
    const hard = !optional;
    if (hard) seenHardMaterial = true;
    const value = stripRequirementWording(content);
    const groups = parseGroups(value, citation, vocabulary);
    if (groups) (hard ? required : preferred).push(...groups);
    else {
      (hard ? uncertainties : preferredUncertainties).push(
        reason(
          hard ? 'posting-requirement-unknown' : 'posting-preference-unknown',
          'unknown',
          hard
            ? 'A required condition could not be verified from the posting.'
            : 'A preferred condition could not be verified from the posting.',
          citation,
        ),
      );
    }
  }
  if (conflictingGeography) geography = undefined;
  if (!geography)
    uncertainties.push(
      reason(
        'posting-geography-unknown',
        'unknown',
        'The posting does not establish where the work can be done.',
        location,
      ),
    );
  if (!seenHardMaterial || raw.description.length > maxDescriptionLength)
    uncertainties.push(
      reason(
        'posting-requirements-incomplete',
        'unknown',
        'The posting does not establish a complete set of requirements.',
      ),
    );
  const posting = {
    role,
    geography,
    required,
    preferred,
    preferredUncertainties,
    uncertainties,
  };
  const result = extraction
    ? mergeSourceExtraction(raw, lines, posting, extraction, vocabulary)
    : posting;
  const addLabels = (groups: readonly Group[]) =>
    groups.map(({ alternatives, citation }) => ({
      citation,
      alternatives: alternatives.map((atom) => ({
        ...atom,
        label: vocabulary.labels.get(atom.slug) ?? atom.label,
      })),
    }));
  return {
    ...result,
    required: addLabels(result.required),
    preferred: addLabels(result.preferred),
  };
}

function normalizeEvidence(
  input: MatchingCandidateInput['evidence'][number],
  vocabulary: MatchingVocabulary,
): Evidence[] {
  if (input.kind === 'skill') {
    const slug = vocabulary.aliases.get(phrase(input.text));
    return slug
      ? [
          {
            slug,
            polarity: 'positive',
            citation: cite(
              'evidence',
              input.text,
              0,
              input.text.length,
              input.id,
            ),
          },
        ]
      : [];
  }

  const evidence: Evidence[] = [];
  for (const match of input.text.matchAll(
    /[^\r\n;]+?(?:[.!?](?=\s|$)|(?=[;\r\n]|$))/gu,
  )) {
    const raw = match[0];
    const statement = raw.trim().replace(/[.!?]$/u, '');
    const text = phrase(statement);
    const denial =
      text.match(
        /^(?:i have )?no (?:hands-on )?(?:experience|knowledge) (?:with|in|of|using) (.+)$/u,
      ) ??
      text.match(/^(?:i )?(?:have never|never) (?:used|worked with) (.+)$/u);
    const action =
      text.match(
        /^(?:i )?(?:have )?(?:used|worked with|implemented|maintained|administered|configured) (.+)$/u,
      ) ??
      text.match(
        /^(?:i )?(?:built|developed|designed|operated|deployed|migrated|tested) [\p{L}\p{N} ,/_-]{1,100} (?:using|with) (.+)$/u,
      );
    const declared = text.replace(/^(?:i )?have\s+/u, '');
    const start = match.index + raw.indexOf(statement);
    const citation = cite(
      'evidence',
      input.text,
      start,
      start + statement.length,
      input.id,
    );
    if (denial) {
      const slug = vocabulary.aliases.get(denial[1] ?? '');
      if (slug) evidence.push({ slug, polarity: 'negative', citation });
    } else if (action?.[1]) {
      const groups = parseGroups(action[1], citation, vocabulary);
      if (groups?.every((group) => group.alternatives.length === 1))
        for (const { alternatives } of groups)
          for (const proof of alternatives)
            evidence.push({ ...proof, polarity: 'positive', citation });
    } else if (
      /^(?:(?:at least )?\d{1,2}\+? years?|(?:production |professional |hands-on )?experience)\b/u.test(
        declared,
      )
    ) {
      const proof = qualification(declared, vocabulary);
      if (proof) evidence.push({ ...proof, polarity: 'positive', citation });
    }
  }
  return evidence;
}

function normalizeQuestion(
  question: NonNullable<MatchingCandidateInput['questions']>[number],
): MatchingQuestion {
  const citation = cite(
    'question',
    question.text,
    0,
    question.text.length,
    question.id,
  );
  const result: MatchingQuestion = {
    citation,
    desiredAnswer: question.desiredAnswer ?? 'yes',
  };
  const modeMatch = question.text.match(
    /^Does the posting explicitly offer the work arrangement "([^"]+)"\?$/iu,
  );
  const countryMatch = question.text.match(
    /^Does the posting explicitly allow working from "([^"]+)"\?$/iu,
  );
  const mode = workMode(modeMatch?.[1] ?? '');
  const country = countryCode(countryMatch?.[1] ?? '');
  if (question.kind !== 'fit' && mode)
    result.query = { type: 'mode', value: mode };
  else if (question.kind !== 'fit' && country)
    result.query = { type: 'country', value: country };
  return result;
}

export function normalizeMatchingCandidate(
  raw: MatchingCandidateInput,
  vocabulary: MatchingVocabulary,
): NormalizedMatchingCandidate {
  const uncertainties: MatchingReason[] = [];
  if (raw.incomplete)
    uncertainties.push(
      reason(
        'candidate-input-incomplete',
        'unknown',
        'Some of your matching preferences or evidence could not be read.',
      ),
    );
  const roles = raw.targetRoles.flatMap((text) => {
    const citation = cite('target-role', text);
    const role = normalizeRole(text, citation);
    return role ? [role] : [];
  });
  if (!roles.length)
    uncertainties.push(
      reason(
        'candidate-role-missing',
        'unknown',
        'Add a recognized role you want to find.',
        ...raw.targetRoles.map((text) => cite('target-role', text)),
      ),
    );
  // An additional unrecognized choice is an alternative, not a hard blocker
  // when a known choice supports this match. It prevents known-conflict below.
  const unknownRoles = raw.targetRoles.filter(
    (text) => !normalizeRole(text, cite('target-role', text)),
  );
  if (roles.length && unknownRoles.length)
    uncertainties.push(
      reason(
        'candidate-role-choice-unknown',
        'unknown',
        'Some of your target roles are unclear.',
        ...unknownRoles.map((text) => cite('target-role', text)),
      ),
    );
  const anywhere = raw.locations.some((text) => phrase(text) === 'anywhere');
  const unknownLocations: Citation[] = [];
  const locations = raw.locations.flatMap((text) => {
    if (phrase(text) === 'anywhere') return [];
    const value = region(text);
    const citation = cite('target-location', text);
    if (!value) unknownLocations.push(citation);
    return value ? [{ ...value, citation }] : [];
  });
  const unknownRemoteCountries: Citation[] = [];
  const remoteCountries = (raw.remoteCountries ?? []).flatMap((text) => {
    const country = countryCode(text);
    const citation = cite('target-location', text);
    if (!country) unknownRemoteCountries.push(citation);
    return country ? [{ country, citation }] : [];
  });
  const modes = (raw.workModes ?? []).flatMap((text) => {
    const mode = workMode(text);
    return mode ? [mode] : [];
  });
  if (modes.length !== (raw.workModes ?? []).length)
    uncertainties.push(
      reason(
        'candidate-mode-unknown',
        'unknown',
        'Check your preferred work arrangements.',
        ...(raw.workModes ?? []).map((text) => cite('target-mode', text)),
      ),
    );
  const evidence = raw.evidence.flatMap((item) =>
    normalizeEvidence(item, vocabulary).map((proof) => ({
      ...proof,
      satisfies:
        proof.polarity === 'positive'
          ? [proof.slug, ...(vocabulary.broader.get(proof.slug) ?? [])]
          : [],
      rulesOut:
        proof.polarity === 'negative'
          ? [proof.slug, ...(vocabulary.narrower.get(proof.slug) ?? [])]
          : [],
      related: [...(vocabulary.related.get(proof.slug) ?? [])],
    })),
  );
  return {
    roles,
    locations,
    remoteCountries,
    anywhere,
    unknownLocations,
    explicitRemoteCountries: Boolean(raw.remoteCountries?.length),
    unknownRemoteCountries,
    modes,
    evidence,
    questions: (raw.questions ?? [])
      .filter((question) => question.required)
      .map(normalizeQuestion),
    uncertainties,
  };
}

function roleFit(target: Role, posting: Role): MatchingReason['outcome'] {
  if (target.family !== posting.family) return 'conflict';
  if (target.specialty && !posting.specialty) return 'unknown';
  if (target.specialty && target.specialty !== posting.specialty)
    return 'conflict';
  if (target.level && !posting.level) return 'unknown';
  if (target.level && target.level !== posting.level) return 'conflict';
  return 'supported';
}

function candidateRole(
  posting: Role,
  candidate: NormalizedMatchingCandidate,
): MatchingReason {
  const fits = candidate.roles.map((target) => ({
    target,
    outcome: roleFit(target, posting),
  }));
  const fit = fits.find(({ outcome }) => outcome === 'supported');
  if (fit)
    return reason(
      'target-role',
      'supported',
      'The posting matches a role you selected.',
      posting.citation,
      fit.target.citation,
    );
  if (
    !fits.length ||
    fits.some(({ outcome }) => outcome === 'unknown') ||
    candidate.uncertainties.some(
      ({ code }) => code === 'candidate-role-choice-unknown',
    )
  )
    return reason(
      'target-role',
      'unknown',
      'The posting’s role, specialty, or seniority could not be matched to your target roles.',
      posting.citation,
      ...fits.map(({ target }) => target.citation),
    );
  return reason(
    'target-role',
    'conflict',
    'The posting is outside your target roles.',
    posting.citation,
    ...fits.map(({ target }) => target.citation),
  );
}

function regionFit(allowed: Region, chosen: Region): MatchingReason['outcome'] {
  if (allowed.country && chosen.country && allowed.country !== chosen.country)
    return 'conflict';
  if (
    !allowed.locality &&
    allowed.country &&
    allowed.country === chosen.country
  )
    return 'supported';
  if (
    allowed.locality &&
    !chosen.locality &&
    allowed.country &&
    allowed.country === chosen.country
  )
    return 'supported';
  if (!allowed.locality || !chosen.locality) return 'unknown';
  if (allowed.locality === chosen.locality) {
    return allowed.country === chosen.country ? 'supported' : 'unknown';
  }
  return allowed.country === chosen.country && allowed.country
    ? 'conflict'
    : 'unknown';
}

function candidateGeography(
  geography: Geography,
  candidate: NormalizedMatchingCandidate,
): MatchingReason[] {
  const reasons: MatchingReason[] = [];
  if (
    candidate.modes.length &&
    (!geography.mode || !candidate.modes.includes(geography.mode))
  ) {
    reasons.push(
      reason(
        'work-arrangement',
        geography.mode ? 'conflict' : 'unknown',
        geography.mode
          ? 'The posting does not offer your preferred work arrangement.'
          : 'The posting does not establish a work arrangement.',
        geography.citation,
      ),
    );
  }
  const remote = geography.mode === 'remote';
  const explicitRemoteCountries = remote && candidate.explicitRemoteCountries;
  const locations = explicitRemoteCountries
    ? candidate.remoteCountries
    : candidate.locations;
  const unknownLocations = explicitRemoteCountries
    ? candidate.unknownRemoteCountries
    : candidate.unknownLocations;
  if (
    geography.worldwide &&
    ((!explicitRemoteCountries && candidate.anywhere) || locations.length)
  ) {
    reasons.push(
      reason(
        'work-location',
        'supported',
        'The posting explicitly allows working from anywhere.',
        geography.citation,
      ),
    );
    return reasons;
  }
  // An explicit willingness to work anywhere allows a known onsite location,
  // but does not establish where someone can perform restricted remote work.
  if (candidate.anywhere && !remote) {
    reasons.push(
      reason(
        'work-location',
        'supported',
        'The posting’s location matches your open location preference.',
        geography.citation,
      ),
    );
    return reasons;
  }
  const comparisons = geography.regions.flatMap((allowed) =>
    locations.map((chosen) => ({
      chosen,
      outcome: regionFit(allowed, chosen),
    })),
  );
  const match = comparisons.find(({ outcome }) => outcome === 'supported');
  if (match)
    reasons.push(
      reason(
        'work-location',
        'supported',
        'The posting matches a location you selected.',
        geography.citation,
        match.chosen.citation,
      ),
    );
  else if (
    !comparisons.length ||
    unknownLocations.length ||
    comparisons.some(({ outcome }) => outcome === 'unknown')
  )
    reasons.push(
      reason(
        'work-location',
        'unknown',
        'Confirm where you want to work and where the posting permits it.',
        geography.citation,
        ...locations.map(({ citation }) => citation),
        ...unknownLocations,
      ),
    );
  else
    reasons.push(
      reason(
        'work-location',
        'conflict',
        'The posting does not allow your selected work locations.',
        geography.citation,
        ...locations.map(({ citation }) => citation),
      ),
    );
  return reasons;
}

function evidenceFit(
  requirement: Qualification,
  candidate: NormalizedMatchingCandidate,
) {
  if (!requirement.slug) return { outcome: 'unknown', citations: [] } as const;
  const positives: Citation[] = [];
  const negatives: Citation[] = [];
  const partials: Citation[] = [];
  for (const proof of candidate.evidence) {
    if (proof.satisfies.includes(requirement.slug)) {
      if (
        (!requirement.context || proof.context === requirement.context) &&
        (!requirement.years ||
          (proof.years !== undefined && proof.years >= requirement.years))
      )
        positives.push(proof.citation);
      else partials.push(proof.citation);
    }
    if (proof.rulesOut.includes(requirement.slug))
      negatives.push(proof.citation);
  }
  if (positives.length && !negatives.length)
    return { outcome: 'supported', citations: positives } as const;
  if (negatives.length && !positives.length && !partials.length)
    return { outcome: 'conflict', citations: negatives } as const;
  return {
    outcome: 'unknown',
    citations: [...positives, ...negatives, ...partials],
  } as const;
}

function groupFit(
  group: Group,
  candidate: NormalizedMatchingCandidate,
  required: boolean,
): MatchingReason {
  const evaluated = group.alternatives.map((atom) =>
    evidenceFit(atom, candidate),
  );
  const supportedIndex = evaluated.findIndex(
    ({ outcome }) => outcome === 'supported',
  );
  const kind = required ? 'required' : 'preferred';
  const name = (atom: Qualification) => {
    const capability = atom.label || atom.slug.replace(/-/gu, ' ');
    if (atom.years)
      return `${atom.years}+ years of ${atom.context ? `${atom.context} ` : ''}experience with ${capability}`;
    return atom.context
      ? `${atom.context} experience with ${capability}`
      : capability;
  };
  const supported = group.alternatives[supportedIndex];
  if (supported && evaluated[supportedIndex])
    return reason(
      `${kind}-capability`,
      'supported',
      `Your evidence supports ${name(supported)}.`,
      group.citation,
      ...evaluated[supportedIndex].citations,
    );
  const conflict = evaluated.every(({ outcome }) => outcome === 'conflict');
  const options = group.alternatives.map(name).join(' or ');
  return reason(
    `${kind}-capability`,
    conflict ? 'conflict' : 'unknown',
    conflict
      ? `Your evidence rules out ${options}.`
      : `Your evidence does not establish ${options}.`,
    group.citation,
    ...evaluated.flatMap(({ citations }) => citations),
  );
}

function evaluateQuestion(
  question: MatchingQuestion,
  posting: NormalizedMatchingPosting,
): MatchingReason {
  const { query, citation } = question;
  let answer: 'yes' | 'no' | undefined;
  let source: Citation | undefined;
  if (query?.type === 'mode' && posting.geography?.mode) {
    answer = posting.geography.mode === query.value ? 'yes' : 'no';
    source = posting.geography.citation;
  }
  if (query?.type === 'country' && posting.geography) {
    const { geography } = posting;
    const matches = geography.regions.map((allowed) =>
      regionFit(allowed, { country: query.value }),
    );
    answer =
      geography.worldwide || matches.includes('supported')
        ? 'yes'
        : matches.every((outcome) => outcome === 'conflict')
          ? 'no'
          : undefined;
    source = geography.citation;
  }
  const citations = source ? [citation, source] : [citation];
  if (!answer)
    return reason(
      'screening-question',
      'unknown',
      'One of your required screening questions still needs a verified answer.',
      ...citations,
    );
  if (answer === question.desiredAnswer)
    return reason(
      'screening-question',
      'supported',
      'The posting satisfies one of your required screening questions.',
      ...citations,
    );
  return reason(
    'screening-question',
    'conflict',
    'The posting conflicts with one of your required screening questions.',
    ...citations,
  );
}

export function evaluateNormalizedMatch(
  posting: NormalizedMatchingPosting,
  candidate: NormalizedMatchingCandidate,
): NormalizedMatchDecision {
  const hard = [
    ...posting.uncertainties,
    ...candidate.uncertainties.filter(
      ({ code }) => code !== 'candidate-role-choice-unknown',
    ),
  ];
  if (posting.role) hard.push(candidateRole(posting.role, candidate));
  if (posting.geography)
    hard.push(...candidateGeography(posting.geography, candidate));
  for (const group of posting.required)
    hard.push(groupFit(group, candidate, true));
  for (const question of candidate.questions)
    hard.push(evaluateQuestion(question, posting));
  const soft = [
    ...posting.preferred.map((group) => groupFit(group, candidate, false)),
    ...posting.preferredUncertainties,
  ];
  const reasons = [...hard, ...soft];
  if (hard.some(({ outcome }) => outcome === 'conflict'))
    return { status: 'conflict', score: 0, reasons };
  if (hard.some(({ outcome }) => outcome === 'unknown'))
    return { status: 'insufficient-evidence', score: 0, reasons };

  // Rank only qualified results. Preference coverage outweighs retrieval-only
  // related edges. Related edges never count as proof of a capability.
  const preferred = soft.filter(
    ({ outcome }) => outcome === 'supported',
  ).length;
  const related = posting.preferred.filter(
    (group, index) =>
      soft[index]?.outcome === 'unknown' &&
      group.alternatives.some(({ slug }) =>
        candidate.evidence.some(
          (proof) =>
            proof.polarity === 'positive' && proof.related.includes(slug),
        ),
      ),
  ).length;
  const score =
    70 +
    (soft.length
      ? Math.round((25 * preferred + 3 * related) / soft.length)
      : 0);
  return { status: 'qualified', score, reasons };
}
