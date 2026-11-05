import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type MatchingSourceSemanticProof,
  parseMatchingSourceSemanticProof,
} from './matching-source-semantics.js';
import { hasAnalysisPII } from './opportunity-analysis-source.js';

export const MATCHING_SOURCE_EXTRACTION_VERSION =
  'matching-source-extraction/v6';

const failureMessages = [
  [
    'matching_extraction_invalid_json',
    'Matching extraction returned invalid JSON.',
  ],
  [
    'matching_extraction_schema',
    'Matching extraction returned an invalid schema.',
  ],
  [
    'matching_extraction_citation',
    'Matching extraction has an invalid source citation.',
  ],
  [
    'matching_extraction_logic',
    'Matching extraction changed source requirement logic.',
  ],
  [
    'matching_extraction_qualification',
    'Matching extraction changed a source qualification.',
  ],
  [
    'matching_extraction_coverage',
    'Matching extraction does not establish requirement coverage.',
  ],
  [
    'matching_extraction_semantic_unit_set',
    'Matching extraction rejected a missing or duplicate source unit.',
  ],
  [
    'matching_extraction_semantic_predicate',
    'Matching extraction rejected a predicate without an eligible source unit.',
  ],
  [
    'matching_extraction_semantic_concept',
    'Matching extraction rejected a noncanonical concept or oversized predicate set.',
  ],
  [
    'matching_extraction_semantic_role',
    'Matching extraction rejected a noncanonical role claim.',
  ],
  [
    'matching_extraction_semantic_geography',
    'Matching extraction rejected a unsupported geography claim.',
  ],
  [
    'matching_extraction_semantic_digest',
    'Matching extraction rejected a mismatched proof identity.',
  ],
  [
    'matching_extraction_provider_failed',
    'Matching extraction provider failed.',
  ],
  [
    'matching_extraction_provider_incomplete',
    'Matching extraction provider output is incomplete.',
  ],
  [
    'matching_extraction_usage',
    'Matching extraction usage accounting is unavailable.',
  ],
] as const;

export type MatchingSourceExtractionErrorCode =
  (typeof failureMessages)[number][0];
const extractionFailures = new Map<string, string>(failureMessages);

export class MatchingSourceExtractionError extends Error {
  constructor(readonly code: MatchingSourceExtractionErrorCode) {
    super(extractionFailures.get(code));
    this.name = 'MatchingSourceExtractionError';
  }
}

export function isMatchingSourceExtractionErrorCode(
  code: unknown,
): code is MatchingSourceExtractionErrorCode {
  return typeof code === 'string' && extractionFailures.has(code);
}

type ValidationOptions = {
  repairProviderOutput?: boolean;
  onDiagnostic?: (code: MatchingSourceExtractionErrorCode) => void;
  onSchemaDiagnostic?: (issue: MatchingSourceExtractionSchemaIssue) => void;
};

const fields = z.enum(['title', 'description', 'location']);
type SourceField = z.infer<typeof fields>;
export type MatchingSourceText = Record<SourceField, string>;
export type MatchingSourceSpan = {
  field: SourceField;
  start: number;
  end: number;
  quote: string;
};

const span = z
  .object({
    field: fields,
    quote: z.string().min(1).max(800),
    start: z.number().int().nonnegative().nullable().optional(),
    end: z.number().int().positive().optional(),
  })
  .strict();

const atom = z
  .object({
    capability: span,
    years: z.number().int().min(1).max(80).nullable(),
    context: z.enum(['professional', 'production']).nullable(),
  })
  .strict();

const group = z
  .object({
    clause: span,
    alternatives: z.array(atom).min(1).max(8),
  })
  .strict();

const result = z
  .object({
    coverage: z.enum(['complete', 'partial']),
    role: span.nullable(),
    geography: span.nullable(),
    roleTitle: z.string().trim().min(1).max(150).nullable().optional(),
    workplaceType: z.enum(['remote', 'hybrid', 'onsite']).nullable().optional(),
    workLocation: z.string().trim().min(1).max(150).nullable().optional(),
    noRequirements: span.nullable(),
    required: z.array(group).max(60),
    preferred: z.array(group).max(30),
    unresolved: z.array(span).max(60),
    nonRequirements: z.array(span).max(60).optional(),
  })
  .strict();

// The gateway transport requires every property to be present. Nullable
// metadata and offsets explicitly represent unavailable source evidence.
const transportSpan = span.omit({ end: true }).extend({
  start: z.number().int().nonnegative().nullable(),
});
const transportGroup = group.extend({
  clause: transportSpan,
  alternatives: z
    .array(atom.extend({ capability: transportSpan }))
    .min(1)
    .max(8),
});
const transport = result.extend({
  role: transportSpan.nullable(),
  geography: transportSpan.nullable(),
  roleTitle: result.shape.roleTitle.unwrap(),
  workplaceType: result.shape.workplaceType.unwrap(),
  workLocation: result.shape.workLocation.unwrap(),
  noRequirements: transportSpan.nullable(),
  required: z.array(transportGroup).max(60),
  preferred: z.array(transportGroup).max(30),
  unresolved: z.array(transportSpan).max(60),
  nonRequirements: z.array(transportSpan).max(60),
});
const { $schema: _schema, ...transportJsonSchema } = z.toJSONSchema(transport);
export const matchingSourceExtractionResponseSchema = transportJsonSchema;

const schemaDiagnostic = z
  .object({
    field: z.enum([
      'response',
      'coverage',
      'role',
      'geography',
      'roleTitle',
      'workplaceType',
      'workLocation',
      'noRequirements',
      'required',
      'preferred',
      'unresolved',
      'nonRequirements',
    ]),
    issue: z.enum([
      'invalid_type',
      'invalid_value',
      'too_small',
      'too_big',
      'unrecognized_keys',
      'other',
    ]),
  })
  .strict();
export type MatchingSourceExtractionSchemaIssue = z.infer<
  typeof schemaDiagnostic
>;

export function isMatchingSourceExtractionSchemaIssue(
  value: unknown,
): value is MatchingSourceExtractionSchemaIssue {
  return schemaDiagnostic.safeParse(value).success;
}

const providerGroup = group.extend({
  alternatives: z
    .array(
      atom.extend({
        years: atom.shape.years.default(null),
        context: atom.shape.context.default(null),
      }),
    )
    .min(1)
    .max(8),
});

function sanitizeProviderResult(
  value: unknown,
  options: ValidationOptions,
): z.infer<typeof result> {
  const input = z.record(z.string(), z.unknown()).safeParse(value);
  if (!input.success) {
    options.onSchemaDiagnostic?.({ field: 'response', issue: 'invalid_type' });
    throw new MatchingSourceExtractionError('matching_extraction_schema');
  }
  const raw = input.data;
  let partial = false;
  const rejectedHardClauses: z.infer<typeof span>[] = [];
  function report(
    field: MatchingSourceExtractionSchemaIssue['field'],
    issue: unknown,
    hard: boolean,
  ) {
    partial ||= hard;
    options.onDiagnostic?.('matching_extraction_schema');
    const checked = schemaDiagnostic.safeParse({ field, issue });
    options.onSchemaDiagnostic?.(
      checked.success ? checked.data : { field, issue: 'other' },
    );
  }
  if (Object.keys(raw).some((key) => !Object.hasOwn(result.shape, key)))
    report('response', 'unrecognized_keys', false);

  function read<
    K extends Exclude<
      keyof typeof result.shape,
      'required' | 'preferred' | 'unresolved' | 'nonRequirements'
    >,
  >(field: K, hard = false): z.infer<(typeof result.shape)[K]> | undefined {
    if (raw[field] === undefined && !hard) return undefined;
    const parsed = result.shape[field].safeParse(raw[field]);
    if (parsed.success) return parsed.data as z.infer<(typeof result.shape)[K]>;
    report(field, parsed.error.issues[0]?.code, hard);
    return undefined;
  }

  function readArray<T extends z.ZodType>(
    field: 'required' | 'preferred' | 'unresolved' | 'nonRequirements',
    schema: T,
    limit: number,
    hard = false,
  ): z.infer<T>[] {
    const array = raw[field];
    if (array === undefined && !hard) return [];
    if (!Array.isArray(array)) {
      report(field, 'invalid_type', hard);
      return [];
    }
    if (array.length > limit) report(field, 'too_big', hard);
    return array.slice(0, limit).flatMap((entry: unknown) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      report(field, parsed.error.issues[0]?.code, hard);
      if (
        field === 'required' &&
        entry !== null &&
        typeof entry === 'object' &&
        'clause' in entry
      ) {
        const checked = span.safeParse(entry.clause);
        if (checked.success) rejectedHardClauses.push(checked.data);
      }
      return [];
    });
  }

  const coverage = read('coverage', true) ?? 'partial';
  const role = read('role') ?? null;
  const geography = read('geography') ?? null;
  const roleTitle = read('roleTitle');
  const workplaceType = read('workplaceType');
  const workLocation = read('workLocation');
  const noRequirements =
    raw.noRequirements === undefined
      ? null
      : (read('noRequirements', true) ?? null);
  const required = readArray('required', providerGroup, 60, true);
  const preferred = readArray('preferred', providerGroup, 30);
  const unresolved = readArray('unresolved', span, 60, true);
  const nonRequirements =
    raw.nonRequirements === undefined
      ? []
      : readArray('nonRequirements', span, 60, true);
  return {
    coverage: partial ? 'partial' : coverage,
    role,
    geography,
    roleTitle,
    workplaceType,
    workLocation,
    noRequirements,
    required,
    preferred,
    unresolved: [...unresolved, ...rejectedHardClauses].slice(0, 60),
    nonRequirements,
  };
}

type MatchingSourceGroup = {
  clause: MatchingSourceSpan;
  alternatives: {
    capability: MatchingSourceSpan;
    years: number | null;
    context: 'professional' | 'production' | null;
  }[];
};

export type MatchingSourceExtraction = {
  coverage: 'complete' | 'partial';
  role: MatchingSourceSpan | null;
  geography: MatchingSourceSpan | null;
  roleTitle?: string;
  workplaceType?: 'remote' | 'hybrid' | 'onsite';
  workLocation?: string;
  noRequirements: MatchingSourceSpan | null;
  required: MatchingSourceGroup[];
  preferred: MatchingSourceGroup[];
  unresolved: MatchingSourceSpan[];
  nonRequirements?: MatchingSourceSpan[];
  semantic?: MatchingSourceSemanticProof;
};

const duration = /\b(\d{1,2})\+?\s*years?\b/giu;
const qualificationContext = /\b(professional|production)\b/giu;
const explicitNoRequirements =
  /^(?:there (?:are|is) )?no (?:mandatory|required|minimum|hard) (?:skills|qualifications|requirements|experience)(?: (?:are|is) required)?[.!]?$/iu;
const explicitlyHard =
  /\b(?:must|required|mandatory|minimum|at least|only)\b/iu;
const explicitlyOptional =
  /\b(?:optional|preferred|nice to have|a plus|not required)\b/iu;
const disjunction = /\bor\b|\//iu;
const alternativeSeparator = /^\s*\)?\s*,?\s*(?:or\b|\/)\s*\(?\s*$/iu;
const conjunction = /\band\b|[&;]/iu;
const negation = /\b(?:no|not|never|without)\b/iu;

function groundSpan(
  source: MatchingSourceText,
  input: z.infer<typeof span>,
  repair = false,
): MatchingSourceSpan {
  const raw = source[input.field];
  const first = raw.indexOf(input.quote);
  const unique = first !== -1 && raw.indexOf(input.quote, first + 1) === -1;
  const start = repair && unique ? first : (input.start ?? first);
  const end = start + input.quote.length;
  if (
    !input.quote.trim() ||
    first === -1 ||
    (input.start == null && !unique) ||
    raw.slice(start, end) !== input.quote ||
    (input.end !== undefined && input.end !== end && !(repair && unique)) ||
    hasAnalysisPII(input.quote)
  )
    throw new MatchingSourceExtractionError('matching_extraction_citation');
  return { field: input.field, start, end, quote: input.quote };
}

function sourceClause(
  source: MatchingSourceText,
  input: z.infer<typeof span>,
  repair = false,
) {
  const grounded = groundSpan(source, input, repair);
  if (grounded.field !== 'description')
    throw new MatchingSourceExtractionError('matching_extraction_citation');
  return grounded;
}

// A provider may identify a section boundary false positive, but an
// independently visible condition always takes precedence.
const conditionLanguage =
  /\b(?:must|required|requirement|minimum|only|mandatory|at least|need|eligible|eligibility|visa|permit|residen[ct](?:e|y)?|ability|able|possess|hold|sponsor(?:ship)?|authori[sz](?:ed|ation)|clearance|citizenship|relocat(?:e|ion)|certif(?:ied|ication)|credential|licen[cs]e|degree|background check|years? of|experience|qualifications?|proficiency|weekends?|travel|on[- ]call|timezone|time zone|shift|working hours)\b/iu;
const dutiesOrEmployer =
  /^(?:(?:you (?:will|'ll)|your role|we (?:offer|provide|are|build|believe|value)|our (?:team|mission|company)|about (?:us|the company|our team)|equal opportunity)\b|(?:build|design|develop|maintain|deliver|collaborate|partner|implement|operate|support|improve|lead|create|contribute|monitor|test|document|troubleshoot|work with)\b)/iu;

function descriptionLineMask(description: string) {
  return description.replace(
    /<[^<>\n]+>/gu,
    (tag) =>
      (/^<\/?(?:p|li|div|h[1-6]|section|ul|ol|br)\b/iu.test(tag) ? '\n' : ' ') +
      ' '.repeat(tag.length - 1),
  );
}

function validateNonRequirement(
  source: MatchingSourceText,
  input: z.infer<typeof span>,
  lines: string,
  repair: boolean,
) {
  const grounded = sourceClause(source, input, repair);
  const lineStart =
    Math.max(
      lines.lastIndexOf('\n', grounded.start - 1),
      lines.lastIndexOf('\r', grounded.start - 1),
    ) + 1;
  const lineEnd = lines.slice(grounded.end).search(/[\r\n]/u);
  const value = grounded.quote.replace(/^\s*(?:[-*•]\s+)?/u, '').trim();
  const before = lines
    .slice(lineStart, grounded.start)
    .replace(/^[\s*•-]+$/u, '');
  const after =
    lineEnd < 0
      ? lines.slice(grounded.end)
      : lines.slice(grounded.end, grounded.end + lineEnd);
  if (
    before.trim() ||
    after.trim() ||
    /[\r\n]/u.test(grounded.quote) ||
    conditionLanguage.test(value) ||
    !dutiesOrEmployer.test(value)
  )
    throw new MatchingSourceExtractionError('matching_extraction_coverage');
  return grounded;
}

const workplaceEvidence = {
  remote: /\b(?:remote|work from home)\b/iu,
  hybrid: /\bhybrid\b/iu,
  onsite: /\b(?:on[ -]?site|in[ -]?office)\b/iu,
};

function validateGroup(
  source: MatchingSourceText,
  input: z.infer<typeof group>,
  required: boolean,
  repair: boolean,
): MatchingSourceGroup {
  const clause = sourceClause(source, input.clause, repair);
  const alternatives = input.alternatives
    .map((entry) => {
      const capability = sourceClause(source, entry.capability, repair);
      if (capability.start < clause.start || capability.end > clause.end)
        throw new MatchingSourceExtractionError('matching_extraction_citation');
      return { ...entry, capability };
    })
    .sort((a, b) => a.capability.start - b.capability.start);

  let previousEnd = clause.start;
  const connectors = alternatives.map(({ capability }) => {
    const connector = source.description.slice(previousEnd, capability.start);
    previousEnd = capability.end;
    return connector;
  });
  connectors.push(source.description.slice(previousEnd, clause.end));
  const internal = connectors.slice(1, -1);
  const outer = [connectors[0] ?? '', connectors.at(-1) ?? ''];
  // A comma-only series is ambiguous. In a disjunction, the final
  // connector must explicitly be OR and all earlier connectors must be OR
  // or list commas. A lone atom cannot erase a conjunct or an alternative.
  const hasValidAlternatives =
    internal.length === 0 ||
    (alternativeSeparator.test(internal.at(-1) ?? '') &&
      internal.every(
        (connector) =>
          alternativeSeparator.test(connector) || /^\s*,\s*$/u.test(connector),
      ));
  if (
    negation.test(clause.quote) ||
    (required && explicitlyOptional.test(clause.quote)) ||
    (!required && explicitlyHard.test(clause.quote)) ||
    connectors.some((connector) => conjunction.test(connector)) ||
    !hasValidAlternatives ||
    outer.some(
      (connector) => disjunction.test(connector) || connector.includes(','),
    ) ||
    connectors.some(
      (connector) => [...connector.matchAll(/\bor\b|\//giu)].length > 1,
    )
  )
    throw new MatchingSourceExtractionError('matching_extraction_logic');

  const supportedYears = [...clause.quote.matchAll(duration)].map((match) =>
    Number(match[1]),
  );
  const contexts = [...clause.quote.matchAll(qualificationContext)].map(
    (match) => match[1]?.toLowerCase(),
  );
  // A qualifier shared across an OR clause is safe only if every alternative
  // has the same qualifier. More complex scoping stays unresolved.
  if (
    /\b\d+\s*(?:[-–]|to)\s*\d+\+?\s*years?\b/iu.test(clause.quote) ||
    (alternatives.length > 1 &&
      [...internal, outer[1] ?? ''].some((connector) =>
        /\b(?:\d{1,2}\+?\s*years?|professional|production)\b/iu.test(connector),
      )) ||
    new Set(supportedYears).size > 1 ||
    new Set(contexts).size > 1 ||
    alternatives.some(
      ({ years, context }) =>
        years !== (supportedYears[0] ?? null) ||
        context !== (contexts[0] ?? null),
    )
  )
    throw new MatchingSourceExtractionError(
      'matching_extraction_qualification',
    );

  for (let i = 1; i < alternatives.length; i += 1) {
    const previous = alternatives[i - 1]?.capability;
    const next = alternatives[i]?.capability;
    if (!previous || !next || previous.end > next.start)
      throw new MatchingSourceExtractionError('matching_extraction_logic');
  }
  return { clause, alternatives };
}

function overlaps(
  left: MatchingSourceSpan,
  right: MatchingSourceSpan,
): boolean {
  return left.start < right.end && right.start < left.end;
}

function validatePersistedResult(value: unknown): z.infer<typeof result> {
  const checked = result.safeParse(value);
  if (!checked.success)
    throw new MatchingSourceExtractionError('matching_extraction_schema');
  return checked.data;
}

/** Provider responses may salvage independent claims. Persisted data is always
 * checked strictly, including the exact offsets produced by provider parsing. */
export function parseMatchingSourceExtraction(
  value: unknown,
  source: MatchingSourceText,
  options: ValidationOptions = {},
): MatchingSourceExtraction {
  const repair = options.repairProviderOutput === true;
  if (!repair && value && typeof value === 'object' && 'semantic' in value) {
    const { semantic, ...legacy } = value;
    try {
      const parsed = validatePersistedResult(legacy);
      if (
        parsed.coverage !== 'partial' ||
        parsed.role ||
        parsed.geography ||
        parsed.noRequirements ||
        parsed.roleTitle ||
        parsed.workplaceType ||
        parsed.workLocation ||
        parsed.required.length ||
        parsed.preferred.length ||
        parsed.unresolved.length ||
        parsed.nonRequirements?.length
      )
        throw new MatchingSourceExtractionError('matching_extraction_schema');
      return {
        coverage: 'partial',
        role: null,
        geography: null,
        noRequirements: null,
        required: [],
        preferred: [],
        unresolved: [],
        semantic: parseMatchingSourceSemanticProof(semantic, source),
      };
    } catch {
      throw new MatchingSourceExtractionError('matching_extraction_coverage');
    }
  }
  const parsed = repair
    ? sanitizeProviderResult(value, options)
    : validatePersistedResult(value);
  let coverage = parsed.coverage;
  function report(code: MatchingSourceExtractionErrorCode, hard: boolean) {
    if (!repair) throw new MatchingSourceExtractionError(code);
    if (hard) coverage = 'partial';
    options.onDiagnostic?.(code);
  }
  function accept<T>(fn: () => T, hard = false): T | null {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof MatchingSourceExtractionError)) throw error;
      report(error.code, hard);
      return null;
    }
  }
  function retain<T>(entries: readonly (T | null)[]): T[] {
    return entries.filter((entry): entry is T => entry !== null);
  }
  function validSpan(input: z.infer<typeof span> | null, field: SourceField) {
    return (
      input &&
      accept(() => {
        const grounded = groundSpan(source, input, repair);
        if (grounded.field === field)
          throw new MatchingSourceExtractionError(
            'matching_extraction_citation',
          );
        return grounded;
      })
    );
  }
  const unresolved = retain(
    parsed.unresolved.map((entry) =>
      accept(() => sourceClause(source, entry, repair), true),
    ),
  );
  function markUnresolved(input: z.infer<typeof span>) {
    if (unresolved.length >= 60) return;
    const cite = accept(() => sourceClause(source, input, repair), true);
    if (
      cite &&
      !unresolved.some(
        (other) => other.start === cite.start && other.end === cite.end,
      )
    )
      unresolved.push(cite);
  }
  const required = retain(
    parsed.required.map((entry) => {
      const validated = accept(
        () => validateGroup(source, entry, true, repair),
        true,
      );
      if (!validated) markUnresolved(entry.clause);
      return validated;
    }),
  );
  const preferred = retain(
    parsed.preferred.map((entry) =>
      accept(() => validateGroup(source, entry, false, repair)),
    ),
  );
  const lines = parsed.nonRequirements?.length
    ? descriptionLineMask(source.description)
    : '';
  const nonRequirements = retain(
    (parsed.nonRequirements ?? []).map((entry) =>
      accept(() => validateNonRequirement(source, entry, lines, repair), true),
    ),
  );
  const acceptedClauses: MatchingSourceSpan[] = [];
  function acceptClause(clause: MatchingSourceSpan, hard: boolean): boolean {
    if (acceptedClauses.some((existing) => overlaps(existing, clause))) {
      report('matching_extraction_logic', hard);
      return false;
    }
    acceptedClauses.push(clause);
    return true;
  }
  const keptRequired = required.filter(({ clause }) => {
    const kept = acceptClause(clause, true);
    if (!kept) markUnresolved(clause);
    return kept;
  });
  const keptPreferred = preferred.filter(({ clause }) =>
    acceptClause(clause, false),
  );
  const keptNonRequirements = nonRequirements.filter((line) => {
    if (unresolved.some((condition) => overlaps(condition, line))) {
      report('matching_extraction_coverage', true);
      return false;
    }
    return acceptClause(line, true);
  });
  const noRequirementsInput = parsed.noRequirements;
  const noRequirements =
    noRequirementsInput &&
    accept(() => {
      const grounded = sourceClause(source, noRequirementsInput, repair);
      if (
        keptRequired.length ||
        !explicitNoRequirements.test(grounded.quote.trim())
      )
        throw new MatchingSourceExtractionError('matching_extraction_coverage');
      return grounded;
    }, true);
  if (
    coverage === 'complete' &&
    (unresolved.length || (!keptRequired.length && !noRequirements))
  )
    report('matching_extraction_coverage', true);
  const role = validSpan(parsed.role, 'location');
  const geography = validSpan(parsed.geography, 'title');
  function metadata<T extends string>(
    value: T | null | undefined,
    valid: (value: T) => boolean,
  ): T | undefined {
    if (!value) return undefined;
    if (valid(value)) return value;
    report('matching_extraction_citation', false);
    return undefined;
  }
  const roleTitle = metadata(
    parsed.roleTitle,
    (value) => role?.quote.includes(value) === true,
  );
  const workLocation = metadata(
    parsed.workLocation,
    (value) => geography?.quote.includes(value) === true,
  );
  const workplaceType = metadata(
    parsed.workplaceType,
    (value) =>
      geography !== null && workplaceEvidence[value].test(geography.quote),
  );
  return {
    coverage,
    role,
    geography,
    ...(roleTitle && { roleTitle }),
    ...(workplaceType && { workplaceType }),
    ...(workLocation && { workLocation }),
    noRequirements,
    required: keptRequired,
    preferred: keptPreferred,
    unresolved,
    nonRequirements: keptNonRequirements,
  };
}

export function matchingSourceInputDigest(source: MatchingSourceText): string {
  return createHash('sha256')
    .update(JSON.stringify([source.title, source.description, source.location]))
    .digest('hex');
}
