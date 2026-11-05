import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conservativeExperiencePeriod } from './matching-experience-dates.js';
import type {
  MatchingCandidateInput,
  MatchingVocabulary,
} from './normalized-matching.js';

export const CANDIDATE_INTERPRETATION_VERSION = 'candidate-interpretation/v4';
export const CANDIDATE_INTERPRETATION_PROMPT_VERSION =
  'matching-candidate-prompt/v14';
// Candidate interpretation and deterministic matching have separate change
// lifecycles. A ranking or posting fix can reuse existing paid candidate work.
export const CANDIDATE_INTERPRETATION_POLICY_VERSION = `normalized-v18:${CANDIDATE_INTERPRETATION_VERSION}:${CANDIDATE_INTERPRETATION_PROMPT_VERSION}`;

const sourceId = z.string().min(1).max(256);
const dateLabel = z.string().min(4).max(32);
const yearsBound = z.number().int().min(0).max(99).nullable();
const assertionSchema = z.strictObject({
  sourceId,
  conceptId: z.string().min(1).max(120),
  quote: z.string().min(1).max(800),
  activityQuote: z.string().min(1).max(800).nullable(),
  support: z.enum(['action', 'stated', 'inferred']),
  context: z.enum(['production', 'professional']).nullable(),
  polarity: z.enum(['positive', 'negative']),
  period: z.strictObject({ start: dateLabel, end: dateLabel }).nullable(),
  duration: z
    .strictObject({
      minimumYears: yearsBound,
      maximumYears: yearsBound,
      entirePosition: z.boolean(),
    })
    .nullable(),
});

const conceptId = z.string().min(1).max(120);

export const candidateCoverageIssueSchema = z.strictObject({
  kind: z.enum(['omitted-positive', 'unassessed-restriction', 'unread']),
  conceptId: conceptId.nullable(),
  quote: z.string().min(1).max(800).nullable(),
});

export const MAX_CANDIDATE_SOURCE_ISSUES = 16;

const candidateSourceCoverageSchema = z.strictObject({
  sourceId,
  issues: z
    .array(candidateCoverageIssueSchema)
    .max(MAX_CANDIDATE_SOURCE_ISSUES),
});

export type CandidateCoverageIssue = z.infer<
  typeof candidateCoverageIssueSchema
>;

export const candidateInterpretationSchema = z.strictObject({
  assertions: z.array(assertionSchema).max(2048),
  reviewedSourceIds: z.array(sourceId).max(512),
  unresolvedSourceIds: z.array(sourceId).max(512),
  sourceCoverage: z.array(candidateSourceCoverageSchema).max(512).optional(),
});

export type CandidateInterpretation = z.infer<
  typeof candidateInterpretationSchema
>;

export type CandidateInterpretationState =
  | { state: 'complete'; interpretation: CandidateInterpretation }
  | { state: 'partial'; interpretation: CandidateInterpretation }
  | { state: 'pending' }
  | { state: 'failed'; interpretation?: CandidateInterpretation };

// These candidate operations refine existing compound posting conditions. They
// do not become posting vocabulary or persist new candidate skill terms.
const candidateConditionTerms = [
  {
    slug: 'service-deployment',
    label: 'Service deployment',
    definition: 'Deploying application services and managing their rollout.',
  },
  {
    slug: 'service-monitoring',
    label: 'Service monitoring',
    definition: 'Monitoring the state and performance of running services.',
  },
  {
    slug: 'service-scaling',
    label: 'Service scaling',
    definition:
      'Increasing the capacity of application services to handle load.',
  },
  {
    slug: 'system-scalability',
    label: 'System scalability',
    definition: 'Designing or operating systems to handle substantial growth.',
  },
  {
    slug: 'database-performance-tuning',
    label: 'Database performance tuning',
    definition:
      'Changing queries, indexes, schema or configuration to improve database performance.',
  },
  {
    slug: 'database-troubleshooting',
    label: 'Database troubleshooting',
    definition: 'Diagnosing and addressing database faults or regressions.',
  },
] as const;
const conditionConceptIds = new Set<string>(
  candidateConditionTerms.map(({ slug }) => slug),
);

interface Condition {
  slug: string;
  context?: 'production' | 'professional';
  namedTechnology?: true;
  independent?: true;
}

/** Compatibility for existing posting concepts. Evaluate their atoms in one
 * candidate activity, retaining each condition and its own context. */
export const candidateConditionGroups: ReadonlyMap<
  string,
  readonly Condition[]
> = new Map([
  [
    'production-node-backend-engineering',
    [
      { slug: 'backend-development' },
      { slug: 'nodejs', context: 'production', namedTechnology: true },
    ],
  ],
  [
    'postgresql-operational-tuning',
    [
      { slug: 'postgresql', context: 'production', namedTechnology: true },
      { slug: 'database-performance-tuning' },
      { slug: 'database-troubleshooting' },
    ],
  ],
  [
    'cross-stack-service-operations',
    [
      { slug: 'backend-development', independent: true },
      { slug: 'service-deployment', independent: true },
      { slug: 'service-monitoring', independent: true },
      { slug: 'service-scaling', independent: true },
    ],
  ],
  [
    'scalable-full-stack-web-development',
    [
      { slug: 'full-stack-development' },
      { slug: 'scalable-web-application-development' },
    ],
  ],
  [
    'highly-scalable-distributed-systems',
    [{ slug: 'distributed-systems' }, { slug: 'system-scalability' }],
  ],
]);

function isCandidateConcept(conceptId: string, vocabulary: MatchingVocabulary) {
  return (
    (vocabulary.labels.has(conceptId) || conditionConceptIds.has(conceptId)) &&
    !candidateConditionGroups.has(conceptId) &&
    !conceptId.startsWith('role-tool-')
  );
}

export function candidateInterpretationConcepts(
  vocabulary: MatchingVocabulary,
) {
  const concepts = new Map(
    [...vocabulary.labels]
      .filter(([conceptId]) => isCandidateConcept(conceptId, vocabulary))
      .map(
        ([conceptId, label]) =>
          [
            conceptId,
            {
              conceptId,
              label,
              definition:
                vocabulary.definitions.get(conceptId) ??
                (conceptId === 'observability'
                  ? 'Using instrumentation or observability tooling to understand the behavior of running systems.'
                  : undefined),
            },
          ] as const,
      ),
  );
  for (const { slug, label, definition } of candidateConditionTerms)
    concepts.set(slug, { conceptId: slug, label, definition });
  return [...concepts.values()];
}

type EvidenceRecord = MatchingCandidateInput['evidence'][number];

export function candidateEvidenceDigest(source: EvidenceRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        source.id,
        source.text,
        source.kind,
        source.activityId,
        source.activityPosition?.role,
        source.activityPosition?.start,
        source.activityPosition?.end,
        source.projectActivityId,
        source.position?.role,
        source.position?.start,
        source.position?.end,
      ]),
    )
    .digest('hex');
}

function fail(): never {
  throw new Error('Candidate evidence interpretation failed validation.');
}

const productionContext =
  /\b(?:production|live (?:[\p{L}\p{N}._-]+ ){0,3}(?:environments?|systems?|services?|backends?|traffic|customers?|users?)|(?:real|paying) (?:customers?|users?)|customer-facing|on-call)\b/iu;
const professionalContext = /\b(?:professional|employment|paid work)\b/iu;

export function candidateQuoteShowsProfessionalWork(quote: string) {
  return professionalContext.test(quote);
}

function normalized(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function candidatePeriodIsOngoing(end: string) {
  return /^(?:present|current|ongoing)$/iu.test(end.trim());
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const namedTechnologyIds = new Set(
  [...candidateConditionGroups.values()].flatMap((conditions) =>
    conditions.flatMap(({ slug, namedTechnology }) =>
      namedTechnology ? [slug] : [],
    ),
  ),
);

function namesTechnology(
  quote: string,
  concept: string,
  vocabulary: MatchingVocabulary,
) {
  if (
    concept === 'nodejs' &&
    /\bNode (?:backends?|runtime|services?|servers?|applications?)\b/u.test(
      quote,
    )
  )
    return true;
  for (const [alias, slug] of vocabulary.aliases)
    if (
      slug === concept &&
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escapePattern(alias)}(?![\\p{L}\\p{N}])`,
        'iu',
      ).test(quote)
    )
      return true;
  return false;
}

export function candidateActionTechnologies(
  quote: string,
  vocabulary: MatchingVocabulary,
) {
  // A sentence spanning multiple technology scopes cannot attribute a
  // supporting action to one tool. The interpreter can cite a narrower span.
  if (/[;\r\n]|[.!?]\s+\S/u.test(quote)) return [];
  return [...namedTechnologyIds].filter(
    (concept) =>
      namesTechnology(quote, concept, vocabulary) &&
      !(concept === 'nodejs'
        ? /\b(?:Java|Kotlin|Python|Ruby|Rust|Golang|Go|PHP|ASP\.NET|CLI|command[- ]line)\b/u.test(
            quote,
          )
        : /\b(?:MySQL|MariaDB|Redis|SQLite|MongoDB|SQL Server|Oracle|Cassandra|DynamoDB)\b/iu.test(
            quote,
          )),
  );
}

function explicitDateRange(quote: string, start: string, end: string) {
  const delimiter = '(?:\\s*[-–—]\\s*|\\s+(?:to|through|until)\\s+)';
  return new RegExp(
    `(?<![\\p{L}\\p{N}-])${escapePattern(start)}${delimiter}${escapePattern(end)}(?![\\p{L}\\p{N}-])`,
    'iu',
  ).test(quote);
}

const units = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const decades = [
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
const countWords = new Map(units.map((word, years) => [word, years]));
for (const [index, decade] of decades.entries()) {
  const base = (index + 2) * 10;
  countWords.set(decade, base);
  for (const [unit, word] of units.slice(1, 10).entries())
    countWords.set(`${decade} ${word}`, base + unit + 1);
}
const yearNumber = `\\d{1,2}|(?:${decades.join('|')})(?:[- ](?:${units.slice(1, 10).join('|')}))?|(?:${units.join('|')})`;
const yearCount = new RegExp(
  `(?<![\\p{L}\\p{N}.+-])(?:(?<modifier>at most|at least|only|exactly|up to|limited to|more than|over|less than|fewer than|under|about|around|approximately|nearly)\\s+)?(?<count>${yearNumber})(?<plus>\\+)?\\s+years?\\b`,
  'giu',
);
const yearRangePrefix = new RegExp(
  `(?:\\b(?:${yearNumber})\\s+(?:to|or|and)\\s+|[-–—]\\s*)$`,
  'iu',
);

const explicitTotalDuration = new RegExp(
  `^\\s*my total (?<capability>[^!?;\\r\\n]{1,100}?) experience (?:is|was) (?:limited to\\b|(?:at most|up to|only|exactly)\\s+(?:${yearNumber})\\s+years?\\.?\\s*$)`,
  'iu',
);

function declaredDurationBounds(quote: string) {
  const [match, additional] = [...quote.matchAll(yearCount)];
  const count = match?.groups?.count?.toLowerCase().replace('-', ' ');
  if (
    !count ||
    additional ||
    yearRangePrefix.test(quote.slice(0, match?.index))
  )
    return undefined;
  const years = /^\d+$/u.test(count) ? Number(count) : countWords.get(count);
  if (years === undefined || years > 80) return undefined;
  const modifier = match?.groups?.modifier?.toLowerCase();
  if (
    modifier &&
    [
      'less than',
      'fewer than',
      'under',
      'about',
      'around',
      'approximately',
      'nearly',
    ].includes(modifier)
  )
    return undefined;
  const maximumOnly =
    modifier === 'at most' || modifier === 'up to' || modifier === 'limited to';
  const totalBound =
    /^\s*(?:i\s+)?(?:have|have had|have accumulated)\s+(?:at most|up to|only|exactly)\b/iu.test(
      quote,
    ) || explicitTotalDuration.test(quote);
  const exactBound =
    totalBound && (modifier === 'only' || modifier === 'exactly');
  if ((maximumOnly || exactBound) && match?.groups?.plus) return undefined;
  // An activity-local limit does not cap the candidate's total experience.
  if (maximumOnly && !totalBound) return undefined;
  return {
    minimumYears: maximumOnly ? null : years,
    maximumYears: maximumOnly || exactBound ? years : null,
  };
}

function matchesDeclaredDuration(
  quote: string,
  duration: NonNullable<
    CandidateInterpretation['assertions'][number]['duration']
  >,
) {
  const bounds = declaredDurationBounds(quote);
  return Boolean(
    bounds &&
      bounds.minimumYears === duration.minimumYears &&
      bounds.maximumYears === duration.maximumYears,
  );
}

/** Direct total-limit declarations remain enforceable even if a model
 * leaves the surrounding record unresolved. Activity-local limits do not. */
export function candidateTotalDurationLimit(
  quote: string,
  vocabulary: MatchingVocabulary,
) {
  const match = explicitTotalDuration.exec(quote);
  const capability = match?.groups?.capability;
  if (!capability) return;
  const slug = vocabulary.aliases.get(normalized(capability));
  const bounds = declaredDurationBounds(quote);
  if (slug && bounds?.maximumYears != null)
    return {
      slug,
      maximumYears: bounds.maximumYears,
      ...(bounds.minimumYears != null && { years: bounds.minimumYears }),
    };
}

type Position = NonNullable<EvidenceRecord['position']>;

export function candidateEvidencePositions(items: readonly EvidenceRecord[]) {
  const positions = new Map<
    string,
    (EvidenceRecord & { position: Position }) | null
  >();
  for (const item of items) {
    if (!item.position) continue;
    const id = item.activityId ?? item.id;
    positions.set(
      id,
      positions.has(id) ? null : { ...item, position: item.position },
    );
  }
  return positions;
}

const entireTenure =
  /\b(?:throughout (?:my|the|this|that) (?:entire |whole |full )?(?:tenure|employment|role|position|time (?:at|with|as))|for (?:my|the|this|that) (?:entire|whole|full) (?:tenure|employment|role|position|time (?:at|with|as)))\b/iu;

function hasScopedDenial(text: string, start: number, end: number) {
  const boundary = /[;\r\n]|[.!?](?=\s|$)/gu;
  const before = [...text.slice(0, start).matchAll(boundary)].at(-1);
  const tail = text.slice(end);
  const after = boundary.exec(tail);
  const clauseEnd =
    /[.!?]/u.test(text.charAt(end - 1)) && /^\s|^$/u.test(tail)
      ? end
      : after
        ? end + after.index
        : text.length;
  const clause = text.slice(
    before ? before.index + before[0].length : 0,
    clauseEnd,
  );
  return (
    productionContext.test(clause) ||
    professionalContext.test(clause) ||
    /\b(?:prod|professionally|at work|hobby|sandbox|lab|test environment)\b/iu.test(
      clause,
    )
  );
}

function explicitNamedTechnologyDenial(
  quote: string,
  conceptId: string,
  vocabulary: MatchingVocabulary,
) {
  const text = normalized(quote).replace(/[.!?]$/u, '');
  const denial =
    /^(?:i )?(?:have |had )?no (?:(?:professional|production|hands-on) )*(?:experience|knowledge) (?:with|in|of|using) (?<technology>.+)$/u.exec(
      text,
    ) ??
    /^(?:i )?(?:have )?never (?:used|worked with) (?<technology>.+)$/u.exec(
      text,
    );
  const technology = denial?.groups?.technology?.replace(
    /(?: in production| professionally| at work)$/u,
    '',
  );
  return (
    technology !== undefined && vocabulary.aliases.get(technology) === conceptId
  );
}

/** Validate provider claims against this exact bounded source set. Error
 * messages never contain private source content or model responses. */
export function parseCandidateInterpretation(
  raw: unknown,
  input: Pick<MatchingCandidateInput, 'evidence'>,
  vocabulary: MatchingVocabulary,
  asOf = Date.now(),
): CandidateInterpretation {
  const parsed = candidateInterpretationSchema.safeParse(raw);
  if (!parsed.success) fail();
  const { assertions, reviewedSourceIds, unresolvedSourceIds, sourceCoverage } =
    parsed.data;
  const sources = new Map(input.evidence.map((item) => [item.id, item]));
  const covered = [...reviewedSourceIds, ...unresolvedSourceIds];
  if (
    sources.size !== input.evidence.length ||
    covered.length !== sources.size ||
    new Set(covered).size !== sources.size ||
    covered.some((id) => !sources.has(id))
  )
    fail();
  if (sourceCoverage) {
    const unresolved = new Set(unresolvedSourceIds);
    if (
      sourceCoverage.length !== sources.size ||
      new Set(sourceCoverage.map(({ sourceId }) => sourceId)).size !==
        sources.size
    )
      fail();
    for (const { sourceId, issues } of sourceCoverage) {
      const source = sources.get(sourceId);
      const hasIssues = issues.length > 0;
      if (
        !source ||
        unresolved.has(sourceId) !== hasIssues ||
        new Set(issues.map((issue) => JSON.stringify(issue))).size !==
          issues.length
      )
        fail();
      for (const { kind, conceptId, quote } of issues) {
        if (
          (kind === 'unread' && (conceptId !== null || quote !== null)) ||
          (kind === 'omitted-positive' &&
            (conceptId === null || quote === null)) ||
          (conceptId !== null && !isCandidateConcept(conceptId, vocabulary))
        )
          fail();
        if (quote !== null) {
          const index = source.text.indexOf(quote);
          if (
            quote.trim() !== quote ||
            index < 0 ||
            index !== source.text.lastIndexOf(quote)
          )
            fail();
        }
      }
    }
  }
  const positions = candidateEvidencePositions(input.evidence);
  const seen = new Set<string>();
  for (const assertion of assertions) {
    const {
      sourceId,
      conceptId,
      quote,
      activityQuote,
      support,
      context,
      polarity,
      period,
      duration,
    } = assertion;
    const source = sources.get(sourceId);
    if (
      !source ||
      !isCandidateConcept(conceptId, vocabulary) ||
      (namedTechnologyIds.has(conceptId) &&
        !namesTechnology(quote, conceptId, vocabulary))
    )
      fail();
    const position =
      positions.get(source.activityId ?? source.id)?.position ??
      (source.activityId ? source.activityPosition : undefined);
    const start = source.text.indexOf(quote);
    const key = JSON.stringify([sourceId, conceptId, start, quote.length]);
    if (
      start < 0 ||
      quote.trim() !== quote ||
      start !== source.text.lastIndexOf(quote) ||
      seen.has(key)
    )
      fail();
    seen.add(key);

    if (activityQuote !== null) {
      const anchor = source.text.indexOf(activityQuote);
      if (
        support !== 'action' ||
        polarity !== 'positive' ||
        anchor < 0 ||
        activityQuote.trim() !== activityQuote ||
        anchor !== source.text.lastIndexOf(activityQuote) ||
        anchor > start ||
        anchor + activityQuote.length < start + quote.length
      )
        fail();
    }

    if (
      support === 'action' &&
      (source.kind === 'skill' ||
        polarity !== 'positive' ||
        normalized(source.position?.role ?? '') === normalized(quote) ||
        vocabulary.aliases.has(normalized(quote)))
    )
      fail();
    if (
      (context === 'production' &&
        (!productionContext.test(quote) ||
          /\b(?:non|pre)[- ]production\b|\b(?:outside|before) production\b/iu.test(
            quote,
          ))) ||
      (context === 'professional' &&
        !position &&
        !candidateQuoteShowsProfessionalWork(quote)) ||
      (support === 'inferred' && (polarity === 'negative' || period)) ||
      (polarity === 'negative' &&
        (period ||
          /\b(?:during|while at|from \d{4}|in \d{4})\b/iu.test(quote) ||
          !/\b(?:no|never|not|without|lack(?:s|ing)?)\b/iu.test(quote) ||
          (context === null &&
            hasScopedDenial(source.text, start, start + quote.length)) ||
          (namedTechnologyIds.has(conceptId) &&
            !explicitNamedTechnologyDenial(quote, conceptId, vocabulary))))
    )
      fail();
    if (duration) {
      if (period || support === 'inferred' || polarity !== 'positive') fail();
      if (duration.entirePosition) {
        if (
          support !== 'action' ||
          duration.minimumYears !== null ||
          duration.maximumYears !== null ||
          !entireTenure.test(quote) ||
          !position ||
          !conservativeExperiencePeriod(position.start, position.end, asOf)
        )
          fail();
      } else if (!matchesDeclaredDuration(quote, duration)) fail();
    }
    if (period) {
      // A role's date fields identify the role, not a particular activity's
      // duration. Require the interval within the cited assertion itself.
      if (
        !explicitDateRange(quote, period.start, period.end) ||
        !conservativeExperiencePeriod(period.start, period.end, asOf) ||
        (source.position &&
          quote.includes(`\n${source.position.start}\n${source.position.end}`))
      )
        fail();
    }
  }
  return parsed.data;
}
