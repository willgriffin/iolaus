import { createHash } from 'node:crypto';
import type { AIMessage } from '@happyvertical/ai';

export const OPPORTUNITY_PREPARED_POSTING_VERSION = 'prepared-posting/v1';
export const OPPORTUNITY_EXTRACTION_PROMPT_VERSION =
  'opportunity-extraction/v2';
export const OPPORTUNITY_EXTRACTION_SCHEMA_VERSION =
  'opportunity-extraction-output/v1';
export const OPPORTUNITY_EXTRACTION_MAX_CHUNKS = 3;
export const OPPORTUNITY_EXTRACTION_MAX_CALLS =
  OPPORTUNITY_EXTRACTION_MAX_CHUNKS;
export const OPPORTUNITY_INPUT_TOKEN_CEILING_DEFAULT = 6_000;
export const OPPORTUNITY_INPUT_TOKEN_CEILING_HARD_MAX = 12_000;
export const OPPORTUNITY_INPUT_MIN_CONTEXT_HEADROOM_RATIO = 0.2;

export type PreparedPostingSectionKind =
  | 'benefits'
  | 'compensation'
  | 'location'
  | 'qualifications'
  | 'responsibilities'
  | 'summary'
  | 'other';

export interface PreparedPostingEvidence {
  excerpt: string;
  sectionId: string;
  sourceLineEnd: number;
  sourceLineStart: number;
}

export interface PreparedPostingFact {
  evidence: PreparedPostingEvidence;
  field: string;
  method: string;
  value: boolean | number | string;
}

export interface PreparedPostingSection {
  heading: string;
  id: string;
  kind: PreparedPostingSectionKind;
  sourceLineEnd: number;
  sourceLineStart: number;
  text: string;
}

export interface PreparedPosting {
  facts: PreparedPostingFact[];
  fingerprint: string;
  provenance: {
    normalizedLineCount: number;
    removedBoilerplateCount: number;
    removedDuplicateCount: number;
    sourceContentFingerprint: string;
    sourceContentVersion: number;
  };
  sections: PreparedPostingSection[];
  source: {
    canonicalUrl: string;
    postingUrl: string;
    title: string;
  };
  version: typeof OPPORTUNITY_PREPARED_POSTING_VERSION;
}

export interface PreparedPostingChunk {
  chunkCount: number;
  chunkIndex: number;
  facts: PreparedPostingFact[];
  inputTokenCeiling: number;
  inputTokenCount: number;
  preparedFingerprint: string;
  preparedVersion: typeof OPPORTUNITY_PREPARED_POSTING_VERSION;
  sections: PreparedPostingSection[];
  source: PreparedPosting['source'];
}

export interface OpportunityExtractionMerge {
  conflicts: Array<{
    discardedChunkIndex: number;
    discardedValue: unknown;
    field: string;
    selectedChunkIndex: number | 'deterministic';
    selectedValue: unknown;
  }>;
  fieldProvenance: Record<
    string,
    Array<{ chunkIndex: number | 'deterministic'; sectionIds: string[] }>
  >;
  output: Record<string, unknown>;
}

const SECTION_PRIORITY: Record<PreparedPostingSectionKind, number> = {
  qualifications: 0,
  responsibilities: 1,
  compensation: 2,
  location: 3,
  summary: 4,
  benefits: 5,
  other: 6,
};

const BOILERPLATE_LINE =
  /^(?:apply now|back to (?:jobs|openings)|careers?|cookie (?:policy|settings)|home|jobs?|menu|navigation|next job|previous job|privacy policy|share (?:this )?(?:job|role)|sign in|skip to (?:content|main)|terms (?:and conditions|of (?:service|use)))\s*[→›»|·-]*$/i;

const HEADING_KIND: Array<
  [RegExp, Exclude<PreparedPostingSectionKind, 'summary' | 'other'>]
> = [
  [
    /\b(?:responsibilities|what you(?:'|’)ll do|the role|your impact)\b/i,
    'responsibilities',
  ],
  [
    /\b(?:qualifications|requirements|what you(?:'|’)ll bring|who you are|experience)\b/i,
    'qualifications',
  ],
  [/\b(?:compensation|salary|pay range|total rewards)\b/i, 'compensation'],
  [/\b(?:location|workplace|where you(?:'|’)ll work)\b/i, 'location'],
  [/\b(?:benefits|perks|what we offer)\b/i, 'benefits'],
];

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function decodeCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return '\uFFFD';
  }
  return String.fromCodePoint(codePoint);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (_match, decimal: string, hex: string, name: string) => {
      if (decimal) return decodeCodePoint(decimal, 10);
      if (hex) return decodeCodePoint(hex, 16);
      return named[name.toLowerCase()] ?? ' ';
    },
  );
}

function normalizedLines(value: unknown): string[] {
  const text = decodeEntities(stringValue(value))
    .replace(/<\/?(?:br|div|h[1-6]|li|p|section|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ');
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*[•*●▪◦‣-]\s+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

function lineKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9$%+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingKind(line: string): PreparedPostingSectionKind | null {
  const normalized = line
    .replace(/^[#>*\s]+/, '')
    .replace(/[\s:–—-]+$/, '')
    .trim();
  if (!normalized || normalized.length > 80) return null;
  const wordCount = normalized.split(/\s+/).length;
  const headingShape =
    /[:–—-]\s*$/.test(line) ||
    /^[A-Z][A-Z\s/&-]{3,}$/.test(normalized) ||
    (wordCount <= 4 && !/[.!?]\s*$/.test(line));
  if (!headingShape) return null;
  for (const [pattern, kind] of HEADING_KIND) {
    if (pattern.test(normalized)) return kind;
  }
  return null;
}

function sectionEvidence(
  section: PreparedPostingSection,
  excerpt: string,
): PreparedPostingEvidence {
  return {
    excerpt: excerpt.slice(0, 240),
    sectionId: section.id,
    sourceLineEnd: section.sourceLineEnd,
    sourceLineStart: section.sourceLineStart,
  };
}

function pushFact(
  facts: PreparedPostingFact[],
  seen: Set<string>,
  section: PreparedPostingSection,
  field: string,
  value: boolean | number | string,
  method: string,
  excerpt = section.text,
): void {
  const normalized = stringValue(value);
  if (!normalized || normalized.toLowerCase() === 'unknown') return;
  const key = `${field}:${normalized.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  facts.push({
    evidence: sectionEvidence(section, excerpt),
    field,
    method,
    value,
  });
}

function pushUnknownFact(
  facts: PreparedPostingFact[],
  seen: Set<string>,
  field: string,
  method: string,
  evidence: PreparedPostingEvidence,
): void {
  const key = `${field}:unknown`;
  if (seen.has(key)) return;
  seen.add(key);
  facts.push({
    evidence: { ...evidence, excerpt: evidence.excerpt.slice(0, 240) },
    field,
    method,
    value: 'unknown',
  });
}

function findSection(
  sections: PreparedPostingSection[],
  kind: PreparedPostingSectionKind,
): PreparedPostingSection {
  return (
    sections.find((section) => section.kind === kind) ??
    sections[0] ?? {
      heading: 'Summary',
      id: 'section-summary-1',
      kind: 'summary',
      sourceLineEnd: 1,
      sourceLineStart: 1,
      text: '',
    }
  );
}

function compensationFacts(
  sections: PreparedPostingSection[],
  facts: PreparedPostingFact[],
  seen: Set<string>,
): void {
  const section = findSection(sections, 'compensation');
  const text = sections.map((entry) => entry.text).join('\n');
  const range = text.match(
    /(?:(USD|CAD|EUR|GBP)\s*)?([$€£])?\s*(\d{2,3}(?:[,.]\d+)?)(k)?\s*(?:-|–|—|to)\s*(?:([$€£])?\s*)?(\d{2,3}(?:[,.]\d+)?)(k)?(?:\s*(?:per\s+)?(year|annum|hour|hr))?/i,
  );
  if (!range) return;
  const compensationNumber = (value: string, thousands: boolean): number => {
    if (thousands) return Number(value.replace(',', '.')) * 1_000;
    if (/[,.]\d{3}$/.test(value)) return Number(value.replace(/[,.]/g, ''));
    return Number(value.replace(',', '.'));
  };
  const minimum = compensationNumber(range[3], Boolean(range[4]));
  const maximum = compensationNumber(range[6], Boolean(range[7]));
  const hourly = /hour|hr/i.test(range[8] ?? '');
  const currencySymbol = range[2] || range[5];
  const currency =
    stringValue(range[1]).toUpperCase() ||
    (currencySymbol === '€'
      ? 'EUR'
      : currencySymbol === '£'
        ? 'GBP'
        : currencySymbol === '$'
          ? 'USD'
          : '');
  pushFact(
    facts,
    seen,
    section,
    hourly ? 'hourlyMin' : 'salaryMin',
    minimum,
    'compensation-range',
    range[0],
  );
  pushFact(
    facts,
    seen,
    section,
    hourly ? 'hourlyMax' : 'salaryMax',
    maximum,
    'compensation-range',
    range[0],
  );
  if (currency) {
    pushFact(
      facts,
      seen,
      section,
      'currency',
      currency,
      'currency-symbol-or-code',
      range[0],
    );
  }
}

function deterministicFacts(
  opportunity: Record<string, unknown>,
  sections: PreparedPostingSection[],
  sourceLines: Array<{ number: number; text: string }>,
): PreparedPostingFact[] {
  const facts: PreparedPostingFact[] = [];
  const seen = new Set<string>();
  const summary = findSection(sections, 'summary');
  const location = findSection(sections, 'location');
  const allText = sections
    .flatMap((section) => [section.heading, section.text])
    .filter(Boolean)
    .join('\n');
  const senioritySignals = [
    [/\bprincipal\b/i, 'principal'],
    [/\bstaff\b/i, 'staff'],
    [/\bfounding\b/i, 'founding'],
    [/\b(?:director|vp|vice president|chief)\b/i, 'exec'],
    [/\blead\b/i, 'lead'],
    [/\bsenior\b|\bsr\.?\b/i, 'senior'],
  ] as const;
  const matchSeniorities = (source: string) =>
    senioritySignals.flatMap(([pattern, value]) => {
      const match = source.match(pattern);
      return match
        ? [
            {
              end: (match.index ?? 0) + match[0].length,
              evidence: match[0],
              start: match.index ?? 0,
              value,
            },
          ]
        : [];
    });
  const titleSeniorities = matchSeniorities(stringValue(opportunity.title));
  const titleSenioritiesInSourceOrder = [...titleSeniorities].sort(
    (left, right) => left.start - right.start,
  );
  const titleSource = stringValue(opportunity.title);
  const hasAlternativeSeniorityRange = (
    source: string,
    matches: ReturnType<typeof matchSeniorities>,
  ) => {
    const matchesInSourceOrder = [...matches].sort(
      (left, right) => left.start - right.start,
    );
    return matchesInSourceOrder.some((left, index) => {
      const right = matchesInSourceOrder[index + 1];
      if (!right || left.value === right.value) return false;
      const betweenSignals = source.slice(left.end, right.start);
      return (
        /[/&|]/.test(betweenSignals) ||
        /\b(?:or|to)\b/i.test(betweenSignals) ||
        /(?:^|\s)[-–—](?:\s|$)/.test(betweenSignals)
      );
    });
  };
  const titleHasAmbiguousSeniority = hasAlternativeSeniorityRange(
    titleSource,
    titleSenioritiesInSourceOrder,
  );
  const hasRoleLevelingContext = (
    source: string,
    section: PreparedPostingSection | undefined,
  ) =>
    /\b(?:this|the)\s+(?:position|role)\s+(?:(?:may|can|will|could)\s+)?be\s+(?:(?:hired?|offered|calibrated|leveled?|levelled?|considered)\b|(?:one\s+of|at)\b|(?:principal|staff|founding|director|vp|vice president|chief|lead|senior|sr\.?)\b)/i.test(
      source,
    ) ||
    /\b(?:(?:the|a)\s+)?(?:successful\s+)?(?:candidate|applicant)s?\s+(?:(?:may|can|will|could)\s+)?be\s+(?:hired?|offered|calibrated|leveled?|levelled?|considered)\b/i.test(
      source,
    ) ||
    (section?.kind !== 'responsibilities' &&
      /^(?:we(?:'re| are)?|our\s+team\s+is)\s+(?:hiring|seeking)\s+(?:for\s+)?(?:a\s+)?/i.test(
        source,
      ));
  const sectionForSourceRange = (
    sourceLineStart: number,
    sourceLineEnd: number,
  ) =>
    sections.find(
      (section) =>
        section.sourceLineStart <= sourceLineStart &&
        section.sourceLineEnd >= sourceLineEnd,
    );
  const explicitBodyRange = sourceLines
    .flatMap((line, index) => {
      const candidates: Array<{
        sourceLineEnd: number;
        sourceLineStart: number;
        text: string;
      }> = [];
      for (let length = 1; length <= 3; length += 1) {
        const window = sourceLines.slice(index, index + length);
        if (
          window.length !== length ||
          window.some((entry, offset) => entry.number !== line.number + offset)
        ) {
          break;
        }
        candidates.push({
          sourceLineEnd: window.at(-1)?.number ?? line.number,
          sourceLineStart: line.number,
          text: window.map((entry) => entry.text).join('\n'),
        });
      }
      return candidates.map((candidate) => ({
        ...candidate,
        section: sectionForSourceRange(
          candidate.sourceLineStart,
          candidate.sourceLineEnd,
        ),
      }));
    })
    .filter(
      ({ section, text }) =>
        hasRoleLevelingContext(text, section) &&
        hasAlternativeSeniorityRange(text, matchSeniorities(text)),
    )
    .sort(
      (left, right) =>
        left.sourceLineEnd -
          left.sourceLineStart -
          (right.sourceLineEnd - right.sourceLineStart) ||
        left.sourceLineStart - right.sourceLineStart,
    )[0];
  const ambiguousSeniorityEvidence: PreparedPostingEvidence | undefined =
    titleHasAmbiguousSeniority
      ? {
          excerpt: titleSource,
          sectionId: 'source-field:title',
          sourceLineEnd: 0,
          sourceLineStart: 0,
        }
      : explicitBodyRange
        ? {
            excerpt: explicitBodyRange.text,
            sectionId: (explicitBodyRange.section ?? summary).id,
            sourceLineEnd: explicitBodyRange.sourceLineEnd,
            sourceLineStart: explicitBodyRange.sourceLineStart,
          }
        : undefined;

  for (const [field, value, method, section] of [
    [
      'sourceUrl',
      opportunity.postingUrl ?? opportunity.canonicalUrl,
      'source-field',
      summary,
    ],
    ['postedAt', opportunity.postedAt, 'source-field', summary],
    ['expiresAt', opportunity.expiresAt, 'source-field', summary],
    ['employmentType', opportunity.employmentType, 'source-field', summary],
    ['workMode', opportunity.workMode, 'source-field', location],
    ['locations', opportunity.locations, 'source-field', location],
    ['locationNotes', opportunity.locationNotes, 'source-field', location],
    [
      'seniority',
      ambiguousSeniorityEvidence ? undefined : opportunity.seniority,
      'source-field',
      summary,
    ],
    ['title', opportunity.title, 'source-field', summary],
    [
      'salaryMin',
      opportunity.salaryMin,
      'source-field',
      findSection(sections, 'compensation'),
    ],
    [
      'salaryMax',
      opportunity.salaryMax,
      'source-field',
      findSection(sections, 'compensation'),
    ],
    [
      'hourlyMin',
      opportunity.hourlyMin,
      'source-field',
      findSection(sections, 'compensation'),
    ],
    [
      'hourlyMax',
      opportunity.hourlyMax,
      'source-field',
      findSection(sections, 'compensation'),
    ],
    [
      'currency',
      opportunity.currency,
      'source-field',
      findSection(sections, 'compensation'),
    ],
  ] as Array<[string, unknown, string, PreparedPostingSection]>) {
    const text = stringValue(value);
    if (text) pushFact(facts, seen, section, field, text, method, text);
  }

  const employment = [
    [/\bfull[- ]time\b/i, 'full_time'],
    [/\b(?:contract|contractor|freelance)\b/i, 'contract'],
    [/\bfractional\b/i, 'fractional'],
    [/\badvisory\b/i, 'advisory'],
  ] as const;
  for (const [pattern, value] of employment) {
    const match = allText.match(pattern);
    if (match) {
      pushFact(
        facts,
        seen,
        summary,
        'employmentType',
        value,
        'employment-pattern',
        match[0],
      );
      break;
    }
  }

  const workMode = [
    [/\b(?:fully |100% )?remote\b/i, 'remote'],
    [/\bhybrid\b/i, 'hybrid'],
    [/\b(?:on[- ]?site|in[- ]office)\b/i, 'onsite'],
  ] as const;
  for (const [pattern, value] of workMode) {
    const match = allText.match(pattern);
    if (match) {
      pushFact(
        facts,
        seen,
        location,
        'workMode',
        value,
        'work-mode-pattern',
        match[0],
      );
      break;
    }
  }

  const locationMatch =
    allText.match(
      /\b(?:location|based in|work from)\s*[:–—-]\s*([^\n.;]{2,100})/i,
    ) ??
    allText.match(
      /\b(?:hybrid|on[- ]?site|remote)\s+(?:in|from)\s+([^\n.;]{2,100})/i,
    );
  if (locationMatch) {
    for (const field of ['locations', 'locationNotes']) {
      pushFact(
        facts,
        seen,
        location,
        field,
        locationMatch[1].trim(),
        'location-label',
        locationMatch[0],
      );
    }
  }

  for (const [field, pattern] of [
    ['postedAt', /\b(?:date posted|posted)\s*[:–—-]\s*([^\n.;]{4,40})/i],
    [
      'expiresAt',
      /\b(?:application deadline|apply by|closing date|expires?)\s*[:–—-]\s*([^\n.;]{4,40})/i,
    ],
  ] as const) {
    const match = allText.match(pattern);
    if (!match) continue;
    const dateText = match[1].trim();
    const parsed = new Date(dateText);
    if (!Number.isNaN(parsed.getTime())) {
      const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText)
        ? `${dateText}T00:00:00.000Z`
        : new Date(
            Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()),
          ).toISOString();
      pushFact(
        facts,
        seen,
        summary,
        field,
        calendarDate,
        'date-label',
        match[0],
      );
    }
  }

  const matchedSeniorities =
    titleSeniorities.length > 0 ? titleSeniorities : matchSeniorities(allText);
  const uniqueSeniorities = new Set(
    matchedSeniorities.map(({ value }) => value),
  );
  if (ambiguousSeniorityEvidence) {
    pushUnknownFact(
      facts,
      seen,
      'seniority',
      'ambiguous-seniority-signals',
      ambiguousSeniorityEvidence,
    );
  } else if (uniqueSeniorities.size === 1) {
    const match = matchedSeniorities[0];
    pushFact(
      facts,
      seen,
      summary,
      'seniority',
      match.value,
      'seniority-signal',
      match.evidence,
    );
  }

  compensationFacts(sections, facts, seen);
  return facts;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function prepareOpportunityPosting(
  opportunity: Record<string, unknown>,
): PreparedPosting {
  const sourceText =
    stringValue(opportunity.descriptionRaw) ||
    stringValue(opportunity.descriptionSummary);
  const rawLines = normalizedLines(sourceText);
  const seen = new Set<string>();
  const lines: Array<{ number: number; text: string }> = [];
  let removedBoilerplateCount = 0;
  let removedDuplicateCount = 0;

  rawLines.forEach((text, index) => {
    const key = lineKey(text);
    if (!key || BOILERPLATE_LINE.test(text)) {
      removedBoilerplateCount += 1;
      return;
    }
    if (seen.has(key)) {
      removedDuplicateCount += 1;
      return;
    }
    seen.add(key);
    lines.push({ number: index + 1, text });
  });

  const sections: PreparedPostingSection[] = [];
  let current: PreparedPostingSection = {
    heading: 'Summary',
    id: 'section-summary-1',
    kind: 'summary',
    sourceLineEnd: lines[0]?.number ?? 1,
    sourceLineStart: lines[0]?.number ?? 1,
    text: '',
  };
  let sectionCounter = 1;

  const flush = () => {
    current.text = current.text.trim();
    if (current.text) sections.push(current);
  };

  for (const line of lines) {
    const kind = headingKind(line.text);
    if (kind) {
      flush();
      sectionCounter += 1;
      current = {
        heading: line.text.replace(/[\s:–—-]+$/, ''),
        id: `section-${kind}-${sectionCounter}`,
        kind,
        sourceLineEnd: line.number,
        sourceLineStart: line.number,
        text: '',
      };
      continue;
    }
    current.text = current.text ? `${current.text}\n${line.text}` : line.text;
    current.sourceLineEnd = line.number;
  }
  flush();

  if (sections.length === 0 && sourceText) {
    sections.push({
      heading: 'Summary',
      id: 'section-summary-1',
      kind: 'summary',
      sourceLineEnd: rawLines.length || 1,
      sourceLineStart: 1,
      text: rawLines.join('\n'),
    });
  }

  const preparedWithoutFingerprint = {
    facts: deterministicFacts(opportunity, sections, lines),
    provenance: {
      normalizedLineCount: lines.length,
      removedBoilerplateCount,
      removedDuplicateCount,
      sourceContentFingerprint: stringValue(
        opportunity.sourceContentFingerprint,
      ),
      sourceContentVersion: positiveInteger(opportunity.sourceContentVersion),
    },
    sections,
    source: {
      canonicalUrl: stringValue(opportunity.canonicalUrl),
      postingUrl: stringValue(opportunity.postingUrl),
      title: stringValue(opportunity.title),
    },
    version:
      OPPORTUNITY_PREPARED_POSTING_VERSION as typeof OPPORTUNITY_PREPARED_POSTING_VERSION,
  };
  const fingerprint = createHash('sha256')
    .update(stableJson(preparedWithoutFingerprint))
    .digest('hex');
  return { ...preparedWithoutFingerprint, fingerprint };
}

function configuredInputCeiling(override?: number): number {
  const raw =
    override ?? Number(process.env.OPPORTUNITY_INTELLIGENCE_MAX_INPUT_TOKENS);
  const configured =
    Number.isSafeInteger(raw) && raw > 0
      ? raw
      : OPPORTUNITY_INPUT_TOKEN_CEILING_DEFAULT;
  return Math.min(configured, OPPORTUNITY_INPUT_TOKEN_CEILING_HARD_MAX);
}

export function inputTokenCeilingForModel(
  model: string,
  override?: number,
): number {
  const normalized = model.toLowerCase();
  const contextSafeCeiling =
    /(?:gemma|mistral|llama|qwen|ollama|snail|warthog)/.test(normalized)
      ? 6_000
      : OPPORTUNITY_INPUT_TOKEN_CEILING_HARD_MAX;
  return Math.min(configuredInputCeiling(override), contextSafeCeiling);
}

export function inputTokenTargetForHeadroom(
  inputTokenCeiling: number,
  minContextHeadroomRatio = OPPORTUNITY_INPUT_MIN_CONTEXT_HEADROOM_RATIO,
): number {
  const ratio = Number.isFinite(minContextHeadroomRatio)
    ? Math.min(0.95, Math.max(0, minContextHeadroomRatio))
    : OPPORTUNITY_INPUT_MIN_CONTEXT_HEADROOM_RATIO;
  return Math.max(1, Math.floor(inputTokenCeiling * (1 - ratio)));
}

export function conservativeTokenEstimate(text: string, model = ''): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  const divisor = /gemini/i.test(model) ? 3 : 2.5;
  return Math.ceil(bytes / divisor) + 8;
}

export async function countOpportunityInputTokens(
  messages: AIMessage[],
  model: string,
  counter?: (text: string) => Promise<number>,
): Promise<number> {
  const serialized = messages
    .map((message) => `${message.role}\n${stringValue(message.content)}`)
    .join('\n\n');
  const conservative = conservativeTokenEstimate(serialized, model);
  if (!counter) return conservative;
  try {
    const counted = await counter(serialized);
    return Math.max(conservative, Math.ceil(counted));
  } catch {
    return conservative;
  }
}

function cloneSection(
  section: PreparedPostingSection,
  text = section.text,
): PreparedPostingSection {
  return { ...section, text };
}

function prioritizedSections(
  sections: PreparedPostingSection[],
): PreparedPostingSection[] {
  return sections
    .map((section, index) => ({ index, section }))
    .sort(
      (left, right) =>
        SECTION_PRIORITY[left.section.kind] -
          SECTION_PRIORITY[right.section.kind] || left.index - right.index,
    )
    .map(({ section }) => cloneSection(section));
}

function splitSectionText(text: string, targetCharacters: number): string[] {
  const pieces: string[] = [];
  let current = '';
  const flush = () => {
    const value = current.trim();
    if (value) pieces.push(value);
    current = '';
  };
  for (const line of text.split('\n')) {
    let remaining = line.trim();
    while (remaining.length > targetCharacters) {
      flush();
      pieces.push(remaining.slice(0, targetCharacters).trim());
      remaining = remaining.slice(targetCharacters).trim();
    }
    if (!remaining) continue;
    if (current && current.length + remaining.length + 1 > targetCharacters) {
      flush();
    }
    current = current ? `${current}\n${remaining}` : remaining;
  }
  flush();
  return pieces;
}

export async function buildBoundedPreparedPostingChunks(options: {
  buildMessages: (chunk: PreparedPostingChunk) => AIMessage[];
  counter?: (text: string) => Promise<number>;
  inputTokenCeiling?: number;
  maxChunks?: number;
  minContextHeadroomRatio?: number;
  model: string;
  prepared: PreparedPosting;
}): Promise<PreparedPostingChunk[]> {
  const maxChunks = Math.max(
    1,
    Math.min(
      positiveInteger(options.maxChunks) || OPPORTUNITY_EXTRACTION_MAX_CHUNKS,
      OPPORTUNITY_EXTRACTION_MAX_CHUNKS,
    ),
  );
  const inputTokenCeiling = inputTokenCeilingForModel(
    options.model,
    options.inputTokenCeiling,
  );
  const inputTokenTarget = inputTokenTargetForHeadroom(
    inputTokenCeiling,
    options.minContextHeadroomRatio,
  );
  const sections = prioritizedSections(options.prepared.sections);
  const targetCharacters = Math.max(1_000, inputTokenTarget * 2);
  const buckets: PreparedPostingSection[][] = [];

  for (const section of sections) {
    const pieces = splitSectionText(section.text, targetCharacters);
    for (const piece of pieces) {
      let bucket = buckets.at(-1);
      const bucketLength =
        bucket?.reduce((total, entry) => total + entry.text.length, 0) ?? 0;
      if (
        !bucket ||
        ((bucketLength + piece.length > targetCharacters ||
          bucket.length >= 8) &&
          buckets.length < maxChunks)
      ) {
        bucket = [];
        buckets.push(bucket);
      }
      if (buckets.length > maxChunks) break;
      if (bucket.length >= 8) continue;
      bucket.push(cloneSection(section, piece));
    }
    if (
      buckets.length >= maxChunks &&
      (buckets.at(-1)?.reduce((total, entry) => total + entry.text.length, 0) ??
        0) >= targetCharacters
    ) {
      break;
    }
  }

  if (buckets.length === 0) buckets.push([]);
  const chunks: PreparedPostingChunk[] = [];
  const chunkCount = Math.min(buckets.length, maxChunks);

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunk: PreparedPostingChunk = {
      chunkCount,
      chunkIndex,
      facts: options.prepared.facts,
      inputTokenCeiling,
      inputTokenCount: 0,
      preparedFingerprint: options.prepared.fingerprint,
      preparedVersion: OPPORTUNITY_PREPARED_POSTING_VERSION,
      sections: buckets[chunkIndex] ?? [],
      source: options.prepared.source,
    };

    let inputTokenCount = await countOpportunityInputTokens(
      options.buildMessages(chunk),
      options.model,
      options.counter,
    );
    while (inputTokenCount > inputTokenTarget) {
      const longest = chunk.sections
        .map((section, index) => ({ index, length: section.text.length }))
        .sort(
          (left, right) =>
            right.length - left.length || left.index - right.index,
        )[0];
      if (!longest) {
        throw new Error(
          `Prepared posting metadata exceeds the ${inputTokenTarget}-token reserved input target (${inputTokenCeiling}-token ceiling).`,
        );
      }
      if (longest.length < 80 && chunk.sections.length > 1) {
        chunk.sections.splice(longest.index, 1);
        inputTokenCount = await countOpportunityInputTokens(
          options.buildMessages(chunk),
          options.model,
          options.counter,
        );
        continue;
      }
      if (longest.length < 80) {
        throw new Error(
          `Prepared posting metadata exceeds the ${inputTokenTarget}-token reserved input target (${inputTokenCeiling}-token ceiling).`,
        );
      }
      const section = chunk.sections[longest.index];
      section.text = section.text
        .slice(0, Math.max(64, Math.floor(section.text.length * 0.8)))
        .trim();
      inputTokenCount = await countOpportunityInputTokens(
        options.buildMessages(chunk),
        options.model,
        options.counter,
      );
    }
    chunk.inputTokenCount = inputTokenCount;
    chunks.push(chunk);
  }

  return chunks;
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  );
}

export function mergeOpportunityExtractionChunks(
  chunks: Array<{
    chunkIndex: number;
    output: Record<string, unknown>;
    sectionIds: string[];
  }>,
  deterministic: PreparedPostingFact[] = [],
): OpportunityExtractionMerge {
  const output: Record<string, unknown> = {};
  const fieldProvenance: OpportunityExtractionMerge['fieldProvenance'] = {};
  const conflicts: OpportunityExtractionMerge['conflicts'] = [];
  const selectedChunk = new Map<string, number | 'deterministic'>();

  for (const fact of deterministic) {
    if (!(fact.field in output)) {
      output[fact.field] = fact.value;
      selectedChunk.set(fact.field, 'deterministic');
    }
    fieldProvenance[fact.field] ??= [];
    fieldProvenance[fact.field].push({
      chunkIndex: 'deterministic',
      sectionIds: [fact.evidence.sectionId],
    });
  }

  for (const chunk of [...chunks].sort(
    (left, right) => left.chunkIndex - right.chunkIndex,
  )) {
    for (const [field, rawValue] of Object.entries(chunk.output)) {
      if (rawValue === null || rawValue === undefined || rawValue === '')
        continue;
      fieldProvenance[field] ??= [];
      fieldProvenance[field].push({
        chunkIndex: chunk.chunkIndex,
        sectionIds: [...chunk.sectionIds],
      });

      if (Array.isArray(rawValue)) {
        const existing = Array.isArray(output[field]) ? output[field] : [];
        const seen = new Set(existing.map((value) => stableJson(value)));
        const merged = [...existing];
        for (const value of rawValue) {
          const key = stableJson(value);
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(value);
          }
        }
        if (!(field in output) || Array.isArray(output[field])) {
          output[field] = merged;
          selectedChunk.set(
            field,
            selectedChunk.get(field) ?? chunk.chunkIndex,
          );
        }
        continue;
      }

      if (!(field in output)) {
        output[field] = rawValue;
        selectedChunk.set(field, chunk.chunkIndex);
        continue;
      }
      if (
        isScalar(rawValue) &&
        stableJson(output[field]) !== stableJson(rawValue)
      ) {
        conflicts.push({
          discardedChunkIndex: chunk.chunkIndex,
          discardedValue: rawValue,
          field,
          selectedChunkIndex: selectedChunk.get(field) ?? chunk.chunkIndex,
          selectedValue: output[field],
        });
      }
    }
  }

  return { conflicts, fieldProvenance, output };
}

export function preparedPostingFactsAsOutput(
  prepared: PreparedPosting,
): Record<string, unknown> {
  return mergeOpportunityExtractionChunks([], prepared.facts).output;
}
