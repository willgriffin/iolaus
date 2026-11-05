import {
  countryReferenceFromCode,
  onboardingCountryCodes,
} from './country-reference.js';
import {
  CANDIDATE_INTERPRETATION_PROMPT_VERSION,
  CANDIDATE_INTERPRETATION_VERSION,
  type CandidateCoverageIssue,
  type CandidateInterpretationState,
  candidateActionTechnologies,
  candidateConditionGroups,
  candidateEvidenceDigest,
  candidateEvidencePositions,
  candidatePeriodIsOngoing,
  candidateTotalDurationLimit,
  parseCandidateInterpretation,
} from './matching-candidate-contract.js';
import {
  conservativeExperiencePeriod,
  type ExperiencePeriod,
  minimumExperienceYears,
} from './matching-experience-dates.js';
import type {
  MatchingSourceExtraction,
  MatchingSourceSpan,
} from './matching-source-extraction-contract.js';
import {
  MATCHING_SOURCE_DESCRIPTION_LIMIT,
  matchingDescriptionUnits,
  matchingSourceSemanticUnits,
} from './matching-source-units.js';

export const MATCHING_POLICY_VERSION = `normalized-v25:${CANDIDATE_INTERPRETATION_VERSION}:${CANDIDATE_INTERPRETATION_PROMPT_VERSION}`;

export interface MatchingVocabularyTerm {
  slug: string;
  label: string;
  definition?: string;
  qualitative?: true;
  aliases?: readonly string[];
  related?: readonly string[];
  /** The child can establish the parent. The reverse does not hold. */
  narrowerThan?: readonly string[];
}

export interface MatchingVocabulary {
  aliases: ReadonlyMap<string, string | null>;
  labels: ReadonlyMap<string, string>;
  definitions: ReadonlyMap<string, string>;
  qualitative: ReadonlySet<string>;
  broader: ReadonlyMap<string, ReadonlySet<string>>;
  related: ReadonlyMap<string, ReadonlySet<string>>;
  narrower: ReadonlyMap<string, ReadonlySet<string>>;
}

const capabilityTerms: readonly MatchingVocabularyTerm[] = [
  {
    slug: 'software-development',
    label: 'Software development',
    aliases: [
      'software engineering',
      'building software',
      'developing software',
    ],
  },
  {
    slug: 'backend-development',
    label: 'Backend development',
    aliases: [
      'backend engineering',
      'back-end development',
      'back-end engineering',
      'backend software development',
    ],
    narrowerThan: ['software-development'],
  },
  {
    slug: 'frontend-development',
    label: 'Frontend development',
    aliases: [
      'frontend engineering',
      'front-end development',
      'front-end engineering',
      'frontend software development',
    ],
    narrowerThan: ['software-development'],
  },
  {
    slug: 'full-stack-development',
    label: 'Full-stack development',
    aliases: [
      'full-stack engineering',
      'full stack development',
      'full stack engineering',
    ],
    narrowerThan: ['software-development'],
  },
  {
    slug: 'software-architecture',
    label: 'Software architecture',
    aliases: ['software systems architecture'],
  },
  {
    slug: 'engineering-management',
    label: 'Engineering management',
    aliases: [
      'software engineering management',
      'software development management',
    ],
  },
  { slug: 'distributed-systems', label: 'Distributed systems' },
  {
    slug: 'system-design',
    label: 'System design',
    aliases: ['systems design'],
  },
  { slug: 'data-structures', label: 'Data structures' },
  { slug: 'algorithms', label: 'Algorithms' },
  {
    slug: 'code-review',
    label: 'Code review',
    aliases: ['code reviews', 'reviewing code'],
  },
  { slug: 'sql', label: 'SQL', aliases: ['structured query language'] },
  {
    slug: 'nextjs',
    label: 'Next.js',
    aliases: ['next js', 'nextjs'],
    related: ['react'],
  },
  {
    slug: 'express',
    label: 'Express',
    aliases: ['express.js', 'expressjs'],
    related: ['nodejs'],
  },
  {
    slug: 'google-cloud',
    label: 'Google Cloud',
    aliases: ['google cloud platform', 'gcp'],
  },
  {
    slug: 'rails',
    label: 'Rails',
    aliases: ['ruby on rails'],
    related: ['ruby'],
  },
  {
    slug: 'ci-cd',
    label: 'CI/CD',
    aliases: [
      'continuous integration and continuous delivery',
      'continuous integration and continuous deployment',
    ],
  },
  {
    slug: 'rest',
    label: 'REST',
    aliases: ['rest api', 'rest apis', 'restful api', 'restful apis'],
  },
  { slug: 'written-communication', label: 'Written communication' },
  {
    slug: 'verbal-communication',
    label: 'Verbal communication',
    aliases: ['oral communication'],
  },
  {
    slug: 'cross-functional-collaboration',
    label: 'Cross-functional collaboration',
  },
  {
    slug: 'asynchronous-collaboration',
    label: 'Asynchronous collaboration',
    aliases: ['async collaboration'],
  },
  {
    slug: 'technical-problem-solving',
    label: 'Technical problem solving',
    aliases: ['technical problem-solving'],
  },
  {
    slug: 'production-operations',
    label: 'Production operations',
    aliases: ['operating production systems'],
  },
  { slug: 'incident-response', label: 'Incident response' },
  { slug: 'observability', label: 'Observability' },
  {
    slug: 'data-modeling',
    label: 'Data modeling',
    aliases: ['data modelling'],
  },
  { slug: 'nosql', label: 'NoSQL', aliases: ['nosql databases'] },
  {
    slug: 'ai-assisted-coding',
    label: 'AI-assisted coding',
    aliases: ['ai coding assistants', 'ai coding tools'],
  },
  {
    slug: 'technical-mentoring',
    label: 'Technical mentoring',
    narrowerThan: ['mentoring'],
  },
  {
    slug: 'engineering-team-leadership',
    label: 'Engineering team leadership',
    definition:
      'Directing engineering or software development teams. Generic people leadership is broader.',
    aliases: ['leading engineering teams', 'leading development teams'],
    narrowerThan: ['team-leadership'],
  },
  {
    slug: 'removing-engineering-delivery-obstacles',
    label: 'Removing engineering delivery obstacles',
    definition:
      'Identifying and resolving obstacles that block a development team from delivering work.',
    aliases: ['unblocking development teams', 'unblocking engineering teams'],
  },
  {
    slug: 'technical-communication',
    label: 'Technical communication',
    definition:
      'Explaining technical concepts or decisions clearly, without assuming a specific channel, language or audience beyond the source.',
    qualitative: true,
    aliases: [
      'communicating technical concepts',
      'clear communication around technical concepts',
      'explaining technical decisions',
    ],
  },
  {
    slug: 'product-team-collaboration',
    label: 'Product team collaboration',
    definition:
      'Working with a product team across engineering and product responsibilities; generic teamwork alone does not establish this.',
    aliases: [
      'collaborating with product teams',
      'collaborating with product',
      'collaborate with product',
      'can collaborate with product',
    ],
    narrowerThan: ['cross-functional-collaboration'],
  },
  {
    slug: 'working-through-ambiguity',
    label: 'Working through ambiguity',
    definition:
      'Comfort progressing work when details or priorities are unclear. This is qualitative, not a duration or technical prerequisite.',
    qualitative: true,
    aliases: ['comfort with ambiguity', 'handling ambiguity'],
  },
  {
    slug: 'clarifying-ambiguous-work',
    label: 'Creating clarity in ambiguous work',
    definition:
      'Turning unclear situations into understandable next steps. This is a qualitative behavior.',
    qualitative: true,
    aliases: ['an ability to create clarity', 'ability to create clarity'],
  },
  {
    slug: 'initiative-in-team-delivery',
    label: 'Initiative in team delivery',
    definition:
      'Taking initiative to solve problems and keep projects and a team moving. Does not prove a technical discipline or named tool.',
    qualitative: true,
    aliases: [
      'initiative in solving delivery problems and keeping a team moving',
    ],
  },
  {
    slug: 'scalable-full-stack-web-development',
    label: 'Scalable full-stack web development',
    definition:
      'Building scalable web applications as a full-stack engineer. Both full-stack scope and scalable web applications are necessary.',
    narrowerThan: [
      'full-stack-development',
      'scalable-web-application-development',
    ],
  },
  {
    slug: 'highly-scalable-distributed-systems',
    label: 'Highly scalable distributed systems',
    definition:
      'Engineering distributed systems designed for substantial growth in workload. Generic distributed system work does not establish this scope.',
    aliases: [
      'highly scalable, distributed systems',
      'scalable distributed systems',
    ],
    narrowerThan: ['distributed-systems'],
  },
  {
    slug: 'cross-stack-service-operations',
    label: 'Backend development and service operations',
    definition:
      'Working across backend application development and infrastructure, including deployment, monitoring and scaling. All scopes are retained.',
    aliases: [
      'backend development and infrastructure deployment, monitoring and scaling',
    ],
  },
  {
    slug: 'postgresql-operational-tuning',
    label: 'PostgreSQL tuning and troubleshooting',
    definition:
      'Tuning and troubleshooting PostgreSQL. General PostgreSQL experience alone is partial support.',
    narrowerThan: ['postgresql'],
  },
  {
    slug: 'production-node-backend-engineering',
    label: 'Backend engineering with Node.js in production',
    definition:
      'Backend engineering experience running Node.js in production. Preserve the stated duration when one is present.',
    narrowerThan: ['backend-development', 'nodejs'],
  },
  {
    slug: 'end-to-end-project-ownership',
    label: 'End-to-end project ownership',
    definition:
      'Demonstrating ownership by driving a project through its lifecycle. Do not infer this from a job title alone.',
    aliases: ['driving projects end-to-end', 'end-to-end ownership'],
    qualitative: true,
  },
  {
    slug: 'developer-experience-empathy',
    label: 'Empathy for developer experience',
    definition:
      'Considering the needs and frustrations of developers as users. This is a qualitative criterion.',
    aliases: [
      'empathy towards developer experience',
      'empathy for developer experience',
    ],
    qualitative: true,
  },
  {
    slug: 'build-system-engineering',
    label: 'Build system engineering',
    definition:
      'Designing, operating or maintaining software build systems. CI/CD is related but does not establish all build-system experience.',
    aliases: [
      'building and maintaining build systems',
      'operating build systems',
    ],
  },
  {
    slug: 'developer-experience-engineering',
    label: 'Developer experience engineering',
    definition:
      'Engineering work on tools and workflows used by developers. General engineering or IT work alone does not establish DevEx.',
    aliases: ['developer experience engineering (devex)', 'devex engineering'],
    related: ['platform-engineering'],
  },
  {
    slug: 'developer-workflow-automation',
    label: 'Developer workflow automation',
    definition: 'Automating workflows used to develop or deliver software.',
    aliases: ['automating developer workflows'],
  },
  {
    slug: 'scaling-developer-workflows',
    label: 'Scaling developer workflows',
    definition:
      'Extending developer workflows to support growing teams or workload. Automation alone does not imply scale.',
  },
  {
    slug: 'scalable-web-application-development',
    label: 'Scalable web application development',
    definition:
      'Building web applications designed to handle growth in usage or load. General software development does not prove this scale or web scope.',
    aliases: [
      'building scalable web applications',
      'developing scalable web applications',
    ],
    narrowerThan: ['software-development'],
  },
  {
    slug: 'developer-tooling',
    label: 'Developer tooling',
    definition: 'Building or maintaining tools used by software developers.',
    aliases: ['developer tools engineering', 'building developer tools'],
  },
  {
    slug: 'technical-decision-making',
    label: 'Technical decision making',
    definition:
      'Evaluating technical tradeoffs and selecting a course of action. Do not erase a stated domain or decision scope.',
    qualitative: true,
    aliases: ['technical decision-making', 'technical trade-offs'],
  },
  {
    slug: 'api-development',
    label: 'API development',
    definition:
      'Building programmatic interfaces. Use of an API and designing a REST API alone are narrower/different claims.',
    aliases: ['building APIs', 'developing APIs'],
    related: ['backend-development', 'api-design'],
  },
  {
    slug: 'software-testing',
    label: 'Software testing',
    definition:
      'Designing or performing software tests. Preserve any explicit test level or tooling.',
    aliases: ['testing software', 'application testing'],
  },
  {
    slug: 'data-quality-engineering',
    label: 'Data quality engineering',
    definition:
      'Maintaining correctness, consistency or integrity of application or pipeline data; generic data work is broader.',
    aliases: ['data correctness engineering'],
  },
  {
    slug: 'software-reliability',
    label: 'Software reliability',
    definition:
      'Building or maintaining reliable software systems. Do not assume production operations, monitoring or a named reliability process.',
    aliases: ['software reliability engineering'],
  },
  {
    slug: 'software-performance-engineering',
    label: 'Software performance engineering',
    definition:
      'Measuring, diagnosing or improving application/system performance; generic development is broader.',
    aliases: ['application performance engineering'],
  },
  {
    slug: 'software-performance-tuning',
    label: 'Software performance tuning',
    definition:
      'Changing the configuration or implementation of software to improve measured performance.',
    aliases: ['performance tuning', 'application performance tuning'],
    narrowerThan: ['software-performance-engineering'],
  },
  { slug: 'opentelemetry', label: 'OpenTelemetry', aliases: ['otel'] },
  { slug: 'prometheus', label: 'Prometheus' },
  { slug: 'grafana', label: 'Grafana' },
  { slug: 'kafka', label: 'Kafka', aliases: ['apache kafka'] },
  { slug: 'json', label: 'JSON', aliases: ['javascript object notation'] },
  { slug: 'laravel', label: 'Laravel', related: ['php'] },
  { slug: 'vue', label: 'Vue', aliases: ['vue.js', 'vuejs'] },
  {
    slug: 'role-tool-familiarity',
    label: 'Familiarity with the role’s tools',
    definition:
      'A broad tooling condition where the source explicitly gives examples; examples are partial evidence and do not define an exhaustive requirement.',
  },
  {
    slug: 'role-tool-experience',
    label: 'Experience with the role’s tools',
    definition:
      'A tooling experience requirement illustrated by named examples; those examples do not alone establish the entire condition.',
  },
  {
    slug: 'role-tool-proficiency',
    label: 'Proficiency with the role’s tools',
    definition:
      'Proficiency with relevant tooling; named source examples are not an exhaustive technical condition.',
  },
  {
    slug: 'continuous-learning',
    label: 'Keeping technical skills current',
    aliases: [
      'staying up to date with ongoing changes and advancements',
      'a drive to stay up to date with ongoing changes and advancements',
    ],
    definition:
      'The stated willingness to stay current as relevant tools and practices change. A qualitative condition, not proof of a specific technology.',
    qualitative: true,
  },
  { slug: 'networking', label: 'Networking', aliases: ['computer networking'] },
  { slug: 'ip-routing', label: 'IP routing', narrowerThan: ['networking'] },
  { slug: 'mentoring', label: 'Mentoring', related: ['people-management'] },
  {
    slug: 'people-management',
    label: 'People management',
    aliases: ['managing direct reports', 'managing people'],
  },
];
const capabilityLabels = new Map([
  ['nodejs', 'Node.js'],
  ['postgresql', 'PostgreSQL'],
  ...capabilityTerms.map(({ slug, label }) => [slug, label] as const),
]);
const capabilityList = new Intl.ListFormat('en', { type: 'conjunction' });

function phrase(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function compileMatchingVocabulary(
  terms: readonly MatchingVocabularyTerm[],
): MatchingVocabulary {
  const graph = new Map(capabilityTerms.map((term) => [term.slug, term]));
  // Persisted terms own relationships. Keep governed exact equivalents
  // available on existing seed rows without rewriting the persisted record.
  for (const term of terms) {
    const governed = graph.get(term.slug);
    graph.set(
      term.slug,
      governed
        ? {
            ...term,
            definition: governed.definition ?? term.definition,
            qualitative: governed.qualitative ?? term.qualitative,
            aliases: [
              governed.label,
              ...(governed.aliases ?? []),
              ...(term.aliases ?? []),
            ],
          }
        : term,
    );
  }
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
    definitions: new Map(
      [...graph].flatMap(([slug, term]) =>
        term.definition ? [[slug, term.definition] as const] : [],
      ),
    ),
    qualitative: new Set(
      [...graph].flatMap(([slug, term]) => (term.qualitative ? [slug] : [])),
    ),
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
  evidenceDigest?: string;
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

type RoleIdentity = Omit<Role, 'citation'>;
const roleAliases = new Map<string, RoleIdentity>();
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
    'software-architecture',
    undefined,
    'software architect|software application architect',
  ],
  [
    'technical-architecture',
    undefined,
    'technical architect|technology architect',
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
    'machine learning engineer|ml engineer|ai engineer|applied ai engineer|ai ml engineer|ai/ml engineer|ai & ml engineer|ai and ml engineer',
  ],
  [
    'machine-learning-engineering',
    'llm',
    'llm engineer|ai/llm engineer|ai / llm engineer|large language model engineer|generative ai engineer',
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

roleAliases.set('technical lead', {
  family: 'software-engineering',
  level: 'lead',
});

const postingRoleAliases = new Map(roleAliases);
postingRoleAliases.set('software dev engineer', {
  family: 'software-engineering',
});
postingRoleAliases.set('strategic account executive', { family: 'sales' });
postingRoleAliases.set('executive assistant', { family: 'executive-support' });

// A saved target can name a discipline. These aliases never identify a
// posting title and never discard a specialty or an unrecognized qualifier.
const targetRoleAliases = new Map(roleAliases);
for (const [family, specialty] of roleFamilies)
  if (!specialty)
    targetRoleAliases.set(family.replaceAll('-', ' '), { family });

const disciplineAliases: typeof roleFamilies = [
  [
    'software-engineering',
    undefined,
    'software development|software programming',
  ],
  ['software-engineering', 'backend', 'api engineering|api development'],
  ['software-engineering', 'frontend', 'ui engineering'],
  [
    'software-engineering',
    'full-stack',
    'full stack|fullstack|fullstack engineering|fullstack development',
  ],
  [
    'engineering-management',
    undefined,
    'software engineering management|software development management',
  ],
  [
    'platform-engineering',
    undefined,
    'site reliability engineering|devops|cloud engineering|infrastructure engineering',
  ],
  [
    'machine-learning-engineering',
    undefined,
    'ai engineering|ml engineering|applied ai engineering|ai/ml engineering|ai / ml engineering|ai & ml engineering|ai and ml engineering|ai/ml development|ai / ml development|ai & ml development|ai and ml development|ml/ai engineering|artificial intelligence and machine learning engineering',
  ],
  [
    'machine-learning-engineering',
    'llm',
    'llm engineering|ai/llm engineering|ai / llm engineering|large language model engineering|generative ai engineering',
  ],
  ['technical-architecture', undefined, 'technology architecture'],
  ['quality-engineering', undefined, 'quality assurance|test engineering'],
  [
    'solutions-engineering',
    undefined,
    'solution engineering|solutions architecture|solution architecture',
  ],
  ['product-design', undefined, 'ux design|user experience design'],
  ['customer-support', undefined, 'customer service|technical support'],
];
for (const [family, specialty, aliases] of disciplineAliases)
  for (const alias of aliases.split('|'))
    targetRoleAliases.set(alias, { family, specialty });

const softwareSpecialties = [
  ['backend', ['backend', 'back end']],
  ['frontend', ['frontend', 'front end']],
  ['full-stack', ['full stack']],
  ['mobile', ['mobile']],
] as const;
for (const [specialty, names] of softwareSpecialties)
  for (const name of names)
    for (const discipline of ['engineering', 'development']) {
      const role = { family: 'software-engineering', specialty };
      targetRoleAliases.set(`${name} ${discipline}`, role);
      targetRoleAliases.set(`${name} software ${discipline}`, role);
      targetRoleAliases.set(`software ${discipline} ${name}`, role);
    }

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

export const matchingSourceRoleInventory = {
  roles: [
    ...new Map(
      [...postingRoleAliases.values()].map(({ family, specialty }) => [
        `${family}:${specialty ?? ''}`,
        { family, specialty },
      ]),
    ).values(),
  ],
  levels: [...new Set(Object.values(levels))],
};

const levelPrefix =
  /^(entry level|mid level|junior|jr|entry|associate|mid|intermediate|senior|sr|staff|principal|lead) (.+)$/u;
const contextualTitleSuffix =
  /^(?:(?:fully )?remote|hybrid|on site|onsite|full time|part time|contract|temporary|asean|[a-z]{2}-[a-z]{2}|(?:m|f|w|d|x)(?:[ /-](?:m|f|w|d|x)){1,4})$/u;
const productDomain =
  /^(?:payments|billing|identity|fraud|search|growth|developer experience|developer tools|commerce|ecommerce|observability|core product|core services|infrastructure|data infrastructure|security platform|platform security|ai infrastructure|ai platform|machine learning platform|cloud platform|platform|integrations|distributed systems|api platform|web platform|database platform|storage|networking(?: features)?|managed gateways|mobile app|supply chain)$/u;

function normalizedTitle(value: string): string {
  return phrase(value.replace(/[.,()\-–—]/gu, ' '));
}

function exactRole(
  value: string,
  citation: Citation,
  aliases = postingRoleAliases,
  allowOrdinalSuffix = true,
): Role | undefined {
  const normalized = normalizedTitle(value);
  const level = normalized.match(levelPrefix);
  const name = level?.[2] ?? normalized;
  const role =
    aliases.get(name) ??
    (allowOrdinalSuffix
      ? aliases.get(name.replace(/ (?:i|ii|iii|iv|v|[1-5])$/u, ''))
      : undefined);
  const explicitLevel = levels[level?.[1] ?? ''];
  if (!role || (role.level && explicitLevel && role.level !== explicitLevel))
    return undefined;
  return { ...role, level: role.level ?? explicitLevel, citation };
}

function normalizeTargetRole(
  raw: string,
  citation: Citation,
): Role | undefined {
  return exactRole(raw, citation, targetRoleAliases, false);
}

function postingTitleParts(raw: string) {
  return raw
    .replace(/-ASEAN$/iu, ' - ASEAN')
    .replace(/\bnetworking\s+\(features\)$/iu, 'networking features')
    .replace(/\s*\(([^()]+)\)\s*$/u, ' | $1')
    .split(/\s+[-–—/]\s+|\s*[|,]\s*/u);
}

function normalizeRole(raw: string, citation: Citation): Role | undefined {
  const exact = exactRole(raw, citation);
  if (exact) return exact;
  // A reporting target in an assistant title is the supported executive,
  // not an alternative role or an additional title the applicant will hold.
  if (
    /^executive assistant to (?:the )?c[aefoirt]o(?: & head of (?:strategic sales|sales|marketing|finance|operations))?$/iu.test(
      raw.trim(),
    )
  )
    return exactRole('executive assistant', citation);
  // Delimiters are an explicit title structure. Never search for a known job
  // title inside an unrecognized title or remove an arbitrary modifier.
  const parts = postingTitleParts(raw);
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

/**
 * A verified context unit may have an unresolved title qualifier even when
 * the complete title independently establishes the role. Only allow the
 * closed role/product-domain grammar here; location, employment and ordinal
 * metadata still need their own verified interpretation.
 */
function plainGovernedRoleTitle(citation: Citation): boolean {
  const { text } = citation;
  if (exactRole(text, citation, postingRoleAliases, false)) return true;
  const [head, ...suffixes] = postingTitleParts(text);
  return Boolean(
    head &&
      exactRole(head, citation, postingRoleAliases, false) &&
      suffixes.length &&
      suffixes.every(
        (suffix) =>
          productDomain.test(normalizedTitle(suffix)) ||
          exactRole(`${head} ${suffix}`, citation, postingRoleAliases, false),
      ),
  );
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
  ['can', 'CA'],
  ['gbr', 'GB'],
  ['ind', 'IN'],
  ['jpn', 'JP'],
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
    parts.length > 1 &&
    final &&
    (final.length > 2 || ['us', 'uk'].includes(final))
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
  const remoteSegment = /^(?:fully )?remote\b|\(remote\)$/iu;
  const segments = raw.trim().split(/\s*[;|]\s*/u);
  if (
    segments.length > 1 &&
    workMode(segments[0] ?? '') !== 'remote' &&
    segments.some((segment) => remoteSegment.test(segment))
  ) {
    if (mode && mode !== 'remote') return undefined;
    const explicit = segments.filter((segment) => remoteSegment.test(segment));
    const choices = explicit.map((segment) =>
      parseGeography(segment, 'remote', citation),
    );
    if (choices.some((choice) => !choice || choice.worldwide)) return undefined;
    const regions = new Map(
      choices.flatMap((choice) =>
        (choice?.regions ?? []).map((entry) => [entry.country, entry] as const),
      ),
    );
    // Some boards repeat explicitly remote countries as country tags.
    // Other standalone locations cannot expand the established remote scope.
    if (
      segments.some(
        (segment) =>
          !explicit.includes(segment) &&
          !regions.has(region(segment, true)?.country),
      )
    )
      return undefined;
    return {
      mode: 'remote',
      regions: [...regions.values()],
      worldwide: false,
      citation,
    };
  }
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
  qualitative?: true;
  /** Explicit illustrative tools can support a gap result, never full proof. */
  examples?: readonly string[];
  partialCapabilities?: readonly string[];
  label?: string;
  years?: number;
  context?: 'production' | 'professional';
}
interface Group {
  requiresSourceReview?: boolean;
  alternatives: readonly Qualification[];
  citation: Citation;
}
interface Evidence extends Qualification {
  projectActivityId?: string;
  activityAnchor?: { start: number; end: number };
  ongoing?: true;
  professional?: true;
  positionCitation?: Citation;
  actionTechnologies?: readonly string[];
  support?: 'action' | 'stated' | 'inferred';
  period?: ExperiencePeriod;
  polarity: 'positive' | 'negative' | 'upper-bound';
  maximumYears?: number;
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
    /** Native employment link from the owner-scoped evidence reader. */
    activityId?: string;
    /** Verified linked employment dates. Only own position rows grant role evidence. */
    activityPosition?: { role: string; start: string; end: string };
    /** A native, owner-verified project parent distinct from position membership. */
    projectActivityId?: string;
    position?: { role: string; start: string; end: string };
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
  rolePreferenceStatus?: 'unsupported' | 'partial';
  locations: readonly (Region & { citation: Citation })[];
  remoteCountries: readonly (Region & { citation: Citation })[];
  anywhere: boolean;
  unknownLocations: readonly Citation[];
  explicitRemoteCountries: boolean;
  unknownRemoteCountries: readonly Citation[];
  modes: readonly Mode[];
  interpretationIssue?: MatchingReason;
  coverageIssues?: readonly NormalizedCandidateCoverageIssue[];
  hasOngoingExperience?: true;
  evidence: readonly (Evidence & {
    satisfies: readonly string[];
    rulesOut: readonly string[];
    related: readonly string[];
  })[];
  questions: readonly MatchingQuestion[];
  uncertainties: readonly MatchingReason[];
}

interface NormalizedCandidateCoverageIssue {
  kind: CandidateCoverageIssue['kind'];
  concepts?: readonly string[];
  citation?: Citation;
}

export interface MatchingReason {
  code: string;
  outcome: 'supported' | 'conflict' | 'unknown';
  message: string;
  citations: readonly Citation[];
  evidenceGaps?: readonly CandidateEvidenceGap[];
}

export type CandidateEvidenceGap = { conceptId: string } & (
  | { missing: 'context'; context: NonNullable<Qualification['context']> }
  | { missing: 'duration'; requiredYears: number; observedYears?: number }
  | { missing: 'related'; relatedCapabilities: readonly string[] }
  | {
      missing: 'conditions';
      conditions: readonly {
        conceptId: string;
        context?: Qualification['context'];
        independent?: true;
      }[];
    }
);

export interface NormalizedMatchDecision {
  status: 'qualified' | 'conflict' | 'insufficient-evidence';
  score: number;
  screenedWithGaps?: true;
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
    /^(?:(?:hands-on |applied |practical |proven )?experience|proficiency|proficient|(?:working )?knowledge|understanding|familiarity|expertise) (?:with|in|of|using) (.+)$/u,
  );
  const nounPhrase = normalized.match(
    /^(.+?) (?:experience|knowledge|proficiency)$/u,
  );
  const name = duration?.[3] ?? context?.[2] ?? named?.[1] ?? nounPhrase?.[1];
  const alternateLabel = name?.match(/^(.+?)\s+\(([^()]+)\)$/u);
  const primarySlug =
    alternateLabel && vocabulary.aliases.get(alternateLabel[1] ?? '');
  const sameAlias =
    primarySlug &&
    primarySlug === vocabulary.aliases.get(alternateLabel?.[2] ?? '')
      ? primarySlug
      : undefined;
  const exact = name && vocabulary.aliases.get(name);
  const slug = exact === undefined ? sameAlias : exact;
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

/** Convert explicit Boolean groupings to equivalent AND-of-OR groups. */
function groupedQualifications(
  body: string,
  vocabulary: MatchingVocabulary,
  nesting = 0,
): Qualification[][] | undefined {
  if (nesting > 6) return undefined;
  let depth = 0;
  let start = 0;
  let outerEnd = -1;
  let operator: string | undefined;
  const parts: string[] = [];
  for (const token of body.matchAll(/[()]|\s+(and|or)\s+/giu)) {
    if (token[0] === '(') depth += 1;
    else if (token[0] === ')') {
      depth -= 1;
      if (depth < 0) return undefined;
      if (depth === 0 && outerEnd < 0) outerEnd = token.index;
    } else if (depth === 0) {
      const join = token[1]?.toLowerCase();
      if (operator && operator !== join) return undefined;
      operator = join;
      parts.push(body.slice(start, token.index).trim());
      start = token.index + token[0].length;
    }
  }
  if (depth) return undefined;
  if (!operator) {
    const atom = qualification(body, vocabulary);
    if (atom) return [[atom]];
    if (body.startsWith('(') && outerEnd === body.length - 1)
      return groupedQualifications(
        body.slice(1, -1).trim(),
        vocabulary,
        nesting + 1,
      );
    return undefined;
  }
  parts.push(body.slice(start).trim());
  if (parts.length > 16) return undefined;
  let result: Qualification[][] | undefined;
  for (const part of parts) {
    const next = groupedQualifications(part, vocabulary, nesting + 1);
    if (!next) return undefined;
    result = !result
      ? next
      : operator === 'and'
        ? [...result, ...next]
        : result.flatMap((left) => next.map((right) => [...left, ...right]));
    if (result.length > 16 || result.some((group) => group.length > 8))
      return undefined;
  }
  return result;
}

/** Illustrative names are evidence of part of a broader tooling condition,
 * not an AND/OR requirement or a complete list of acceptable tools. */
function illustrativeToolRequirements(
  body: string,
  citation: Citation,
  vocabulary: MatchingVocabulary,
): Group[] | undefined {
  const clause = body.match(
    /^(?:strong |solid |demonstrated )?(familiarity|experience|proficiency) with (?:the )?(?:relevant|appropriate) (?:tools(?: and technologies)?|technologies|frameworks|languages)\s*,?\s+(?:such as|for example|e\.g\.)\s+(.+)$/iu,
  );
  if (!clause?.[2]) return undefined;
  const tail = clause[2].split(
    /,\s+with\s+(?=a drive to stay up[- ]to[- ]date\b)/iu,
  );
  if (tail.length > 2) return undefined;
  const parts = (tail[0] ?? '').split(
    /\s*(?:,\s*(?:and |or )?|\s+(?:and|or)\s+|\/)\s*/iu,
  );
  if (!parts.length || parts.length > 12) return undefined;
  const examples = parts.map((part) => vocabulary.aliases.get(phrase(part)));
  if (!examples.every((slug): slug is string => Boolean(slug)))
    return undefined;
  const kind = clause[1]?.toLowerCase();
  if (kind !== 'familiarity' && kind !== 'experience' && kind !== 'proficiency')
    return undefined;
  const groups: Group[] = [
    {
      citation,
      alternatives: [
        { slug: `role-tool-${kind}`, examples: [...new Set(examples)] },
      ],
    },
  ];
  if (tail[1]) {
    const learning = vocabulary.aliases.get(
      phrase(tail[1].replace(/up[- ]to[- ]date/iu, 'up to date')),
    );
    if (learning !== 'continuous-learning') return undefined;
    groups.push({ citation, alternatives: [{ slug: learning }] });
  }
  return groups;
}

function exactQualitativeConjuncts(
  body: string,
  citation: Citation,
  vocabulary: MatchingVocabulary,
): Group[] | undefined {
  if (body.length > 512 || /\b(?:either|or)\b/iu.test(body)) return undefined;
  const delimiters = [...body.matchAll(/,\s+(?:and\s+)?|\s+and\s+/giu)].map(
    (match) => ({
      end: match.index,
      next: match.index + match[0].length,
    }),
  );
  if (!delimiters.length || delimiters.length > 12) return undefined;
  const cuts = [...delimiters, { end: body.length, next: body.length }];
  const term = (input: string) => {
    const text = phrase(input);
    if (
      /^(?:eagerness|willingness|initiative) to (?:problem[- ]solve|solve problems) and (?:(?:move (?:projects and (?:the )?team|(?:the )?team and (?:its )?projects) forward)|(?:keep (?:projects and (?:the )?team|(?:the )?team and (?:its )?projects) moving))$/u.test(
        text,
      )
    )
      return 'initiative-in-team-delivery';
    const slug = vocabulary.aliases.get(text);
    return slug && vocabulary.qualitative.has(slug) ? slug : undefined;
  };
  const cache = new Map<number, string[][]>();
  function solve(start: number): string[][] {
    const saved = cache.get(start);
    if (saved) return saved;
    if (start === body.length) return [[]];
    const combinations: string[][] = [];
    for (const { end, next } of cuts) {
      if (end <= start) continue;
      const slug = term(body.slice(start, end));
      if (!slug) continue;
      for (const tail of solve(next)) {
        combinations.push([slug, ...tail]);
        if (combinations.length > 1) break;
      }
      if (combinations.length > 1) break;
    }
    cache.set(start, combinations);
    return combinations;
  }
  const [only, ambiguous] = solve(0);
  if (!only || only.length < 2 || ambiguous) return undefined;
  return only.map((slug) => ({ citation, alternatives: [{ slug }] }));
}

/**
 * Exact compound requirements retain the whole named scope. Their surrounding
 * source still needs a current complete semantic review.
 */
function scopedPostingRequirements(
  body: string,
  citation: Citation,
  vocabulary: MatchingVocabulary,
): Group[] | undefined {
  const illustrative = illustrativeToolRequirements(body, citation, vocabulary);
  if (illustrative) return illustrative;
  const backendNode = body.match(
    /^(?:have )?(?:at least |minimum of )?(\d{1,2})\+? years?(?:['’])? (?:of )?(?:back[- ]?end) (?:engineering|development) experience (?:of |with )?(?:running|operating|using) node(?:\.js|js) in production$/iu,
  );
  if (backendNode)
    return [
      {
        citation,
        alternatives: [
          {
            slug: 'production-node-backend-engineering',
            years: Number(backendNode[1]),
            context: 'production',
            partialCapabilities: ['nodejs'],
          },
        ],
      },
    ];
  if (
    /^(?:have )?experience (?:with|using|operating) production(?:[- ]grade)? postgresql(?: (?:usage|use))?(?:,| and)? (?:including |covering )?(?:(?:performance )?tuning and troubleshooting|troubleshooting and (?:performance )?tuning)$/iu.test(
      body,
    )
  )
    return [
      {
        citation,
        alternatives: [
          {
            slug: 'postgresql-operational-tuning',
            context: 'production',
            partialCapabilities: ['postgresql'],
          },
        ],
      },
    ];
  if (
    /^(?:are )?comfortable (?:with )?work(?:ing)? across (?:the|a) stack\s*[-–—:]\s*back[- ]?end (?:application |service )?development, (?:some )?infrastructure (?:work |operations )?(?:including |covering )?(?:deploying|deployment), monitoring,? and (?:scaling|scaling the service|scaling services)$/iu.test(
      body,
    )
  )
    return [
      { citation, alternatives: [{ slug: 'cross-stack-service-operations' }] },
    ];
  const observability = body.match(
    /^(?:posses(?:s)? |have )?(?:familiarity|experience) with observability (?:tools|tooling) \(([^()]+)\),? (?:and|plus) (?:software |application )?performance tuning$/iu,
  );
  if (observability) {
    const names = (observability[1] ?? '').split(/,\s*|\s+(?:and|or)\s+/iu);
    const examples = names.map((part) => vocabulary.aliases.get(phrase(part)));
    if (
      examples.length &&
      examples.length <= 8 &&
      examples.every((slug): slug is string => Boolean(slug))
    )
      return [
        { citation, alternatives: [{ slug: 'observability', examples }] },
        {
          citation,
          alternatives: [{ slug: 'software-performance-tuning' }],
        },
      ];
  }
  if (
    /^(?:demonstrate|show) (?:an? )?(?:ownership mentality|ownership mindset|ownership):\s*(?:driving|owning|delivering) projects end[- ]to[- ]end$/iu.test(
      body,
    )
  )
    return [
      { citation, alternatives: [{ slug: 'end-to-end-project-ownership' }] },
    ];
  const empathy = body.match(/^(?:display|show|demonstrate) (.+)$/iu);
  if (
    empathy &&
    vocabulary.aliases.get(phrase(empathy[1] ?? '')) ===
      'developer-experience-empathy'
  )
    return [
      { citation, alternatives: [{ slug: 'developer-experience-empathy' }] },
    ];

  const compound = body.match(
    /^(?:have )?(\d{1,2})\+? years? (?:of )?(?:(professional|production) )?experience as (?:a |an )?full[- ]stack (?:software )?(?:engineer|developer)(?:,| working on)? (?:building|developing|designing and building) scalable web applications$/iu,
  );
  if (compound) {
    const context = compound[2]?.toLowerCase();
    return [
      {
        citation,
        alternatives: [
          {
            slug: 'scalable-full-stack-web-development',
            years: Number(compound[1]),
            context:
              context === 'professional' || context === 'production'
                ? context
                : undefined,
          },
        ],
      },
    ];
  }
  if (
    /^(?:have )?experience (?:with|building|operating) highly scalable,? distributed systems$/iu.test(
      body,
    )
  )
    return [
      {
        citation,
        alternatives: [{ slug: 'highly-scalable-distributed-systems' }],
      },
    ];
  if (
    /^(?:leadership skills in |experience (?:in |with )?)?(?:unblocking and leading|leading and unblocking) (?:development|engineering|software) teams$/iu.test(
      body,
    )
  )
    return [
      {
        citation,
        alternatives: [{ slug: 'removing-engineering-delivery-obstacles' }],
      },
      { citation, alternatives: [{ slug: 'engineering-team-leadership' }] },
    ];
  const leadership = body.match(/^leadership skills in (.+)$/iu);
  if (
    leadership &&
    vocabulary.aliases.get(phrase(leadership[1] ?? '')) ===
      'engineering-team-leadership'
  )
    return [
      { citation, alternatives: [{ slug: 'engineering-team-leadership' }] },
    ];
  return exactQualitativeConjuncts(body, citation, vocabulary);
}

/** Simple explicit conjunctive form. Mixed ungrouped conjunction and disjunction is ambiguous. */
function parseGroups(
  value: string,
  citation: Citation,
  vocabulary: MatchingVocabulary,
): Group[] | undefined {
  const body = value
    .trim()
    .replace(/[.;]$/u, '')
    // An explicit "either" or "one of" scopes a simple alternative
    // list. This wrapper carries no duration or use-context qualifier.
    .replace(
      /^(?:(?:hands-on |applied |practical |proven )?experience|proficiency|proficient|(?:working )?knowledge|understanding|familiarity|expertise) (?:with|in|of|using) (?=(?:either|one of)\s+)/iu,
      '',
    );
  const exact = vocabulary.aliases.get(phrase(body));
  if (exact) return [{ citation, alternatives: [{ slug: exact }] }];
  if (citation.field === 'description') {
    const scoped = scopedPostingRequirements(body, citation, vocabulary);
    if (scoped)
      return scoped.map((group) => ({ ...group, requiresSourceReview: true }));
  }
  if (body.includes('(') && /\s(?:and|or)\s/iu.test(body)) {
    const grouped = groupedQualifications(body, vocabulary);
    if (grouped) {
      const qualified = grouped
        .flat()
        .map((atom) => Boolean(atom.years || atom.context));
      if (qualified.every(Boolean) || qualified.every((value) => !value))
        return grouped.map((alternatives) => ({ citation, alternatives }));
    }
  }
  // An Oxford-comma OR list is explicitly disjunctive if its members
  // are simple atoms. Mixed and/or stays subject to the grouping rules below.
  const explicitlyDisjunctive = /^(?:either|one of)\s+/iu.test(body);
  if (explicitlyDisjunctive || /,\s*or\s+/iu.test(body)) {
    const alternatives = body
      .replace(/^(?:either|one of)\s+/iu, '')
      .replace(/,\s*or\s+/giu, ' or ')
      .split(/\s+or\s+|,\s*/iu)
      .map((atom) => qualification(atom, vocabulary));
    const qualified = alternatives.map((atom) =>
      Boolean(atom?.years || atom?.context),
    );
    if (
      alternatives.length > 1 &&
      alternatives.every(Boolean) &&
      (qualified.every((value) => !value) ||
        (explicitlyDisjunctive &&
          !body.includes(',') &&
          qualified.every(Boolean)))
    )
      return [
        {
          citation,
          alternatives: alternatives.filter(
            (atom): atom is Qualification => !!atom,
          ),
        },
      ];
    if (explicitlyDisjunctive) return undefined;
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

function descriptionLines(raw: string) {
  return matchingDescriptionUnits(raw).map(({ text, start, end }) => ({
    text,
    citation: cite('description', raw, start, end),
  }));
}

const requiredHeader =
  /^(?:required(?: skills| qualifications| experience| skills (?:and|&) experience)?|(?:minimum|basic|core|essential) (?:skills|qualifications|requirements)|qualifications|requirements|skills and qualifications|about you|who you are|must[- ]haves|what (?:you.ll|you will|you should) (?:need|bring)|what you bring(?: along)?|what we(?:.re| are)? look(?:ing)? for|what makes you a great fit|you might be a good fit if you|how to be successful in this role|your skills and experience)\s*[:：]?\s*$/iu;
const preferredHeader =
  /^(?:preferred(?: skills| qualifications| experience| skills (?:and|&) experience)?|nice[- ]to[- ]haves?|bonus(?: skills| points)?|bonus points (?:if(?: you have)?|for)|desired qualifications|optional qualifications|helpful (?:skills|experience|qualifications)|it.d be great if you (?:have|also have))\s*[:：]?\s*$/iu;
const dutiesHeader =
  /^(?:responsibilities|(?:key|job|role) responsibilities|duties|what (?:you.ll|you will|will you) (?:do|be doing)|your (?:impact|mission)|how you.ll make an impact|about (?:us|the (?:role|team|job|company|position))|the (?:role|opportunity|team)|who we are|what is the role)\s*[:：?]?\s*$/iu;
const explicitDutiesHeader =
  /^(?:responsibilities|(?:key|job|role) responsibilities|duties|what (?:you.ll|you will|will you) (?:do|be doing))\s*[:：?]?\s*$/iu;
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
): { role?: Role; conflict?: MatchingReason } {
  const title = cite('title', raw.title);
  const explicit = normalizeRole(raw.title, title);
  const declared = lines.flatMap(({ text, citation }) => {
    const statement =
      text.match(
        /^(?:we are|we.re) (?:hiring|seeking|looking for) (?:a|an) (.{1,100}?)(?: (?:to|who will|who can|for our|for the)\b|[.!]?$)/iu,
      ) ??
      text.match(
        /^(?:the primary role is|this position is for) (?:a|an) (.{1,100}?)\.?$/iu,
      ) ??
      text.match(/^as (?:a|an) (.{1,100}?),\s+you(?: will|['’]ll)\b/iu);
    const role = statement?.[1] && normalizeRole(statement[1], citation);
    return role ? [role] : [];
  });
  const first = explicit ?? declared[0];
  if (!first) return {};

  // Numbered job grades are not portable seniority labels. A direct
  // seniority statement cannot silently replace the title's grade.
  const titleGrade = /\b(?:i|ii|iii|iv|v|[1-5])$/iu.test(
    normalizedTitle(raw.title.split(/[,|]|\s+[-–—/]\s+/u, 1)[0] ?? ''),
  );
  const conflict = declared.find(
    (role) =>
      role.family !== first.family ||
      (role.specialty &&
        first.specialty &&
        role.specialty !== first.specialty) ||
      (role.level && first.level && role.level !== first.level) ||
      (explicit && titleGrade && !explicit.level && role.level),
  );
  if (conflict)
    return {
      conflict: reason(
        'posting-role-ambiguous',
        'unknown',
        'The posting gives conflicting role descriptions.',
        first.citation,
        conflict.citation,
      ),
    };
  return {
    role:
      explicit ?? (genericRoleLabel.test(raw.title.trim()) ? first : undefined),
  };
}

function directWorkLocation(text: string) {
  const declared = text.match(
    /(?:^|[.!?]\s+)this (?:role|position|job) is (?:based )?(remote(?:ly)?|hybrid|on[- ]?site) (?:in|within|from) ([^.!?;]+?)(?:[.!?](?:\s|$)|$)/iu,
  );
  if (declared)
    return {
      mode: workMode((declared[1] ?? '').replace(/ly$/iu, '')),
      location: declared[2] ?? '',
    };
  const required = text.match(
    /\b(?:(?:we (?:do )?require that (?:someone|candidates?|applicants?) (?:is|are|be))|(?:(?:candidates?|applicants?) must be)) based in ([^.!?;]+?)(?:\s+for (?:this|the) (?:role|position))?(?:[.!?](?:\s|$)|$)/iu,
  );
  if (required) return { mode: undefined, location: required[1] ?? '' };
  const labeled = text.match(
    /^(?:work )?location\s*[-–—]\s*(remote|hybrid|on[- ]?site)\b\s*(?:[-–—:]\s*|in\s+|within\s+)?(.+?)\.?$/iu,
  );
  return labeled
    ? { mode: workMode(labeled[1] ?? ''), location: labeled[2] ?? '' }
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
  const key = ({
    slug,
    label,
    years,
    context,
    examples,
    partialCapabilities,
  }: Qualification) =>
    JSON.stringify([
      slug || phrase(label ?? ''),
      years,
      context,
      examples,
      partialCapabilities,
    ]);
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
  covered?: ReadonlySet<string>,
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
        if (
          !covered?.has(
            vocabulary.aliases.get(text.slice(start.index, end)) ?? '',
          )
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
  // The cited capability is only one part of the witness. Approve the
  // residual words when they express a supported wrapper, duration, or use
  // context. Free prose can impose a domain or scope the capability alone
  // would not establish.
  const prefix = first.trim().replace(/^\(\s*/u, '');
  const suffix = last
    .trim()
    .replace(/[.)!]+$/u, '')
    .trim();
  const supportedPrefix =
    /^(?:(?:(?:you (?:must have|have|bring)|the role calls for)\s+)?(?:a )?(?:(?:at least |minimum of )?\d{1,2}\+? years?['’]? (?:of )?)?(?:(?:relevant|professional|production|working|hands-on|applied|practical|proven|strong|solid|deep) )*(?:(?:experience|knowledge|proficiency|expertise|familiarity) (?:with|in|of|using)(?: (?:production-level|production-grade|either))?|(?:either|one of)))?$/iu;
  const supportedSuffix =
    /^(?:(?:experience|knowledge|proficiency)|(?:for \d{1,2}\+? years? )?in production)?$/iu;
  const shipped =
    /^you have shipped services running on$/iu.test(prefix) &&
    /^for \d{1,2}\+? years? in production$/iu.test(suffix);
  if (
    !(supportedPrefix.test(prefix) && supportedSuffix.test(suffix)) &&
    !shipped
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
  return parseGeography(line ? location : text, mode, citation);
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

/** Optional draft aids derived entirely from the captured public text. */
export function matchingSourceSectionHints(description: string) {
  type Section = 'required' | 'preferred' | 'duties' | 'administrative';
  let section: Section | undefined;
  const hints = new Map<
    number,
    { sectionHint: Section; sectionHeading: boolean }
  >();
  for (const { text, start } of matchingDescriptionUnits(description)) {
    const { head, tail } = postingHeading(text);
    const heading = requiredHeader.test(head)
      ? 'required'
      : preferredHeader.test(head)
        ? 'preferred'
        : explicitDutiesHeader.test(head)
          ? 'duties'
          : administrativeHeader.test(head)
            ? 'administrative'
            : undefined;
    section = heading ?? (dutiesHeader.test(head) ? undefined : section);
    if (section)
      hints.set(start, {
        sectionHint: section,
        sectionHeading: Boolean(heading && !tail),
      });
  }
  return hints;
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
    raw.description.length <= MATCHING_SOURCE_DESCRIPTION_LIMIT;
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
  const role =
    roleConflict ||
    posting.uncertainties.some(({ code }) => code === 'posting-role-ambiguous')
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
        'posting-requirement-unsupported',
        'unknown',
        'A required condition uses wording or logic that matching cannot verify.',
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

type SemanticProof = NonNullable<MatchingSourceExtraction['semantic']>;
type SemanticLedgerUnit = SemanticProof['proposal']['ledger'][number];

function semanticQualifications(
  unit: SemanticLedgerUnit,
  citation: Citation,
  vocabulary: MatchingVocabulary,
) {
  const atoms = unit.groups.flatMap(({ alternatives }) => alternatives);
  const wording = citation.text
    .replace(/<[^<>]+>/gu, ' ')
    .replace(/\s+/gu, ' ');
  const years = [...wording.matchAll(/\b(\d{1,2})\+?\s+years?\b/giu)].map(
    (match) => Number(match[1]),
  );
  const contexts = [
    ...wording.matchAll(
      /\b(professional|production)(?:[- ](?:level|grade|experience))\b|\bin (production)\b/giu,
    ),
  ].map((match) => (match[1] ?? match[2])?.toLowerCase());
  const and =
    /\b(?:and|both|plus|as well as|together with|along with)\b|[;&]/iu.test(
      wording,
    );
  const or = /\b(?:or|either|one of)\b/iu.test(wording);
  const proposed = new Set(atoms.flatMap(({ conceptId }) => conceptId ?? []));
  const qualitative = atoms.filter(
    ({ conceptId, years, context }) =>
      conceptId &&
      vocabulary.qualitative.has(conceptId) &&
      years === null &&
      context === null,
  );
  const joinCount = [
    ...wording.matchAll(
      /\b(?:and|plus|as well as|together with|along with)\b|[,;&]/giu,
    ),
  ].length;
  // A qualitative claim must name a governed trait actually present in this
  // line, with every other condition still represented independently.
  if (
    qualitative.length &&
    (/\b(?:no|not|never|minimum|eligib\w*|authori[sz]ation|qualifications? required|years?|months?)\b/iu.test(
      wording,
    ) ||
      (!or && unit.groups.length < joinCount + 1) ||
      new Set(qualitative.map(({ conceptId }) => conceptId)).size !==
        qualitative.length ||
      qualitative.some(
        ({ conceptId, unsupportedQualifier }) =>
          unsupportedQualifier ||
          !conceptId ||
          ![...vocabulary.aliases].some(([alias, slug]) => {
            if (slug !== conceptId) return false;
            const pattern = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
            const mention = new RegExp(
              `(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`,
              'iu',
            ).exec(wording);
            if (!mention) return false;
            // A trailing domain or constraint cannot be dropped by a generic trait.
            const following = wording
              .slice(mention.index + mention[0].length)
              .trim();
            return (
              !following ||
              /^(?:[.,;:!?]|(?:and|or|plus|as well as|together with|along with)\b)/iu.test(
                following,
              )
            );
          }),
      ))
  )
    return undefined;

  // Typed review can identify a canonical concept in prose. It cannot waive
  // independently visible credential/eligibility limits or certify ambiguous
  // qualifier scope. Exact deterministic groups are handled before this step.
  if (
    supplementalLimit.test(wording) ||
    atoms.some(({ conceptId }) => conceptId?.startsWith('role-tool-')) ||
    hasGovernedCapabilityOutsideProof(wording, vocabulary, proposed) ||
    /\b(?:without|unless|except|excluding|instead of|at least (?:two|three|four|[2-9]) of)\b|\band\/or\b/iu.test(
      wording,
    ) ||
    (and && or) ||
    (and && unit.groups.length < 2) ||
    (!or && unit.groups.some(({ alternatives }) => alternatives.length > 1)) ||
    (or && !unit.groups.some(({ alternatives }) => alternatives.length > 1)) ||
    years.length > 1 ||
    contexts.length > 1 ||
    atoms.some(
      (atom) =>
        atom.years !== (years[0] ?? null) ||
        atom.context !== (contexts[0] ?? null),
    )
  )
    return undefined;
  return unit.groups.map(({ alternatives }) => ({
    citation,
    alternatives: alternatives.map(
      ({ conceptId, years, context, unsupportedQualifier }) => {
        const label = conceptId ? vocabulary.labels.get(conceptId) : undefined;
        return {
          slug: label && !unsupportedQualifier ? (conceptId ?? '') : '',
          label:
            label && !unsupportedQualifier ? label : 'an unverified condition',
          years: years ?? undefined,
          context: context ?? undefined,
        };
      },
    ),
  }));
}

function semanticRole(
  posting: NormalizedMatchingPosting,
  raw: MatchingPostingInput,
  claim: SemanticProof['proposal']['role'],
  citeUnit: (id: string) => Citation | undefined,
): Role | undefined {
  if (!claim) return undefined;
  const citation = citeUnit(claim.unitId);
  if (
    !citation ||
    (citation.field !== 'title' &&
      (!genericRoleLabel.test(raw.title.trim()) ||
        !roleStatement.test(citation.text)))
  )
    return undefined;
  const original = posting.role;
  if (
    original &&
    (original.family !== claim.family ||
      (original.specialty && original.specialty !== claim.specialty) ||
      (original.level && original.level !== claim.level))
  )
    return undefined;
  const visibleLevels = new Set(
    [
      ...normalizedTitle(citation.text).matchAll(
        /\b(entry level|mid level|entry|mid|intermediate|junior|jr|associate|senior|sr|staff|principal|lead)\b/gu,
      ),
    ].map((match) => levels[match[1] ?? '']),
  );
  if (
    /\b(?:or|either)\b|\s\/\s/iu.test(citation.text) ||
    visibleLevels.size > 1 ||
    (!visibleLevels.size && Boolean(claim.level)) ||
    (visibleLevels.size === 1 &&
      (!claim.level || !visibleLevels.has(claim.level)))
  )
    return undefined;
  const visibleSpecialties = softwareSpecialties.filter(([, names]) =>
    names.some((name) =>
      new RegExp(`\\b${name}\\b`, 'u').test(normalizedTitle(citation.text)),
    ),
  );
  if (
    claim.family === 'software-engineering' &&
    visibleSpecialties.some(([specialty]) => claim.specialty !== specialty)
  )
    return undefined;
  return {
    family: claim.family,
    specialty: claim.specialty ?? undefined,
    level: claim.level ?? undefined,
    citation,
  };
}

function semanticGeography(
  raw: MatchingPostingInput,
  claim: SemanticProof['proposal']['geography'],
  citeUnit: (id: string) => Citation | undefined,
): Geography | undefined {
  if (!claim) return undefined;
  const citation = citeUnit(claim.unitId);
  if (!citation) return undefined;
  const declared = workMode(raw.workplaceType ?? '');
  const mode = claim.mode ?? undefined;
  if (declared && declared !== mode) return undefined;
  const direct =
    citation.field === 'location' ||
    (mode === 'remote' &&
      /^(?:fully )?remote\s+(?:in|within|from)\b/iu.test(citation.text))
      ? parseGeography(citation.text, mode, citation)
      : undefined;
  const scope =
    citation.field === 'description' && mode === 'remote'
      ? citation.text.match(
          /^(?:this (?:role|position) is remote and open to (?:residents of|applicants in)|we(?:['’]re| are) hiring remotely (?:in|across)) (.+?)\.?$/iu,
        )?.[1]
      : undefined;
  const verified = scope ? parseGeography(scope, mode, citation) : direct;
  if (!verified) return undefined;
  const proposed = {
    mode,
    regions: claim.countries.map((country) => ({ country })),
    worldwide: claim.worldwide,
    citation,
  };
  return sameGeography(verified, proposed) ? proposed : undefined;
}

// A verified context classification can resolve a conservative false alarm on
// recognizable employer disclosures. Preserve applicant conditions anywhere in
// that same unit, including a condition attached to an administrative sentence.
const employerDisclosure =
  /\b(?:salary range disclosure|equal (?:employment )?opportunity employer|inclusive hiring|use of (?:artificial intelligence|ai) in (?:recruitment|hiring)|recruitment process|compensation (?:bands|philosophy)|the salary range listed)\b/iu;
function safeEmployerDisclosure(text: string): boolean {
  if (!employerDisclosure.test(text)) return false;
  const applicant = text
    .replace(
      /\b(?:if|should) you (?:require|need) (?:any |a reasonable )?accommodations?\b/giu,
      '',
    )
    .replace(/\b(?:which )?depends on experience and skills\b/giu, '');
  return !(
    employmentCondition.test(applicant) ||
    essentialCondition.test(applicant) ||
    requiredInAdministrativeText.test(applicant) ||
    independentHardCue.test(applicant) ||
    sectionHasCandidateQualification(applicant) ||
    /\b(?:fluency|fluent|native speaker|ability to|track record|work authori[sz]ation|(?:security )?clearance|relocation|on[- ]call|weekends?|\d+\+? years?)\b/iu.test(
      applicant,
    ) ||
    /\b(?:we (?:expect|require)|(?:applicants?|candidates?|you) (?:have to|should have|are expected to|need|have|bring)|only (?:applicants?|candidates?|residents?))\b/iu.test(
      applicant,
    )
  );
}

function semanticContextLines(raw: MatchingPostingInput) {
  let inMandatorySection = false;
  const safe = new Set<number>();
  for (const { text, citation } of descriptionLines(raw.description)) {
    const { head, tail } = postingHeading(text);
    const administrative = administrativeHeader.test(head);
    const duties = dutiesHeader.test(head);
    const requirement = requiredHeader.test(head) || preferredHeader.test(head);
    if (administrative || duties || requirement) {
      inMandatorySection = requiredHeader.test(head);
      if (!tail) {
        safe.add(citation.start);
        continue;
      }
    }
    if (noRequirements.test(tail ?? text)) {
      safe.add(citation.start);
      continue;
    }
    if (
      inMandatorySection ||
      (!safeEmployerDisclosure(text) &&
        (independentApplicantCondition(text) ||
          sectionHasCandidateQualification(text) ||
          /\b(?:fluen\w*|language skills|native speaker|proficien\w*|working knowledge|ability to|track record|\d+\+? years? of (?:work |professional )?experience)\b/iu.test(
            text,
          )))
    )
      continue;
    safe.add(citation.start);
  }
  return safe;
}

function mergeSemanticExtraction(
  raw: MatchingPostingInput,
  posting: NormalizedMatchingPosting,
  proof: SemanticProof,
  vocabulary: MatchingVocabulary,
): NormalizedMatchingPosting {
  const units = new Map(
    matchingSourceSemanticUnits(raw).map((unit) => [unit.id, unit]),
  );
  const citeUnit = (id: string) => {
    const unit = units.get(id);
    return unit && cite(unit.field, raw[unit.field], unit.start, unit.end);
  };
  const verifiedUnits = new Set(
    proof.verification.units
      .filter(
        ({
          classificationCorrect,
          allConditionsRepresented,
          logicAndQualifiersPreserved,
        }) =>
          classificationCorrect &&
          allConditionsRepresented &&
          logicAndQualifiersPreserved,
      )
      .map(({ id }) => id),
  );
  const confirmedClassificationsAndCoverage = new Set(
    proof.verification.units
      .filter(
        ({ classificationCorrect, allConditionsRepresented }) =>
          classificationCorrect && allConditionsRepresented,
      )
      .map(({ id }) => id),
  );
  const confirmedClassifications = new Set(
    proof.verification.units
      .filter(({ classificationCorrect }) => classificationCorrect)
      .map(({ id }) => id),
  );
  const required = [...posting.required];
  const preferred = [...posting.preferred];
  const preferredUncertainties = [...posting.preferredUncertainties];
  const coveredHard: Citation[] = [];
  const verifiedDisclosures: Citation[] = [];
  const unresolved: MatchingReason[] = [];
  const contextLines = semanticContextLines(raw);
  for (const unit of proof.proposal.ledger) {
    const citation = citeUnit(unit.id);
    if (!citation) continue;
    const knownRequired = posting.required.filter((group) =>
      sameSourceLine(group.citation, citation),
    );
    if (knownRequired.some((group) => group.requiresSourceReview)) {
      // The host establishes the full exact scope. The independent reader
      // must still corroborate that the whole source unit is mandatory.
      if (
        unit.kind !== 'requirement' ||
        !confirmedClassifications.has(unit.id)
      ) {
        unresolved.push(
          reason(
            'posting-requirement-unknown',
            'unknown',
            'Source review could not confirm this mandatory requirement.',
            citation,
          ),
        );
      } else {
        coveredHard.push(citation);
      }
      continue;
    }
    if (
      knownRequired.length ||
      posting.preferred.some((group) =>
        sameSourceLine(group.citation, citation),
      )
    )
      continue;
    const independentlyOptional =
      unit.kind === 'preferred' &&
      citation.field === 'description' &&
      !posting.uncertainties.some(({ citations }) =>
        citations.some((entry) => sameSourceLine(entry, citation)),
      ) &&
      (optionalLanguage.test(citation.text) ||
        posting.preferredUncertainties.some(({ citations }) =>
          citations.some((entry) => sameSourceLine(entry, citation)),
        ));
    if (
      independentlyOptional &&
      confirmedClassifications.has(unit.id) &&
      !verifiedUnits.has(unit.id)
    ) {
      if (
        !preferredUncertainties.some(({ citations }) =>
          citations.some((entry) => sameSourceLine(entry, citation)),
        )
      )
        preferredUncertainties.push(
          reason(
            'posting-preference-unknown',
            'unknown',
            'Source review could not verify the scope of this preference.',
            citation,
          ),
        );
      continue;
    }
    const titleCondition =
      citation.field === 'title' &&
      (independentApplicantCondition(citation.text) ||
        hardLanguage.test(citation.text) ||
        supplementalLimit.test(citation.text));
    const independentlyKnownTitle =
      unit.kind === 'context' &&
      citation.field === 'title' &&
      !titleCondition &&
      posting.role?.citation.field === 'title' &&
      confirmedClassificationsAndCoverage.has(unit.id) &&
      plainGovernedRoleTitle(citation);
    if (
      titleCondition ||
      (!verifiedUnits.has(unit.id) && !independentlyKnownTitle) ||
      unit.kind === 'unresolved' ||
      (unit.kind === 'context' &&
        citation.field === 'description' &&
        !contextLines.has(citation.start))
    ) {
      unresolved.push(
        reason(
          'posting-requirement-unknown',
          'unknown',
          'Source review could not verify this part of the posting.',
          citation,
        ),
      );
      continue;
    }
    if (unit.kind === 'context') {
      if (
        citation.field === 'description' &&
        safeEmployerDisclosure(citation.text)
      )
        verifiedDisclosures.push(citation);
      continue;
    }
    if (citation.field !== 'description') continue;
    const isRequired = unit.kind === 'requirement';
    if (
      !isRequired &&
      !optionalLanguage.test(citation.text) &&
      !posting.preferredUncertainties.some(({ citations }) =>
        citations.some((entry) => sameSourceLine(entry, citation)),
      )
    ) {
      unresolved.push(
        reason(
          'posting-requirement-unknown',
          'unknown',
          'The source does not establish whether this condition is optional.',
          citation,
        ),
      );
      continue;
    }
    const groups = semanticQualifications(unit, citation, vocabulary);
    if (!groups) {
      if (isRequired)
        unresolved.push(
          reason(
            'posting-requirement-unsupported',
            'unknown',
            'Matching could not verify the full scope of this requirement.',
            citation,
          ),
        );
      continue;
    }
    if (isRequired) coveredHard.push(citation);
    const destination = isRequired ? required : preferred;
    for (const group of groups) {
      if (
        !destination.some((prior) =>
          sameGroup(prior.alternatives, group.alternatives),
        )
      )
        destination.push(group);
    }
  }
  const roleClaim = proof.proposal.role;
  const proposedRole =
    proof.verification.roleCorrect &&
    roleClaim &&
    verifiedUnits.has(roleClaim.unitId)
      ? semanticRole(posting, raw, roleClaim, citeUnit)
      : undefined;
  const role = posting.uncertainties.some(
    ({ code }) => code === 'posting-role-ambiguous',
  )
    ? undefined
    : (proposedRole ?? posting.role);
  const geoClaim = proof.proposal.geography;
  const proposedGeo =
    proof.verification.geographyCorrect &&
    geoClaim &&
    verifiedUnits.has(geoClaim.unitId)
      ? semanticGeography(raw, geoClaim, citeUnit)
      : undefined;
  const directLocation =
    proposedGeo &&
    parseGeography(
      raw.location,
      proposedGeo.mode,
      cite('location', raw.location),
    );
  const geoConflict =
    proposedGeo &&
    posting.geography &&
    !sameGeography(posting.geography, proposedGeo);
  const compatibleLocation =
    !raw.location.trim() ||
    workMode(raw.location) === 'remote' ||
    (proposedGeo &&
      directLocation &&
      sameGeography(directLocation, proposedGeo));
  const geography = geoConflict
    ? undefined
    : (posting.geography ??
      (compatibleLocation &&
      !posting.uncertainties.some(
        ({ code }) => code === 'posting-geography-ambiguous',
      )
        ? proposedGeo
        : undefined));
  if (geoConflict && proposedGeo && posting.geography)
    unresolved.push(
      reason(
        'posting-geography-ambiguous',
        'unknown',
        'The posting gives conflicting work locations.',
        posting.geography.citation,
        proposedGeo.citation,
      ),
    );
  const uncertainties = posting.uncertainties.filter(({ code, citations }) => {
    if (code === 'posting-role-unknown' && role) return false;
    if (code === 'posting-geography-unknown' && geography) return false;
    if (code === 'posting-requirements-incomplete')
      return unresolved.length > 0 || !coveredHard.length;
    if (code !== 'posting-requirement-unknown') return true;
    return (
      !citations.length ||
      !citations.every((citation) =>
        [...coveredHard, ...verifiedDisclosures].some((covered) =>
          sameSourceLine(covered, citation),
        ),
      )
    );
  });
  return {
    ...posting,
    role,
    geography,
    required,
    preferred,
    preferredUncertainties,
    uncertainties: [...uncertainties, ...unresolved],
  };
}

export function normalizeMatchingPosting(
  raw: MatchingPostingInput,
  vocabulary: MatchingVocabulary,
  extraction?: MatchingSourceExtraction,
): NormalizedMatchingPosting {
  const title = cite('title', raw.title);
  const lines = descriptionLines(raw.description);
  const { role, conflict: roleConflict } = postingRole(raw, lines);
  const uncertainties: MatchingReason[] = [];
  if (roleConflict) uncertainties.push(roleConflict);
  else if (!role)
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
    /(?:^|[;|])\s*(?:fully\s+)?remote\b|\(remote\)\s*(?:$|[;|])/iu.test(
      raw.location,
    );
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
    const workLocation = directWorkLocation(text);
    if (workLocation) {
      const currentMode = mode ?? geography?.mode;
      const stated = parseGeography(
        workLocation.location,
        workLocation.mode ?? currentMode,
        citation,
      );
      if (
        !stated ||
        (workLocation.mode &&
          currentMode &&
          workLocation.mode !== currentMode) ||
        (geography && !sameGeography(geography, stated)) ||
        (!geography && raw.location.trim() && !workMode(raw.location))
      ) {
        conflictingGeography = true;
        uncertainties.push(
          reason(
            'posting-geography-ambiguous',
            'unknown',
            'The posting has an unclear or conflicting work location.',
            location,
            citation,
          ),
        );
      } else {
        geography ??= stated;
      }
      // Keep normal requirement parsing for the whole unit. A location
      // statement within a paragraph does not cover other conditions.
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
  if (
    !seenHardMaterial ||
    required.some((group) => group.requiresSourceReview) ||
    raw.description.length > MATCHING_SOURCE_DESCRIPTION_LIMIT
  )
    uncertainties.push(
      reason(
        'posting-requirements-incomplete',
        'unknown',
        'The posting does not establish a complete set of requirements.',
      ),
    );
  if (!extraction && uncertainties.length)
    uncertainties.push(
      reason(
        'posting-source-interpretation-missing',
        'unknown',
        'The posting has unresolved details and no current source interpretation.',
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
  const result = extraction?.semantic
    ? mergeSemanticExtraction(raw, posting, extraction.semantic, vocabulary)
    : extraction
      ? mergeSourceExtraction(raw, lines, posting, extraction, vocabulary)
      : posting;
  const addLabels = (groups: readonly Group[]) =>
    groups.map(({ alternatives, citation }) => ({
      citation,
      alternatives: alternatives.map((atom) => ({
        ...atom,
        label: vocabulary.labels.get(atom.slug) ?? atom.label,
        ...(!atom.years &&
        !atom.context &&
        vocabulary.qualitative.has(atom.slug)
          ? { qualitative: true as const }
          : {}),
      })),
    }));
  return {
    ...result,
    required: addLabels(result.required),
    preferred: addLabels(result.preferred),
  };
}

// These are role-level capabilities. A held title never proves a technology
// or production context, and job dates never qualify a standalone skill.
function datedRoleEvidence(
  items: MatchingCandidateInput['evidence'],
  vocabulary: MatchingVocabulary,
  asOf: number,
): Evidence[] {
  return items.flatMap((item): Evidence[] => {
    if (item.kind !== 'experience' || !item.position) return [];
    const { role, start, end } = item.position;
    const period = conservativeExperiencePeriod(start, end, asOf);
    const citation = cite('evidence', item.text, 0, item.text.length, item.id);
    const parsed = exactRole(role, citation);
    if (!period || !parsed) return [];
    const capabilities =
      parsed.family === 'software-engineering'
        ? [
            'software-development',
            ...(parsed.specialty === 'backend'
              ? ['backend-development']
              : parsed.specialty === 'frontend'
                ? ['frontend-development']
                : parsed.specialty === 'full-stack'
                  ? ['full-stack-development']
                  : []),
          ]
        : parsed.family === 'software-architecture'
          ? ['software-architecture']
          : parsed.family === 'engineering-management'
            ? ['engineering-management']
            : [];
    return capabilities
      .filter((slug) => vocabulary.labels.has(slug))
      .map((slug) => ({
        slug,
        period,
        context: 'professional',
        polarity: 'positive',
        citation,
        ongoing: candidatePeriodIsOngoing(end) ? true : undefined,
      }));
  });
}

function durationUpperBound(
  statement: string,
  citation: Citation,
  vocabulary: MatchingVocabulary,
): Evidence | undefined {
  const total = candidateTotalDurationLimit(statement, vocabulary);
  if (total)
    return {
      ...total,
      polarity: total.years ? 'positive' : 'upper-bound',
      citation,
    };
  const explicit = phrase(statement).match(
    /^(?:(?:i )?have )?(only|at most) (\d{1,2} years?\b.*)$/u,
  );
  if (!explicit?.[2]) return undefined;
  const proof = qualification(explicit[2], vocabulary);
  if (proof?.years === undefined) return undefined;
  return {
    ...proof,
    polarity:
      explicit[1] === 'only' && proof.years > 0 ? 'positive' : 'upper-bound',
    maximumYears: proof.years,
    citation,
  };
}

function normalizeEvidence(
  input: MatchingCandidateInput['evidence'][number],
  vocabulary: MatchingVocabulary,
): Evidence[] {
  if (input.kind === 'skill') {
    const citation = cite(
      'evidence',
      input.text,
      0,
      input.text.length,
      input.id,
    );
    const bounded = durationUpperBound(input.text, citation, vocabulary);
    if (bounded) return [bounded];
    // Structured skills may explicitly name a duration/context or a list
    // of held skills. An alternative or unrecognized composite proves none.
    const groups = parseGroups(input.text, citation, vocabulary);
    return groups?.every(({ alternatives }) => alternatives.length === 1)
      ? groups.flatMap(({ alternatives }) =>
          alternatives.map((proof) => ({
            ...proof,
            polarity: 'positive',
            citation,
          })),
        )
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
        /^(?:i have )?no (?:(?<context>professional|production) )?(?:hands-on )?(?:experience|knowledge) (?:with|in|of|using) (?<skill>.+)$/u,
      ) ??
      text.match(
        /^(?:i )?(?:have never|never) (?:used|worked with) (?<skill>.+)$/u,
      );
    const action =
      text.match(
        /^(?:i )?(?:have )?(?:used|worked with|implemented|maintained|administered|configured) (.+)$/u,
      ) ??
      text.match(
        /^(?:i )?(?:built|developed|designed|operated|deployed|migrated|tested|created|wrote) [\p{L}\p{N} ,/_-]{1,100} (?:using|with) (.+)$/u,
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
    const bounded = durationUpperBound(statement, citation, vocabulary);
    if (bounded) {
      evidence.push(bounded);
    } else if (denial) {
      const slug = vocabulary.aliases.get(denial.groups?.skill ?? '');
      const context = denial.groups?.context;
      if (slug)
        evidence.push({
          slug,
          context:
            context === 'production' || context === 'professional'
              ? context
              : undefined,
          polarity: 'negative',
          citation,
        });
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

function interpretedEvidence(
  input: MatchingCandidateInput,
  vocabulary: MatchingVocabulary,
  state: CandidateInterpretationState | undefined,
  asOf: number,
): {
  proofs: Evidence[];
  issue?: MatchingReason;
  coverageIssues?: NormalizedCandidateCoverageIssue[];
} {
  const incomplete = (status: 'pending' | 'failed' | 'partial') => ({
    proofs: [],
    issue: reason(
      `candidate-interpretation-${status}`,
      'unknown',
      {
        pending: 'Some candidate evidence is still waiting to be interpreted.',
        failed: 'Matching could not interpret some candidate evidence.',
        partial:
          'Matching could only interpret part of the candidate evidence.',
      }[status],
    ),
  });
  if (!state) return { proofs: [] };
  if (state.state === 'pending' || !state.interpretation)
    return incomplete(state.state === 'pending' ? 'pending' : 'failed');
  try {
    const interpretation = parseCandidateInterpretation(
      state.interpretation,
      input,
      vocabulary,
      asOf,
    );
    const records = new Map(
      input.evidence.map((item) => [
        item.id,
        { item, digest: candidateEvidenceDigest(item) },
      ]),
    );
    const positions = candidateEvidencePositions(input.evidence);
    const coverageIssues = interpretation.sourceCoverage?.flatMap(
      ({ sourceId, issues }) => {
        const record = records.get(sourceId);
        if (!record) return [];
        const { item, digest } = record;
        return issues.map(({ kind, conceptId, quote }) => {
          const start = quote === null ? -1 : item.text.indexOf(quote);
          return {
            kind,
            concepts: conceptId
              ? [
                  conceptId,
                  ...(vocabulary.broader.get(conceptId) ?? []),
                  ...(kind === 'unassessed-restriction'
                    ? (vocabulary.narrower.get(conceptId) ?? [])
                    : []),
                ]
              : undefined,
            citation:
              quote !== null && start >= 0
                ? {
                    ...cite(
                      'evidence',
                      item.text,
                      start,
                      start + quote.length,
                      sourceId,
                    ),
                    evidenceDigest: digest,
                  }
                : undefined,
          };
        });
      },
    );
    const restrictionsUnassessed =
      coverageIssues?.some(({ kind }) => kind !== 'omitted-positive') ??
      (state.state === 'partial' ||
        interpretation.unresolvedSourceIds.length > 0);
    const issue =
      state.state === 'failed'
        ? incomplete('failed').issue
        : restrictionsUnassessed
          ? incomplete('partial').issue
          : undefined;
    return {
      coverageIssues,
      issue,
      proofs: interpretation.assertions.flatMap((claim) => {
        const record = records.get(claim.sourceId);
        if (!record) return [];
        const { item, digest } = record;
        const positionRecord = positions.get(item.activityId ?? item.id);
        const position =
          positionRecord?.position ??
          (item.activityId ? item.activityPosition : undefined);
        const tenure = claim.duration?.entirePosition
          ? positionRecord
          : undefined;
        const interval =
          claim.period ??
          (claim.duration?.entirePosition ? position : undefined);
        const start = item.text.indexOf(claim.quote);
        const activityStart = claim.activityQuote
          ? item.text.indexOf(claim.activityQuote)
          : undefined;
        const citation = {
          ...cite(
            'evidence',
            item.text,
            start,
            start + claim.quote.length,
            item.id,
          ),
          evidenceDigest: digest,
        };
        // Keep production as the primary context while preserving an explicit
        // professional qualifier on a declaration about this same capability.
        const professionalDeclaration =
          claim.support === 'stated' && claim.context === 'production'
            ? qualification(
                phrase(claim.quote)
                  .replace(/^(?:i )?have\s+/u, '')
                  .replace(/ in production[.]?$/u, ''),
                vocabulary,
              )
            : undefined;
        const professional =
          (claim.support === 'action' &&
            claim.context === 'production' &&
            ((claim.duration?.entirePosition && position) ||
              /^(?:in|during|through|as part of) (?:my )?(?:paid work|employment|professional work)\b/iu.test(
                claim.quote,
              ) ||
              // Explicit action on an employer's production system can
              // establish employment context without a linked position.
              /^I (?:built|deployed|developed|maintained|migrated|operated|ran) my employer['’]s (?:live|production) (?:[\p{L}\p{N}._-]+ ){0,4}(?:application|backend|database|infrastructure|platform|service|system)(?: from \d{4}(?:-\d{2}){0,2} (?:to|through|until) (?:\d{4}(?:-\d{2}){0,2}|present))?\.?$/iu.test(
                claim.quote,
              ))) ||
          (professionalDeclaration?.context === 'professional' &&
            professionalDeclaration.slug === claim.conceptId);
        return [
          {
            slug: claim.conceptId,
            citation,
            polarity:
              claim.duration?.maximumYears != null &&
              !claim.duration.minimumYears
                ? 'upper-bound'
                : claim.polarity,
            years: claim.duration?.minimumYears ?? undefined,
            maximumYears: claim.duration?.maximumYears ?? undefined,
            positionCitation: tenure
              ? cite('evidence', tenure.text, 0, tenure.text.length, tenure.id)
              : undefined,
            actionTechnologies:
              claim.support === 'action'
                ? candidateActionTechnologies(claim.quote, vocabulary)
                : undefined,
            context: claim.context ?? undefined,
            support: claim.support,
            projectActivityId: item.projectActivityId,
            activityAnchor:
              activityStart !== undefined && claim.activityQuote
                ? {
                    start: activityStart,
                    end: activityStart + claim.activityQuote.length,
                  }
                : undefined,
            professional: professional ? true : undefined,
            ongoing:
              claim.polarity === 'positive' &&
              interval &&
              candidatePeriodIsOngoing(interval.end)
                ? true
                : undefined,
            period: interval
              ? conservativeExperiencePeriod(interval.start, interval.end, asOf)
              : undefined,
          },
        ];
      }),
    };
  } catch {
    return incomplete('failed');
  }
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
  interpretation?: CandidateInterpretationState,
  asOf = Date.now(),
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
  const unknownRoles: Citation[] = [];
  const roles = raw.targetRoles.flatMap((text) => {
    const citation = cite('target-role', text);
    const role = normalizeTargetRole(text, citation);
    if (!role) unknownRoles.push(citation);
    return role ? [role] : [];
  });
  const rolePreferenceStatus = unknownRoles.length
    ? roles.length
      ? 'partial'
      : 'unsupported'
    : undefined;
  if (!raw.targetRoles.length)
    uncertainties.push(
      reason(
        'candidate-role-missing',
        'unknown',
        'Add a target role in Matching preferences.',
      ),
    );
  if (unknownRoles.length)
    uncertainties.push(
      reason(
        'candidate-role-choice-unknown',
        'unknown',
        'Edit unsupported target roles in Matching preferences. Enter each role or discipline on its own line.',
        ...unknownRoles,
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
  const interpreted = interpretedEvidence(
    raw,
    vocabulary,
    interpretation,
    asOf,
  );
  const evidence = [
    ...interpreted.proofs,
    ...raw.evidence.flatMap((item) => normalizeEvidence(item, vocabulary)),
    ...datedRoleEvidence(raw.evidence, vocabulary, asOf),
  ].map((proof) => ({
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
  }));
  return {
    roles,
    rolePreferenceStatus,
    locations,
    remoteCountries,
    anywhere,
    unknownLocations,
    explicitRemoteCountries: Boolean(raw.remoteCountries?.length),
    unknownRemoteCountries,
    modes,
    evidence,
    interpretationIssue: interpreted.issue,
    coverageIssues: interpreted.coverageIssues,
    hasOngoingExperience: evidence.some(({ ongoing }) => ongoing)
      ? true
      : undefined,
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
    candidate.rolePreferenceStatus === 'partial'
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

type EvidenceFit = {
  outcome: MatchingReason['outcome'];
  citations: Citation[];
  disputed?: boolean;
  directPartial?: boolean;
  recognizedCapability?: boolean;
  recognizedAtoms?: readonly string[];
  gap?: CandidateEvidenceGap;
};

// These concepts can explain an evidence gap without implying the more
// specific requirement or changing screening and ranking eligibility.
const relatedCandidateEvidence = new Map([
  [
    'software-performance-tuning',
    {
      capabilities: ['software-performance-engineering'],
      explanation:
        'Your evidence shows software performance engineering. Matching has not verified a change tied to a measured software performance improvement.',
    },
  ],
  [
    'developer-experience-empathy',
    {
      capabilities: ['developer-experience-engineering', 'developer-tooling'],
      explanation:
        'Your evidence shows work on developer tools or workflows. Matching has not verified how you identified and responded to developer needs.',
    },
  ],
]);

function distinctCitations(citations: Citation[]) {
  const unique = new Map<string, Citation>();
  for (const citation of citations) {
    const key = JSON.stringify([
      citation.field,
      citation.id,
      citation.start,
      citation.end,
    ]);
    if (!unique.has(key)) unique.set(key, citation);
  }
  return [...unique.values()];
}

function matchesEvidenceContext(
  proof: Evidence,
  context: Qualification['context'],
) {
  return (
    !context ||
    proof.context === context ||
    (context === 'professional' && Boolean(proof.professional))
  );
}

function atomicEvidenceFit(
  requirement: Qualification,
  candidate: NormalizedMatchingCandidate,
): EvidenceFit {
  if (!requirement.slug) return { outcome: 'unknown', citations: [] };
  const positives: Citation[] = [];
  const observed: { period: ExperiencePeriod; citations: Citation[] }[] = [];
  const negatives: Citation[] = [];
  const partials: Citation[] = [];
  const durationLimits: Citation[] = [];
  const related: { slug: string; citation: Citation }[] = [];
  const relatedRule = relatedCandidateEvidence.get(requirement.slug);
  let direct = false;
  let recognizedCapability = false;
  let hasRequiredContext = false;
  let eligibleForDuration = false;
  let declaredYears: number | undefined;
  for (const proof of candidate.evidence) {
    const exact = proof.slug === requirement.slug;
    const scopedCapability = requirement.partialCapabilities?.includes(
      proof.slug,
    );
    const example =
      requirement.examples?.includes(proof.slug) || scopedCapability;
    const limitsScope = !proof.context || proof.context === requirement.context;
    const boundedBelowMinimum =
      proof.maximumYears !== undefined &&
      requirement.years !== undefined &&
      proof.maximumYears < requirement.years &&
      limitsScope;
    const citations = proof.positionCitation
      ? [proof.citation, proof.positionCitation]
      : [proof.citation];
    if (proof.satisfies.includes(requirement.slug)) {
      if (proof.support !== 'inferred') {
        recognizedCapability = true;
        hasRequiredContext ||= matchesEvidenceContext(
          proof,
          requirement.context,
        );
      }
      const qualifiesExceptContext =
        proof.support !== 'inferred' &&
        (!requirement.qualitative || proof.support === 'action') &&
        (!requirement.examples?.length ||
          (requirement.slug === 'observability' && proof.support === 'action'));
      const eligible =
        qualifiesExceptContext &&
        matchesEvidenceContext(proof, requirement.context);
      if (eligible) {
        eligibleForDuration = true;
        if (proof.years !== undefined)
          declaredYears = Math.max(declaredYears ?? 0, proof.years);
      }
      if (eligible && proof.period)
        observed.push({ period: proof.period, citations });
      if (
        eligible &&
        (!requirement.years ||
          (proof.years !== undefined && proof.years >= requirement.years))
      )
        positives.push(...citations);
      else partials.push(...citations);
    } else if (example && proof.polarity === 'positive') {
      partials.push(...citations);
      if (proof.support !== 'inferred') recognizedCapability = true;
    } else if (
      proof.polarity === 'positive' &&
      proof.support === 'action' &&
      proof.citation.evidenceDigest &&
      relatedRule?.capabilities.includes(proof.slug)
    ) {
      related.push({ slug: proof.slug, citation: proof.citation });
    }
    if (
      limitsScope &&
      (proof.rulesOut.includes(requirement.slug) ||
        requirement.partialCapabilities?.some((slug) =>
          proof.rulesOut.includes(slug),
        ))
    )
      negatives.push(...citations);
    if ((exact || scopedCapability) && boundedBelowMinimum)
      durationLimits.push(proof.citation);
    if (
      (exact || example) &&
      proof.polarity === 'positive' &&
      proof.support !== 'inferred'
    )
      direct = true;
  }
  const observedYears = observed.length
    ? minimumExperienceYears(observed.map(({ period }) => period))
    : undefined;
  if (requirement.years && (observedYears ?? 0) >= requirement.years)
    positives.push(...observed.flatMap(({ citations }) => citations));
  if (positives.length && !negatives.length && !durationLimits.length)
    return {
      outcome: 'supported',
      citations: distinctCitations(positives),
      recognizedCapability,
    };
  if (
    !positives.length &&
    (durationLimits.length || (negatives.length && !partials.length))
  )
    return {
      outcome: 'conflict',
      citations: distinctCitations([...negatives, ...durationLimits]),
    };
  const disputed = Boolean(negatives.length || durationLimits.length);
  let gap: CandidateEvidenceGap | undefined;
  if (!disputed && recognizedCapability) {
    if (requirement.years && eligibleForDuration) {
      gap = {
        conceptId: requirement.slug,
        missing: 'duration',
        requiredYears: requirement.years,
        observedYears:
          observedYears === undefined && declaredYears === undefined
            ? undefined
            : Math.max(observedYears ?? 0, declaredYears ?? 0),
      };
    } else if (requirement.context && !hasRequiredContext) {
      gap = {
        conceptId: requirement.slug,
        missing: 'context',
        context: requirement.context,
      };
    }
  }
  if (!gap && !disputed && related.length) {
    gap = {
      conceptId: requirement.slug,
      missing: 'related',
      relatedCapabilities: [...new Set(related.map(({ slug }) => slug))],
    };
  }
  return {
    outcome: 'unknown',
    citations: distinctCitations([
      ...positives,
      ...negatives,
      ...partials,
      ...durationLimits,
      ...related.map(({ citation }) => citation),
    ]),
    disputed,
    recognizedCapability,
    gap,
    directPartial: !disputed && direct,
  };
}

/** The observations counted for a compound are the time shared by every
 * condition. Union the resulting windows across activities afterward. */
function sharedExperience(
  left: readonly ExperiencePeriod[],
  right: readonly ExperiencePeriod[],
): ExperiencePeriod[] {
  // Intersect two already-unioned timelines without a cross product.
  const timeline = (periods: readonly ExperiencePeriod[]) => {
    const union: [number, number][] = [];
    for (const [start, end] of [...periods].sort(([a], [b]) => a - b)) {
      const previous = union.at(-1);
      if (previous && previous[1] >= start)
        previous[1] = Math.max(previous[1], end);
      else union.push([start, end]);
    }
    return union;
  };
  const a = timeline(left);
  const b = timeline(right);
  const shared: ExperiencePeriod[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [startA, endA] = a[i] as ExperiencePeriod;
    const [startB, endB] = b[j] as ExperiencePeriod;
    const start = Math.max(startA, startB);
    const end = Math.min(endA, endB);
    if (start < end) shared.push([start, end]);
    if (endA <= endB) i += 1;
    else j += 1;
  }
  return shared;
}

function sameEvidencePassage(left: Citation, right: Citation) {
  return (
    left.id === right.id && left.start < right.end && right.start < left.end
  );
}

function sameCandidateActivity(left: Citation, right: Citation) {
  return (
    left.id === right.id &&
    left.start === right.start &&
    left.end === right.end &&
    !/[;\r\n]|[.!?]\s+\S/u.test(left.text)
  );
}

function evidenceFit(
  requirement: Qualification,
  candidate: NormalizedMatchingCandidate,
): EvidenceFit {
  const conditions = candidateConditionGroups.get(requirement.slug);
  if (!conditions) return atomicEvidenceFit(requirement, candidate);
  const atoms = conditions.map((condition) => ({
    ...condition,
    context:
      condition.context ??
      (requirement.slug === 'postgresql-operational-tuning' ||
      requirement.slug === 'production-node-backend-engineering'
        ? undefined
        : requirement.context),
  }));
  const evaluatedAtoms = atoms.map((atom) => ({
    atom,
    fit: atomicEvidenceFit(
      {
        ...atom,
        years: requirement.years,
        qualitative: atom.independent,
      },
      candidate,
    ),
  }));
  const independent = evaluatedAtoms.filter(({ atom }) => atom.independent);
  const independentMissing = independent
    .filter(({ fit }) => fit.outcome !== 'supported')
    .map(({ atom }) => atom);
  const activityAtoms = atoms.filter(({ independent }) => !independent);
  const individual = [
    atomicEvidenceFit(requirement, candidate),
    ...evaluatedAtoms.map(({ fit }) => fit),
  ];
  const conflicts = individual.filter(({ outcome }) => outcome === 'conflict');
  const disputed = individual.some((fit) => fit.disputed);
  const namedTechnology = atoms.find(
    ({ namedTechnology }) => namedTechnology,
  )?.slug;
  const activities = new Map<
    string,
    NormalizedMatchingCandidate['evidence'][number][]
  >();
  for (const proof of candidate.evidence) {
    const id = proof.projectActivityId
      ? `project:${proof.projectActivityId}`
      : proof.citation.id && `source:${proof.citation.id}`;
    if (
      id &&
      proof.support === 'action' &&
      (!namedTechnology ||
        proof.actionTechnologies?.includes(namedTechnology)) &&
      activityAtoms.some(
        ({ slug, context }) =>
          proof.satisfies.includes(slug) &&
          matchesEvidenceContext(proof, context),
      )
    ) {
      const members = activities.get(id) ?? [];
      members.push(proof);
      activities.set(id, members);
    }
  }
  let closest = activityAtoms;
  let supported = false;
  let declaredYears: number | undefined;
  const dated: ExperiencePeriod[] = [];
  const positiveCitations = independent.flatMap(({ fit }) =>
    fit.outcome === 'supported' ? fit.citations : [],
  );
  for (const members of activities.values()) {
    const matches = activityAtoms.map(({ slug, context }) =>
      members.filter(
        (proof) =>
          proof.satisfies.includes(slug) &&
          matchesEvidenceContext(proof, context),
      ),
    );
    // Distinct passages need a verified shared activity or project. A named
    // technology also needs overlapping passages tying the actions to that tool.
    const bundles =
      members[0]?.projectActivityId && !namedTechnology
        ? [matches]
        : (matches[0] ?? []).map((anchor) =>
            matches.map((proofs) =>
              proofs.filter((proof) =>
                namedTechnology
                  ? sameEvidencePassage(proof.citation, anchor.citation)
                  : sameCandidateActivity(proof.citation, anchor.citation),
              ),
            ),
          );
    if (!namedTechnology && !members[0]?.projectActivityId) {
      // A single verifier-approved scope must cover every exact action
      // citation. Never union overlapping anchors into a larger activity.
      const scopes = new Set<string>();
      for (const { activityAnchor, citation } of members) {
        if (!activityAnchor) continue;
        const { start, end } = activityAnchor;
        const scopeKey = JSON.stringify([citation.id, start, end]);
        if (scopes.has(scopeKey)) continue;
        scopes.add(scopeKey);
        bundles.push(
          matches.map((proofs) =>
            proofs.filter(
              ({ citation: proof }) =>
                proof.id === citation.id &&
                proof.start >= start &&
                proof.end <= end,
            ),
          ),
        );
      }
    }
    for (const bundle of bundles) {
      const missing = activityAtoms.filter(
        (_, index) => !bundle[index]?.length,
      );
      if (missing.length < closest.length) closest = missing;
      if (missing.length) continue;
      if (requirement.years) {
        const windows = bundle.map((proofs) =>
          proofs.flatMap(({ period }) => (period ? [period] : [])),
        );
        const intersection = windows.reduce(sharedExperience);
        dated.push(...intersection);
        // Without dates, a single cited duration must expressly cover every
        // condition. Separate declarations may overlap and are never summed.
        const declarations = (bundle[0] ?? []).filter(
          (anchor) =>
            anchor.years !== undefined &&
            bundle.every((proofs) =>
              proofs.some(
                (proof) =>
                  proof.years === anchor.years &&
                  proof.citation.id === anchor.citation.id &&
                  proof.citation.start === anchor.citation.start &&
                  proof.citation.end === anchor.citation.end,
              ),
            ),
        );
        for (const { years } of declarations)
          declaredYears = Math.max(declaredYears ?? 0, years ?? 0);
        if (!intersection.length && !declarations.length) continue;
      }
      supported = true;
      positiveCitations.push(
        ...bundle
          .flat()
          .flatMap(({ citation, positionCitation }) =>
            positionCitation ? [citation, positionCitation] : [citation],
          ),
      );
    }
    if (!bundles.length) {
      const missing = activityAtoms.filter(
        (_, index) => !matches[index]?.length,
      );
      if (missing.length < closest.length) closest = missing;
    }
  }
  const observedYears =
    dated.length || declaredYears !== undefined
      ? Math.max(
          dated.length ? minimumExperienceYears(dated) : 0,
          declaredYears ?? 0,
        )
      : undefined;
  const qualified =
    independentMissing.length === 0 &&
    (activityAtoms.length === 0 ||
      (supported &&
        (!requirement.years || (observedYears ?? 0) >= requirement.years)));
  const missing = [...independentMissing, ...closest];
  if (qualified && !conflicts.length && !disputed)
    return {
      outcome: 'supported',
      citations: distinctCitations(positiveCitations),
    };
  if (!qualified && conflicts.length && !disputed)
    return {
      outcome: 'conflict',
      citations: distinctCitations(
        conflicts.flatMap(({ citations }) => citations),
      ),
    };
  return {
    outcome: 'unknown',
    citations: distinctCitations([
      ...positiveCitations,
      ...individual.flatMap(({ citations }) => citations),
    ]),
    disputed: disputed || Boolean(conflicts.length),
    recognizedAtoms: evaluatedAtoms
      .filter(({ atom, fit }) =>
        atom.independent
          ? fit.outcome === 'supported'
          : fit.recognizedCapability,
      )
      .map(({ atom }) => atom.slug),
    directPartial:
      !disputed &&
      !conflicts.length &&
      individual.some(
        ({ outcome, directPartial }) =>
          outcome === 'supported' || directPartial,
      ),
    gap:
      disputed ||
      conflicts.length ||
      !individual.some(({ recognizedCapability }) => recognizedCapability)
        ? undefined
        : missing.length
          ? {
              conceptId: requirement.slug,
              missing: 'conditions',
              conditions: missing.map(({ slug, context, independent }) => ({
                conceptId: slug,
                context,
                independent,
              })),
            }
          : requirement.years
            ? {
                conceptId: requirement.slug,
                missing: 'duration',
                requiredYears: requirement.years,
                observedYears,
              }
            : undefined,
  };
}

function requirementCoverageIssues(
  requirement: Qualification,
  candidate: NormalizedMatchingCandidate,
) {
  const concepts = [
    requirement.slug,
    ...(candidateConditionGroups.get(requirement.slug) ?? []).map(
      ({ slug }) => slug,
    ),
    ...(requirement.partialCapabilities ?? []),
    ...(requirement.examples ?? []),
  ];
  return (candidate.coverageIssues ?? []).filter(
    (issue) =>
      !issue.concepts ||
      issue.concepts.some((concept) => concepts.includes(concept)),
  );
}

function coverageExplanations(
  issues: readonly NormalizedCandidateCoverageIssue[],
) {
  const kinds = new Set(issues.map(({ kind }) => kind));
  return [
    ...(kinds.has('omitted-positive')
      ? [
          'Matching found relevant evidence that it has not yet verified as support for this requirement.',
        ]
      : []),
    ...(kinds.has('unassessed-restriction')
      ? [
          'Matching has not finished checking a possible restriction on this requirement.',
        ]
      : []),
    ...(kinds.has('unread')
      ? ['Some candidate evidence has not been reviewed for this requirement.']
      : []),
  ];
}

function groupFit(
  group: Group,
  candidate: NormalizedMatchingCandidate,
  required: boolean,
): MatchingReason & { directPartial?: boolean } {
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
  if (supported && evaluated[supportedIndex]) {
    const issues = requirementCoverageIssues(supported, candidate).filter(
      ({ kind }) => kind !== 'omitted-positive',
    );
    return reason(
      `${kind}-capability`,
      'supported',
      [
        `Your evidence supports ${name(supported)}.`,
        ...coverageExplanations(issues),
      ].join(' '),
      group.citation,
      ...evaluated[supportedIndex].citations,
    );
  }
  const conflict = evaluated.every(({ outcome }) => outcome === 'conflict');
  const coverage = group.alternatives.map((atom) =>
    requirementCoverageIssues(atom, candidate),
  );
  const issues = coverage.flat();
  const evidenceGaps = evaluated.flatMap(({ gap }, index) =>
    gap && (gap.missing === 'related' || !coverage[index]?.length) ? [gap] : [],
  );
  const options = group.alternatives.map(name).join(' or ');
  if (group.alternatives.some(({ slug }) => !slug))
    return reason(
      `${kind}-capability-unsupported`,
      'unknown',
      `Matching does not recognize all of the capabilities in ${options}.`,
      group.citation,
      ...evaluated.flatMap(({ citations }) => citations),
    );
  if (!conflict && evaluated.some((fit) => 'disputed' in fit && fit.disputed))
    return reason(
      `${kind}-capability-disputed`,
      'unknown',
      `Your evidence is inconsistent about ${options}.`,
      group.citation,
      ...evaluated.flatMap(({ citations }) => citations),
    );
  const explanations = evaluated.flatMap(({ gap, recognizedAtoms }, index) => {
    const atom = group.alternatives[index];
    if (!gap || !atom || (gap.missing !== 'related' && coverage[index]?.length))
      return [];
    const capability = atom.label || atom.slug.replace(/-/gu, ' ');
    switch (gap.missing) {
      case 'related': {
        const relation = relatedCandidateEvidence.get(atom.slug);
        return relation ? [relation.explanation] : [];
      }
      case 'context':
        return [
          `Your evidence shows ${capability}. Matching still needs confirmation of ${name(atom)}.`,
        ];
      case 'conditions': {
        const recognized = recognizedAtoms?.map(
          (slug) => capabilityLabels.get(slug) ?? slug.replace(/-/gu, ' '),
        );
        const missing = [true, false].flatMap((independent) => {
          const conditions = gap.conditions
            .filter(
              (condition) => Boolean(condition.independent) === independent,
            )
            .map(
              ({ conceptId, context }) =>
                `${context ? `${context} ` : ''}${conceptId.replace(/-/gu, ' ')}`,
            );
          if (!conditions.length) return [];
          return [
            independent
              ? `Matching still needs evidence of ${conditions.join(', ')}.`
              : `Matching still needs evidence of ${conditions.join(', ')} from the same activity.`,
          ];
        });
        return [
          ...(recognized?.length
            ? [`Your evidence shows ${capabilityList.format(recognized)}.`]
            : []),
          ...missing,
          ...(atom.years ? [`The requirement is ${atom.years}+ years.`] : []),
        ];
      }
      case 'duration':
        return [
          gap.observedYears === undefined
            ? `Your evidence shows ${capability}, but dates do not establish the required ${gap.requiredYears}+ years.`
            : gap.observedYears === 0
              ? `Your dated evidence for ${capability} establishes less than one full year toward the required ${gap.requiredYears}+ years.`
              : `Your evidence establishes a lower bound of ${gap.observedYears} year${gap.observedYears === 1 ? '' : 's'} for ${capability}. The requirement is ${gap.requiredYears}+ years.`,
        ];
      default:
        return [];
    }
  });
  const opening = explanations.length
    ? explanations
    : evaluated.some(({ directPartial }) => directPartial)
      ? [
          `Your evidence provides partial support for ${options}. Matching still needs confirmation of the full requirement.`,
        ]
      : [
          issues.length ||
          (candidate.interpretationIssue &&
            (!candidate.coverageIssues ||
              candidate.interpretationIssue.code ===
                'candidate-interpretation-failed'))
            ? `Matching has not yet verified ${options} from your evidence.`
            : `Your evidence does not establish ${options}.`,
        ];
  return {
    ...reason(
      `${kind}-capability`,
      conflict ? 'conflict' : 'unknown',
      conflict
        ? `Your evidence rules out ${options}.`
        : [...opening, ...coverageExplanations(issues)].join(' '),
      group.citation,
      ...distinctCitations([
        ...(!conflict
          ? issues.flatMap(({ citation }) => (citation ? [citation] : []))
          : []),
        ...evaluated.flatMap(({ citations }) => citations),
      ]),
    ),
    ...(evidenceGaps.length ? { evidenceGaps } : {}),
    directPartial: evaluated.some(
      (fit) => 'directPartial' in fit && fit.directPartial,
    ),
  };
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
      ({ code }) =>
        code !== 'candidate-role-choice-unknown' ||
        candidate.rolePreferenceStatus === 'unsupported',
    ),
  ];
  if (posting.role) hard.push(candidateRole(posting.role, candidate));
  if (posting.geography)
    hard.push(...candidateGeography(posting.geography, candidate));
  const interpretationGap = posting.required.length
    ? candidate.interpretationIssue
    : undefined;
  if (interpretationGap) hard.push(interpretationGap);
  let supportedRequirements = 0;
  let partialRequirements = 0;
  for (const group of posting.required) {
    const { directPartial, ...fit } = groupFit(group, candidate, true);
    if (fit.outcome === 'supported') supportedRequirements += 1;
    else if (directPartial) partialRequirements += 1;
    hard.push(fit);
  }
  for (const question of candidate.questions)
    hard.push(evaluateQuestion(question, posting));
  const soft = [
    ...posting.preferred.map((group) => {
      const { directPartial: _directPartial, ...fit } = groupFit(
        group,
        candidate,
        false,
      );
      return fit;
    }),
    ...posting.preferredUncertainties,
  ];
  const reasons = [...hard, ...soft];
  if (
    !interpretationGap &&
    candidate.interpretationIssue &&
    reasons.some(
      ({ code, outcome }) =>
        outcome === 'unknown' &&
        (code === 'required-capability' || code === 'preferred-capability'),
    )
  )
    reasons.push(candidate.interpretationIssue);
  if (hard.some(({ outcome }) => outcome === 'conflict'))
    return { status: 'conflict', score: 0, reasons };
  const gaps = hard.filter(({ outcome }) => outcome === 'unknown');
  if (gaps.length) {
    const screened =
      posting.uncertainties.length === 0 &&
      posting.geography?.mode !== undefined &&
      hard.some(
        ({ code, outcome }) =>
          code === 'target-role' && outcome === 'supported',
      ) &&
      hard.some(
        ({ code, outcome }) =>
          code === 'work-location' && outcome === 'supported',
      ) &&
      posting.required.every(({ alternatives }) =>
        alternatives.every(({ slug }) => Boolean(slug)),
      ) &&
      supportedRequirements + partialRequirements > 0 &&
      gaps.every(
        (gap) =>
          gap.code === 'required-capability' || gap === interpretationGap,
      );
    return screened
      ? {
          status: 'insufficient-evidence',
          screenedWithGaps: true,
          // A result with proven requirements ranks above every partial-only
          // result. Both score bands stay below fully qualified results.
          score: supportedRequirements
            ? 35 +
              Math.floor(
                (34 * (supportedRequirements + partialRequirements / 2)) /
                  posting.required.length,
              )
            : Math.max(
                1,
                Math.floor(
                  (34 * partialRequirements) / posting.required.length,
                ),
              ),
          reasons,
        }
      : { status: 'insufficient-evidence', score: 0, reasons };
  }

  // Rank qualified results by preferences. Preference coverage outweighs retrieval-only
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
