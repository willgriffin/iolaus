import { createHash } from 'node:crypto';
import type { AIMessage } from '@happyvertical/ai';
import {
  OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_HARD_MAX,
  type OpportunityScoringConfig,
} from './opportunity-intelligence-config.js';
import {
  countOpportunityInputTokens,
  inputTokenTargetForHeadroom,
  OPPORTUNITY_PREPARED_POSTING_VERSION,
  type PreparedPosting,
  type PreparedPostingEvidence,
  type PreparedPostingFact,
  type PreparedPostingSection,
} from './opportunity-posting-preparation.js';

export const OPPORTUNITY_SCORING_INPUT_VERSION = 'opportunity-scoring-input/v2';
export const OPPORTUNITY_SCORING_PROMPT_VERSION = 'opportunity-score/v5';
export const OPPORTUNITY_SCORING_OUTPUT_SCHEMA_VERSION =
  'opportunity-score-output/v1';
export const OPPORTUNITY_SCORING_MAX_REQUIREMENTS = 8;
export const OPPORTUNITY_SCORING_MAX_STRUCTURED_FACTS = 8;
export const OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT = 20;
export const OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH = 180;
export const OPPORTUNITY_SCORING_MAX_SOURCES_PER_REQUIREMENT = 2;

export interface OpportunityScoringEvidenceSource {
  id: string;
  kind: string;
  text: string;
  title: string;
}

export interface OpportunityScoringExcerpt {
  excerpt: string;
  id: string;
  sectionId?: string;
  sourceId?: string;
  sourceKind:
    | 'candidate'
    | 'opportunity_field'
    | 'prepared_fact'
    | 'prepared_section';
  sourceLineEnd?: number;
  sourceLineStart?: number;
  title: string;
}

export interface OpportunityScoringRequirement {
  id: string;
  kind: 'preferred' | 'required';
  postingExcerpt?: OpportunityScoringExcerpt;
  sourceField: 'preferredSkills' | 'requiredSkills';
  value: string;
}

export interface OpportunityScoringCandidateEvidence
  extends OpportunityScoringExcerpt {
  kind: string;
  requirementIds: string[];
  sourceKind: 'candidate';
}

export interface OpportunityScoringStructuredFact {
  evidence: OpportunityScoringExcerpt;
  field: string;
  id: string;
  method: string;
  value: boolean | number | string;
}

export interface OpportunityScoringFactConflict {
  factIds: string[];
  field: string;
  values: Array<boolean | number | string>;
}

export interface OpportunityScoringInput {
  candidateEvidence: OpportunityScoringCandidateEvidence[];
  conflicts: OpportunityScoringFactConflict[];
  evidenceCount: number;
  fingerprint: string;
  limits: {
    evidenceCount: typeof OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT;
    excerptCharacters: typeof OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH;
    inputTokens: number;
    requirements: typeof OPPORTUNITY_SCORING_MAX_REQUIREMENTS;
    structuredFacts: typeof OPPORTUNITY_SCORING_MAX_STRUCTURED_FACTS;
  };
  policy: Pick<
    OpportunityScoringConfig,
    'clearAcceptMinRequired' | 'clearRejectMinGaps' | 'modelEnabled'
  >;
  prepared: {
    fingerprint: string;
    sourceContentFingerprint: string;
    sourceContentVersion: number;
    version: typeof OPPORTUNITY_PREPARED_POSTING_VERSION;
  };
  requirements: OpportunityScoringRequirement[];
  signals: {
    conflictCount: number;
    gapRequiredCount: number;
    missingPostingExcerptCount: number;
    requiredCount: number;
    supportedRequiredCount: number;
  };
  structuredFacts: OpportunityScoringStructuredFact[];
  version: typeof OPPORTUNITY_SCORING_INPUT_VERSION;
}

export interface OpportunityScoringEvidenceMatch {
  requirement: string;
  status: 'gap' | 'supported';
  sources: Array<{
    excerpt: string;
    id: string;
    kind: string;
    title: string;
  }>;
}

export type OpportunityScoringPreScoreKind =
  | 'borderline'
  | 'clear_accept'
  | 'clear_reject'
  | 'conflicting_evidence'
  | 'missing_evidence';

export interface OpportunityScoringPreScore {
  kind: OpportunityScoringPreScoreKind;
  modelEligible: boolean;
  signals: OpportunityScoringInput['signals'];
}

export interface BoundedOpportunityScoringRequest {
  evidenceMatrix: OpportunityScoringEvidenceMatch[];
  input: OpportunityScoringInput;
  inputTokenCeiling: number;
  inputTokenCount: number;
  messages: AIMessage[];
}

export interface OpportunityScoringReason {
  decision: OpportunityScoringPreScore;
  input: OpportunityScoringInput;
  inputTokenCeiling: number;
  inputTokenCount: number;
  model: string;
  modelInvoked: boolean;
  outputSchemaVersion: typeof OPPORTUNITY_SCORING_OUTPUT_SCHEMA_VERSION;
  promptVersion: typeof OPPORTUNITY_SCORING_PROMPT_VERSION;
}

export interface OpportunityScoringAttributableReasons {
  dataQualityWarnings: string[];
  fitReasons: string[];
  missingInfo: string[];
}

export type PreparedPostingScoringValidation =
  | { kind: 'ready'; prepared: PreparedPosting }
  | { kind: 'prerequisite' | 'stale'; message: string };

const STRUCTURED_FACT_FIELD_PRIORITY = [
  'title',
  'employmentType',
  'seniority',
  'workMode',
  'locations',
  'locationNotes',
  'salaryMin',
  'salaryMax',
  'hourlyMin',
  'hourlyMax',
  'currency',
] as const;

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isMeaningfulScalar(
  value: unknown,
): value is boolean | number | string {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim().length > 0)
  );
}

function scalarFactKey(value: boolean | number | string): string {
  if (typeof value !== 'string') return `${typeof value}:${stableJson(value)}`;
  return `string:${value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()}`;
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

function textList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map(stringValue)
    : stringValue(value).split(/\r?\n|,/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw.map((entry) => entry.trim()).filter(Boolean)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function boundedText(value: unknown, maximum: number): string {
  const text = stringValue(value).replace(/\s+/g, ' ');
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 3)).trimEnd()}...`;
}

function boundedRelevantText(
  value: unknown,
  relevance: string,
  maximum: number,
): string {
  const text = stringValue(value).replace(/\s+/g, ' ');
  const segments = stringValue(value)
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((segment, index) => ({
      index,
      score: matchScore(relevance, segment),
      text: segment.replace(/\s+/g, ' ').trim(),
    }))
    .filter((segment) => segment.text);
  const selected = segments.sort(
    (left, right) => right.score - left.score || left.index - right.index,
  )[0];
  const excerptSource = selected?.score ? selected.text : text;
  if (excerptSource.length <= maximum) return excerptSource;

  const matchIndex = excerptSource
    .toLowerCase()
    .indexOf(relevance.trim().toLowerCase());
  if (matchIndex < 0) return boundedText(excerptSource, maximum);

  const markerLength = 3;
  const available = Math.max(1, maximum - markerLength * 2);
  const start = Math.max(
    0,
    Math.min(
      matchIndex - Math.floor((available - relevance.length) / 2),
      excerptSource.length - available,
    ),
  );
  const end = Math.min(excerptSource.length, start + available);
  return `${start > 0 ? '...' : ''}${excerptSource.slice(start, end).trim()}${end < excerptSource.length ? '...' : ''}`.slice(
    0,
    maximum,
  );
}

function normalizedMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchScore(requirement: string, source: string): number {
  const normalizedRequirement = normalizedMatchText(requirement);
  const normalizedSource = normalizedMatchText(source);
  if (!normalizedRequirement || !normalizedSource) return 0;
  if (normalizedSource.includes(normalizedRequirement)) return 3;
  const tokens = normalizedRequirement
    .split(' ')
    .filter((token) => token.length > 2);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => normalizedSource.includes(token));
  if (matched.length === tokens.length) return 2;
  return matched.length / tokens.length >= 0.75 ? 1 : 0;
}

function excerptFromPreparedEvidence(
  id: string,
  evidence: PreparedPostingEvidence,
  sourceKind: 'prepared_fact' | 'prepared_section',
  title: string,
): OpportunityScoringExcerpt {
  return {
    excerpt: boundedText(
      evidence.excerpt,
      OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
    ),
    id,
    sectionId: evidence.sectionId,
    sourceKind,
    sourceLineEnd: evidence.sourceLineEnd,
    sourceLineStart: evidence.sourceLineStart,
    title: boundedText(title, 120),
  };
}

function sectionExcerptForRequirement(
  requirement: OpportunityScoringRequirement,
  sections: PreparedPostingSection[],
): OpportunityScoringExcerpt | undefined {
  const candidates = sections.flatMap((section, sectionIndex) =>
    section.text.split('\n').map((line, lineIndex) => ({
      line,
      lineIndex,
      score: matchScore(requirement.value, line),
      section,
      sectionIndex,
    })),
  );
  const selected = candidates
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.section.kind === 'qualifications' ? -1 : 0) -
          (right.section.kind === 'qualifications' ? -1 : 0) ||
        left.sectionIndex - right.sectionIndex ||
        left.lineIndex - right.lineIndex,
    )[0];
  if (!selected) return undefined;
  const completePreparedText = sections
    .map((section) => section.text.trim())
    .filter(Boolean)
    .join('\n');
  if (selected.line.trim() === completePreparedText) return undefined;
  const line = Math.min(
    selected.section.sourceLineEnd,
    selected.section.sourceLineStart +
      selected.lineIndex +
      (selected.section.kind === 'summary' ? 0 : 1),
  );
  return {
    excerpt: boundedText(selected.line, OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH),
    id: `${selected.section.id}:line-${line}`,
    sectionId: selected.section.id,
    sourceKind: 'prepared_section',
    sourceLineEnd: line,
    sourceLineStart: line,
    title: boundedText(selected.section.heading, 120),
  };
}

function selectedRequirements(
  opportunity: Record<string, unknown>,
): OpportunityScoringRequirement[] {
  const requirements: OpportunityScoringRequirement[] = [];
  for (const [kind, sourceField] of [
    ['required', 'requiredSkills'],
    ['preferred', 'preferredSkills'],
  ] as const) {
    for (const value of textList(opportunity[sourceField])) {
      if (requirements.length >= OPPORTUNITY_SCORING_MAX_REQUIREMENTS) break;
      requirements.push({
        id: `requirement-${kind}-${requirements.length + 1}`,
        kind,
        sourceField,
        value: boundedText(value, 240),
      });
    }
  }
  return requirements;
}

function rankedCandidateSources(
  requirement: OpportunityScoringRequirement,
  sources: OpportunityScoringEvidenceSource[],
): OpportunityScoringEvidenceSource[] {
  return sources
    .map((source, index) => ({
      index,
      score: matchScore(requirement.value, `${source.title}\n${source.text}`),
      source,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.source.kind.localeCompare(right.source.kind) ||
        left.source.id.localeCompare(right.source.id) ||
        left.source.title.localeCompare(right.source.title) ||
        left.index - right.index,
    )
    .map(({ source }) => source);
}

function selectedStructuredFacts(
  facts: PreparedPostingFact[],
  opportunity: Record<string, unknown>,
  availableEvidence: number,
): OpportunityScoringStructuredFact[] {
  const priority = new Map<string, number>(
    STRUCTURED_FACT_FIELD_PRIORITY.map((field, index) => [field, index]),
  );
  const seen = new Set<string>();
  const opportunityFactFields = new Set<string>();
  const preparedValuesByField = new Map<string, Set<string>>();
  for (const fact of facts) {
    const values = preparedValuesByField.get(fact.field) ?? new Set<string>();
    values.add(scalarFactKey(fact.value));
    preparedValuesByField.set(fact.field, values);
  }
  return facts
    .map((fact, index) => ({ fact, index }))
    .filter(({ fact }) => priority.has(fact.field))
    .sort(
      (left, right) =>
        (priority.get(left.fact.field) ?? 999) -
          (priority.get(right.fact.field) ?? 999) || left.index - right.index,
    )
    .flatMap(({ fact, index }) => {
      const key = `${fact.field}:${scalarFactKey(fact.value)}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const id = `prepared-fact-${index + 1}`;
      const selected: OpportunityScoringStructuredFact[] = [
        {
          evidence: excerptFromPreparedEvidence(
            `${id}:evidence`,
            fact.evidence,
            'prepared_fact',
            fact.field,
          ),
          field: fact.field,
          id,
          method: boundedText(fact.method, 120),
          value: fact.value,
        },
      ];
      const opportunityValue = opportunity[fact.field];
      if (
        isMeaningfulScalar(opportunityValue) &&
        !opportunityFactFields.has(fact.field) &&
        !preparedValuesByField
          .get(fact.field)
          ?.has(scalarFactKey(opportunityValue))
      ) {
        opportunityFactFields.add(fact.field);
        const opportunityId = `opportunity-field-${fact.field}`;
        const sourceId = stringValue(opportunity.id);
        selected.push({
          evidence: {
            excerpt: boundedText(
              opportunityValue,
              OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
            ),
            id: `${opportunityId}:evidence`,
            ...(sourceId ? { sourceId } : {}),
            sourceKind: 'opportunity_field',
            title: boundedText(fact.field, 120),
          },
          field: fact.field,
          id: opportunityId,
          method: 'persisted-opportunity-field',
          value: opportunityValue,
        });
      }
      return selected;
    })
    .slice(
      0,
      Math.min(
        OPPORTUNITY_SCORING_MAX_STRUCTURED_FACTS,
        Math.max(0, availableEvidence),
      ),
    );
}

function factConflicts(
  facts: OpportunityScoringStructuredFact[],
): OpportunityScoringFactConflict[] {
  const byField = new Map<string, OpportunityScoringStructuredFact[]>();
  for (const fact of facts) {
    const entries = byField.get(fact.field) ?? [];
    entries.push(fact);
    byField.set(fact.field, entries);
  }
  return [...byField.entries()].flatMap(([field, entries]) => {
    const distinct = new Map(
      entries.map((entry) => [scalarFactKey(entry.value), entry.value]),
    );
    if (distinct.size < 2) return [];
    return [
      {
        factIds: entries.map((entry) => entry.id),
        field,
        values: [...distinct.values()],
      },
    ];
  });
}

function evidenceMatrixForInput(
  input: Pick<OpportunityScoringInput, 'candidateEvidence' | 'requirements'>,
): OpportunityScoringEvidenceMatch[] {
  return input.requirements.map((requirement) => {
    const sources = input.candidateEvidence
      .filter((evidence) => evidence.requirementIds.includes(requirement.id))
      .slice(0, OPPORTUNITY_SCORING_MAX_SOURCES_PER_REQUIREMENT)
      .map((evidence) => ({
        excerpt: evidence.excerpt,
        id: evidence.sourceId ?? evidence.id,
        kind: evidence.kind,
        title: evidence.title,
      }));
    return {
      requirement: requirement.value,
      sources,
      status: sources.length > 0 ? 'supported' : 'gap',
    };
  });
}

function inputSignals(
  input: Pick<
    OpportunityScoringInput,
    'candidateEvidence' | 'conflicts' | 'requirements'
  >,
): OpportunityScoringInput['signals'] {
  const matrix = evidenceMatrixForInput(input);
  const required = input.requirements.filter(
    (requirement) => requirement.kind === 'required',
  );
  const requiredMatrix = matrix.filter(
    (_entry, index) => input.requirements[index]?.kind === 'required',
  );
  return {
    conflictCount: input.conflicts.length,
    gapRequiredCount: requiredMatrix.filter((entry) => entry.status === 'gap')
      .length,
    missingPostingExcerptCount: required.filter(
      (requirement) => !requirement.postingExcerpt,
    ).length,
    requiredCount: required.length,
    supportedRequiredCount: requiredMatrix.filter(
      (entry) => entry.status === 'supported',
    ).length,
  };
}

function finalizeInput(
  input: Omit<
    OpportunityScoringInput,
    'evidenceCount' | 'fingerprint' | 'signals'
  >,
): OpportunityScoringInput {
  const conflicts = factConflicts(input.structuredFacts);
  const evidenceCount =
    input.candidateEvidence.length +
    input.structuredFacts.length +
    input.requirements.filter((requirement) => requirement.postingExcerpt)
      .length;
  const withoutFingerprint = {
    ...input,
    conflicts,
    evidenceCount,
    signals: inputSignals({
      candidateEvidence: input.candidateEvidence,
      conflicts,
      requirements: input.requirements,
    }),
  };
  return {
    ...withoutFingerprint,
    fingerprint: createHash('sha256')
      .update(stableJson(withoutFingerprint))
      .digest('hex'),
  };
}

function cloneInputForTrimming(
  input: OpportunityScoringInput,
): Omit<OpportunityScoringInput, 'evidenceCount' | 'fingerprint' | 'signals'> {
  const {
    evidenceCount: _count,
    fingerprint: _fingerprint,
    signals: _signals,
    ...rest
  } = input;
  return {
    ...rest,
    candidateEvidence: rest.candidateEvidence.map((entry) => ({
      ...entry,
      requirementIds: [...entry.requirementIds],
    })),
    requirements: rest.requirements.map((entry) => ({
      ...entry,
      ...(entry.postingExcerpt
        ? { postingExcerpt: { ...entry.postingExcerpt } }
        : {}),
    })),
    structuredFacts: rest.structuredFacts.map((entry) => ({
      ...entry,
      evidence: { ...entry.evidence },
    })),
  };
}

export function validatePreparedPostingForScoring(options: {
  expectedSourceContentFingerprint?: unknown;
  expectedSourceContentVersion?: unknown;
  opportunity: Record<string, unknown>;
}): PreparedPostingScoringValidation {
  const storedVersion = stringValue(options.opportunity.preparedPostingVersion);
  const storedFingerprint = stringValue(
    options.opportunity.preparedPostingFingerprint,
  );
  if (
    storedVersion !== OPPORTUNITY_PREPARED_POSTING_VERSION ||
    !storedFingerprint
  ) {
    return {
      kind: 'prerequisite',
      message: 'Prepare the opportunity posting before scoring.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stringValue(options.opportunity.preparedPostingJson));
  } catch {
    parsed = null;
  }
  const record = unknownRecord(parsed);
  if (
    record.version !== OPPORTUNITY_PREPARED_POSTING_VERSION ||
    stringValue(record.fingerprint) !== storedFingerprint ||
    !Array.isArray(record.facts) ||
    !Array.isArray(record.sections)
  ) {
    return {
      kind: 'prerequisite',
      message: 'The prepared opportunity payload is invalid or unsupported.',
    };
  }

  const prepared = record as unknown as PreparedPosting;
  const expectedFingerprint =
    stringValue(options.expectedSourceContentFingerprint) ||
    stringValue(options.opportunity.sourceContentFingerprint);
  const expectedVersion =
    positiveInteger(options.expectedSourceContentVersion) ||
    positiveInteger(options.opportunity.sourceContentVersion);
  if (
    (expectedFingerprint &&
      prepared.provenance.sourceContentFingerprint !== expectedFingerprint) ||
    (expectedVersion > 0 &&
      prepared.provenance.sourceContentVersion !== expectedVersion)
  ) {
    return {
      kind: 'stale',
      message: 'Skipped stale prepared opportunity scoring payload.',
    };
  }
  return { kind: 'ready', prepared };
}

function initialScoringInput(options: {
  evidenceSources: OpportunityScoringEvidenceSource[];
  inputTokenCeiling: number;
  opportunity: Record<string, unknown>;
  policy: OpportunityScoringConfig;
  prepared: PreparedPosting;
}): OpportunityScoringInput {
  const requirements = selectedRequirements(options.opportunity);
  let evidenceCount = 0;
  for (const requirement of requirements) {
    const excerpt = sectionExcerptForRequirement(
      requirement,
      options.prepared.sections,
    );
    if (excerpt && evidenceCount < OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT) {
      requirement.postingExcerpt = excerpt;
      evidenceCount += 1;
    }
  }

  const candidateEvidence: OpportunityScoringCandidateEvidence[] = [];
  const candidateBySource = new Map<
    string,
    OpportunityScoringCandidateEvidence
  >();
  for (const requirement of requirements) {
    const matches = rankedCandidateSources(
      requirement,
      options.evidenceSources,
    ).slice(0, OPPORTUNITY_SCORING_MAX_SOURCES_PER_REQUIREMENT);
    for (const source of matches) {
      const sourceKey = `${source.kind}:${source.id}`;
      const existing = candidateBySource.get(sourceKey);
      if (existing) {
        if (!existing.requirementIds.includes(requirement.id)) {
          existing.requirementIds.push(requirement.id);
        }
        continue;
      }
      if (evidenceCount >= OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT) break;
      const selected: OpportunityScoringCandidateEvidence = {
        excerpt: boundedRelevantText(
          source.text,
          requirement.value,
          OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
        ),
        id: `candidate:${source.kind}:${source.id}`,
        kind: source.kind,
        requirementIds: [requirement.id],
        sourceId: source.id,
        sourceKind: 'candidate',
        title: boundedText(source.title, 120),
      };
      candidateEvidence.push(selected);
      candidateBySource.set(sourceKey, selected);
      evidenceCount += 1;
    }
  }

  if (
    candidateEvidence.length === 0 &&
    evidenceCount < OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT
  ) {
    const source = options.evidenceSources
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) => stringValue(entry.text) || stringValue(entry.title),
      )
      .sort(
        (left, right) =>
          left.entry.kind.localeCompare(right.entry.kind) ||
          left.entry.id.localeCompare(right.entry.id) ||
          left.entry.title.localeCompare(right.entry.title) ||
          left.index - right.index,
      )[0]?.entry;
    if (source) {
      candidateEvidence.push({
        excerpt: boundedText(
          stringValue(source.text) || stringValue(source.title),
          OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
        ),
        id: `candidate:${source.kind}:${source.id}`,
        kind: source.kind,
        requirementIds: [],
        sourceId: source.id,
        sourceKind: 'candidate',
        title: boundedText(source.title, 120),
      });
      evidenceCount += 1;
    }
  }

  const structuredFacts = selectedStructuredFacts(
    options.prepared.facts,
    options.opportunity,
    OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT - evidenceCount,
  );
  return finalizeInput({
    candidateEvidence,
    conflicts: [],
    limits: {
      evidenceCount: OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT,
      excerptCharacters: OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
      inputTokens: options.inputTokenCeiling,
      requirements: OPPORTUNITY_SCORING_MAX_REQUIREMENTS,
      structuredFacts: OPPORTUNITY_SCORING_MAX_STRUCTURED_FACTS,
    },
    policy: {
      clearAcceptMinRequired: options.policy.clearAcceptMinRequired,
      clearRejectMinGaps: options.policy.clearRejectMinGaps,
      modelEnabled: options.policy.modelEnabled,
    },
    prepared: {
      fingerprint: options.prepared.fingerprint,
      sourceContentFingerprint:
        options.prepared.provenance.sourceContentFingerprint,
      sourceContentVersion: options.prepared.provenance.sourceContentVersion,
      version: OPPORTUNITY_PREPARED_POSTING_VERSION,
    },
    requirements,
    structuredFacts,
    version: OPPORTUNITY_SCORING_INPUT_VERSION,
  });
}

export function buildOpportunityScoringMessages(
  input: OpportunityScoringInput,
): AIMessage[] {
  const deterministicClassification = preScoreOpportunity(input).kind;
  return [
    {
      role: 'system',
      content: [
        `Opportunity scoring contract ${OPPORTUNITY_SCORING_PROMPT_VERSION}.`,
        'Use only the supplied versioned structured facts and attributable excerpts.',
        'Do not infer candidate experience or posting requirements that are not represented by an exact reference.',
        'Return one JSON object only with no Markdown or prose outside the object.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        expectedFields: [
          'score',
          'recommendation',
          'summary',
          'fitReasons',
          'risks',
          'missingInfo',
          'confidence',
          'suggestedNextAction',
          'dataQualityWarnings',
        ],
        deterministicClassification,
        input,
        instructions: [
          'Use score 0-100, confidence 0-1, and recommendation recommend|maybe|needs_research|reject.',
          'This request is eligible only because deterministic pre-scoring classified it as borderline or conflicting_evidence.',
          'When deterministicClassification is borderline or conflicting_evidence, recommendation must be maybe; preserve the distinction in score, confidence, reasons, risks, and suggested next action.',
          'Cite supplied fact, requirement, and evidence ids in reasons. Treat unsupported required requirements as gaps.',
          'Use maybe for bounded uncertainty such as partial required-skill support or attributable conflicting facts.',
          'Use needs_research only when critical source facts or candidate evidence are absent or unattributable, not for an ordinary bounded gap or attributable conflict.',
          'Do not make a final user decision.',
        ],
      }),
    },
  ];
}

export async function buildBoundedOpportunityScoringRequest(options: {
  counter?: (text: string) => Promise<number>;
  evidenceSources: OpportunityScoringEvidenceSource[];
  inputTokenCeiling: number;
  minContextHeadroomRatio?: number;
  model: string;
  opportunity: Record<string, unknown>;
  policy: OpportunityScoringConfig;
  prepared: PreparedPosting;
}): Promise<BoundedOpportunityScoringRequest> {
  const inputTokenCeiling = Math.min(
    Math.max(1, Math.trunc(options.inputTokenCeiling)),
    OPPORTUNITY_INTELLIGENCE_SCORING_INPUT_TOKEN_HARD_MAX,
  );
  const inputTokenTarget = inputTokenTargetForHeadroom(
    inputTokenCeiling,
    options.minContextHeadroomRatio,
  );
  let input = initialScoringInput({
    ...options,
    inputTokenCeiling,
  });
  let messages = buildOpportunityScoringMessages(input);
  let inputTokenCount = await countOpportunityInputTokens(
    messages,
    options.model,
    options.counter,
  );

  while (inputTokenCount > inputTokenTarget) {
    const mutable = cloneInputForTrimming(input);
    if (mutable.structuredFacts.length > 0) {
      mutable.structuredFacts.pop();
    } else {
      const excerptRequirement = [...mutable.requirements]
        .reverse()
        .find((requirement) => requirement.postingExcerpt);
      if (excerptRequirement) {
        delete excerptRequirement.postingExcerpt;
      } else if (mutable.candidateEvidence.length > 0) {
        mutable.candidateEvidence.pop();
      } else {
        throw new Error(
          `Opportunity scoring metadata exceeds the ${inputTokenTarget}-token reserved input target (${inputTokenCeiling}-token ceiling).`,
        );
      }
    }
    input = finalizeInput(mutable);
    messages = buildOpportunityScoringMessages(input);
    inputTokenCount = await countOpportunityInputTokens(
      messages,
      options.model,
      options.counter,
    );
  }

  return {
    evidenceMatrix: evidenceMatrixForInput(input),
    input,
    inputTokenCeiling,
    inputTokenCount,
    messages,
  };
}

export function preScoreOpportunity(
  input: OpportunityScoringInput,
): OpportunityScoringPreScore {
  const { signals } = input;
  if (signals.requiredCount === 0 || input.candidateEvidence.length === 0) {
    return { kind: 'missing_evidence', modelEligible: false, signals };
  }
  const hasRequirementMatchedEvidence = input.candidateEvidence.some(
    (evidence) => evidence.requirementIds.length > 0,
  );
  if (signals.conflictCount > 0) {
    if (!hasRequirementMatchedEvidence) {
      return { kind: 'missing_evidence', modelEligible: false, signals };
    }
    return { kind: 'conflicting_evidence', modelEligible: true, signals };
  }
  if (
    input.policy.clearRejectMinGaps > 0 &&
    signals.gapRequiredCount >= input.policy.clearRejectMinGaps
  ) {
    return { kind: 'clear_reject', modelEligible: false, signals };
  }
  if (!hasRequirementMatchedEvidence) {
    return { kind: 'missing_evidence', modelEligible: false, signals };
  }
  if (
    input.policy.clearAcceptMinRequired > 0 &&
    signals.gapRequiredCount === 0 &&
    signals.supportedRequiredCount >= input.policy.clearAcceptMinRequired &&
    signals.missingPostingExcerptCount === 0
  ) {
    return { kind: 'clear_accept', modelEligible: false, signals };
  }
  return { kind: 'borderline', modelEligible: true, signals };
}

export function deterministicOpportunityScore(
  request: BoundedOpportunityScoringRequest,
  decision: OpportunityScoringPreScore,
): {
  confidence: number;
  dataQualityWarnings: string[];
  fitReasons: string[];
  missingInfo: string[];
  recommendation: 'maybe' | 'needs_research' | 'recommend' | 'reject';
  risks: string[];
  score: number | null;
  suggestedNextAction: string;
  summary: string;
} {
  const { dataQualityWarnings, fitReasons, missingInfo } =
    attributableOpportunityScoringReasons(request);

  if (decision.kind === 'clear_accept') {
    return {
      confidence: 0.95,
      dataQualityWarnings,
      fitReasons,
      missingInfo,
      recommendation: 'recommend',
      risks: [],
      score: 90,
      suggestedNextAction:
        'Review the deterministic recommendation before applying.',
      summary:
        'Configured deterministic accept gates passed with attributable support for every required requirement.',
    };
  }
  if (decision.kind === 'clear_reject') {
    return {
      confidence: 0.95,
      dataQualityWarnings,
      fitReasons,
      missingInfo,
      recommendation: 'reject',
      risks: missingInfo,
      score: 25,
      suggestedNextAction:
        'Review the deterministic gaps before closing the opportunity.',
      summary:
        'Configured deterministic reject gates found too many unsupported required requirements.',
    };
  }
  if (decision.kind === 'missing_evidence') {
    return {
      confidence: 0.95,
      dataQualityWarnings: [
        ...dataQualityWarnings,
        'Deterministic scoring lacks attributable candidate evidence or required requirements.',
      ],
      fitReasons,
      missingInfo,
      recommendation: 'needs_research',
      risks: [],
      score: null,
      suggestedNextAction:
        'Capture or review candidate evidence before model scoring.',
      summary:
        'Scoring stopped before model invocation because required attributable evidence is missing.',
    };
  }
  return {
    confidence: 0.8,
    dataQualityWarnings: [
      ...dataQualityWarnings,
      'Optional model scoring is disabled for this ambiguous case.',
    ],
    fitReasons,
    missingInfo,
    recommendation:
      decision.kind === 'conflicting_evidence' || missingInfo.length > 0
        ? 'needs_research'
        : 'maybe',
    risks: dataQualityWarnings,
    score: missingInfo.length > 0 ? 45 : 60,
    suggestedNextAction:
      'Resolve the ambiguous evidence or explicitly enable bounded model scoring.',
    summary:
      'Deterministic pre-scoring preserved the ambiguous result while the independent model kill switch remained off.',
  };
}

export function attributableOpportunityScoringReasons(
  request: BoundedOpportunityScoringRequest,
): OpportunityScoringAttributableReasons {
  const supported = request.evidenceMatrix.filter(
    (entry) => entry.status === 'supported',
  );
  const gaps = request.evidenceMatrix.filter((entry, index) => {
    return (
      request.input.requirements[index]?.kind === 'required' &&
      entry.status === 'gap'
    );
  });
  return {
    dataQualityWarnings: request.input.conflicts.map(
      (conflict) =>
        `Conflicting prepared facts for ${conflict.field}: ${conflict.factIds.join(', ')}.`,
    ),
    fitReasons: supported.map((entry) => {
      const ids = entry.sources.map((source) => source.id).join(', ');
      return `Supported requirement "${entry.requirement}" with evidence ${ids}.`;
    }),
    missingInfo: gaps.map((entry) => {
      const requirement = request.input.requirements.find(
        (candidate) => candidate.value === entry.requirement,
      );
      return requirement?.postingExcerpt
        ? `No reviewed candidate evidence for "${entry.requirement}"; posting evidence ${requirement.postingExcerpt.id}.`
        : `No reviewed candidate evidence or posting excerpt for "${entry.requirement}".`;
    }),
  };
}

export function scoringReason(options: {
  decision: OpportunityScoringPreScore;
  model?: string;
  modelInvoked: boolean;
  request: BoundedOpportunityScoringRequest;
}): OpportunityScoringReason {
  return {
    decision: options.decision,
    input: options.request.input,
    inputTokenCeiling: options.request.inputTokenCeiling,
    inputTokenCount: options.request.inputTokenCount,
    model: options.model ?? '',
    modelInvoked: options.modelInvoked,
    outputSchemaVersion: OPPORTUNITY_SCORING_OUTPUT_SCHEMA_VERSION,
    promptVersion: OPPORTUNITY_SCORING_PROMPT_VERSION,
  };
}
