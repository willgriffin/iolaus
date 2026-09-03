import type { AIInterface, AIMessage, ChatOptions } from '@happyvertical/ai';
import { resolveDatabase } from '@happyvertical/smrt-core';
import type { User } from '@happyvertical/smrt-users';
import { applicationMaterialsAreLockedOrLeased } from '../objects/application-approval-scope.js';
import {
  isActiveTaskStatus,
  type TaskAssigneeRole,
} from '../objects/workflow.js';
import {
  type AiProfileClient,
  resolveAiProfileClient,
  resolveOpportunityIntelligenceAiProfileClient,
  resolveOpportunityIntelligenceProfile,
} from './ai-config.js';
import {
  applicationUpdatesFromPayload,
  commitApplicationIfCurrent,
} from './application-concurrency.js';
import {
  cancelStaleOpportunityIntelligenceTasks,
  recordAgentAudit,
  syncApplicationWorkflowTasks,
  syncRecommendedOpportunityDecisionTasks,
} from './application-workflow.js';
import { bumpOpportunityChangeFeed } from './change-feed.js';
import { getDbConfig } from './db.js';
import {
  llmJsonParseDiagnostics,
  parseJsonObjectFromText,
  requireJsonObjectFromText,
} from './llm-json.js';
import { processOpportunityWithLlm } from './opportunity-details.js';
import { resolveOpportunityScoringConfig } from './opportunity-intelligence-config.js';
import {
  attachOpportunityIntelligenceInvocationMetadata,
  executeGovernedOpportunityIntelligenceRequest,
  finishOpportunityIntelligenceAgentRun,
  type OpportunityIntelligenceGovernanceStore,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import {
  countOpportunityInputTokens,
  inputTokenCeilingForModel,
} from './opportunity-posting-preparation.js';
import {
  attributableOpportunityScoringReasons,
  buildBoundedOpportunityScoringRequest,
  deterministicOpportunityScore,
  OPPORTUNITY_SCORING_INPUT_VERSION,
  OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT,
  OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH,
  OPPORTUNITY_SCORING_MAX_REQUIREMENTS,
  OPPORTUNITY_SCORING_MAX_SOURCES_PER_REQUIREMENT,
  OPPORTUNITY_SCORING_OUTPUT_SCHEMA_VERSION,
  OPPORTUNITY_SCORING_PROMPT_VERSION,
  type OpportunityScoringEvidenceSource,
  type OpportunityScoringReason,
  preScoreOpportunity,
  scoringReason,
  validatePreparedPostingForScoring,
} from './opportunity-scoring.js';
import { opportunityWithSourceContent } from './opportunity-source-content.js';
import { getCollection } from './smrt.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};
type OpportunityIntelligenceDatabase = Awaited<
  ReturnType<typeof resolveDatabase>
>;
type Collection = {
  create: (payload: Record<string, unknown>) => Promise<MutableRecord>;
  get: (id: string) => Promise<MutableRecord | null>;
  list: (options?: Record<string, unknown>) => Promise<MutableRecord[]>;
};

export const opportunityIntelligenceModes = [
  'extract',
  'score',
  'evidence',
  'plan',
  'research',
  'quality',
  'all',
] as const;

export type OpportunityIntelligenceMode =
  (typeof opportunityIntelligenceModes)[number];

export type OpportunityRecommendation =
  | 'maybe'
  | 'needs_research'
  | 'recommend'
  | 'reject'
  | 'unknown';

export interface OpportunityEvidenceMatch {
  requirement: string;
  status: 'gap' | 'supported';
  sources: Array<{
    excerpt: string;
    id: string;
    kind: string;
    title: string;
  }>;
}

export interface OpportunityReasonJson {
  confidence: number;
  dataQualityWarnings: string[];
  evidenceMatrix: OpportunityEvidenceMatch[];
  fitReasons: string[];
  missingInfo: string[];
  risks: string[];
  scoring?: OpportunityScoringReason;
  suggestedNextAction: string;
}

export interface NormalizedOpportunityScore {
  confidence: number;
  dataQualityWarnings: string[];
  fitReasons: string[];
  missingInfo: string[];
  recommendation: OpportunityRecommendation;
  risks: string[];
  score: number | null;
  suggestedNextAction: string;
  summary: string;
}

export interface OpportunityIntelligenceOptions {
  agentRunId?: string;
  aiClient?: Pick<AIInterface, 'chat'>;
  apiKey?: string;
  applicationId?: string;
  /**
   * A caller that owns a lifecycle lock can fence mutations without holding a
   * transaction across the model request itself.
   */
  assertWriteAllowed?: () => void;
  baseUrl?: string;
  expectedSourceContentFingerprint?: string;
  governanceStore?: OpportunityIntelligenceGovernanceStore;
  model?: string;
  modes: OpportunityIntelligenceMode | OpportunityIntelligenceMode[];
  opportunityId: string;
  profile?: string;
  runLifecycleMutation?: <T>(
    action: (database: OpportunityIntelligenceDatabase) => Promise<T>,
  ) => Promise<T>;
  signal?: AbortSignal;
  sourceContentVersion?: number;
  sourceCrawlId?: string;
  sourceCrawlItemId?: string;
  sourceId?: string;
  timeout?: number;
  user?: Pick<User, 'id'> | null;
}

async function runLifecycleMutation<T>(
  options: OpportunityIntelligenceOptions,
  action: (database?: OpportunityIntelligenceDatabase) => Promise<T>,
): Promise<T> {
  if (!options.runLifecycleMutation) return await action();
  return await options.runLifecycleMutation(
    async (database) => await action(database),
  );
}

interface OpportunityIntelligenceStepResult {
  agentRunId?: string;
  evaluationScoreId?: string;
  message: string;
  mode: Exclude<OpportunityIntelligenceMode, 'all'>;
  skipReason?: 'prerequisite' | 'stale';
  status: 'error' | 'processed' | 'skipped';
}

interface EvidenceSource extends OpportunityScoringEvidenceSource {}

const processOrder: Array<Exclude<OpportunityIntelligenceMode, 'all'>> = [
  'extract',
  'score',
  'evidence',
  'quality',
  'research',
  'plan',
];
const automaticProcessModes: Array<
  Exclude<OpportunityIntelligenceMode, 'all' | 'plan' | 'research'>
> = ['extract', 'score', 'evidence', 'quality'];

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function opportunityMatchesExpectedSource(
  opportunity: Record<string, unknown>,
  options: OpportunityIntelligenceOptions,
): boolean {
  const expected = stringValue(options.expectedSourceContentFingerprint);
  const expectedVersion = Math.max(
    0,
    Math.trunc(numberValue(options.sourceContentVersion) ?? 0),
  );
  return (
    (!expected ||
      stringValue(opportunity.sourceContentFingerprint) === expected) &&
    (expectedVersion === 0 ||
      Math.max(
        0,
        Math.trunc(numberValue(opportunity.sourceContentVersion) ?? 0),
      ) === expectedVersion)
  );
}

function opportunityIntelligenceProvenance(
  options: OpportunityIntelligenceOptions,
): Record<string, unknown> {
  return compactRecord({
    contentFingerprint: options.expectedSourceContentFingerprint,
    contentVersion: options.sourceContentVersion,
    sourceCrawlId: options.sourceCrawlId,
    sourceCrawlItemId: options.sourceCrawlItemId,
    sourceId: options.sourceId,
  });
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function textList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map(stringValue)
    : stringValue(value).split(/\r?\n|,/);
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of raw.map((entry) => entry.trim()).filter(Boolean)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(item);
  }
  return values;
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return textList(value);
  return textList(stringValue(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeOpportunityScoreValue(value: unknown): number | null {
  const score = numberValue(value);
  if (score === null) return null;
  const normalized = score > 0 && score <= 10 ? score * 10 : score;
  return Math.round(clamp(normalized, 0, 100));
}

export function normalizeOpportunityConfidence(value: unknown): number {
  const confidence = numberValue(value);
  if (confidence === null) return 0;
  const normalized = confidence > 1 ? confidence / 100 : confidence;
  return Number(clamp(normalized, 0, 1).toFixed(2));
}

export function normalizeOpportunityRecommendation(
  value: unknown,
  score: number | null = null,
): OpportunityRecommendation {
  const text = stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (
    [
      'apply',
      'high_confidence_apply',
      'high_confidence_recommend',
      'recommend',
      'recommended',
      'yes',
    ].includes(text)
  ) {
    return 'recommend';
  }
  if (['needs_research', 'research', 'more_research'].includes(text)) {
    return 'needs_research';
  }
  if (['maybe', 'defer', 'neutral', 'hold'].includes(text)) return 'maybe';
  if (['no', 'reject', 'skip', 'weak', 'pass'].includes(text)) return 'reject';
  if (
    [
      'insufficient_data',
      'insufficient_info',
      'n_a',
      'na',
      'not_enough_info',
      'unclear',
      'unknown',
    ].includes(text)
  ) {
    return 'unknown';
  }
  if (score !== null) {
    if (score >= 75) return 'recommend';
    if (score >= 45) return 'maybe';
    return 'reject';
  }
  return 'unknown';
}

export function normalizeOpportunityScoreOutput(
  output: unknown,
): NormalizedOpportunityScore {
  const record = unknownRecord(output);
  const score = normalizeOpportunityScoreValue(record.score);
  const recommendation = normalizeOpportunityRecommendation(
    record.recommendation ?? record.suggestedDecision,
    score,
  );
  return {
    confidence: normalizeOpportunityConfidence(record.confidence),
    dataQualityWarnings: normalizeStringList(
      record.dataQualityWarnings ?? record.qualityWarnings,
    ),
    fitReasons: normalizeStringList(record.fitReasons ?? record.reasons),
    missingInfo: normalizeStringList(record.missingInfo ?? record.missing),
    recommendation,
    risks: normalizeStringList(record.risks),
    score,
    suggestedNextAction: stringValue(record.suggestedNextAction),
    summary: stringValue(record.summary),
  };
}

export function reasonJsonForScore(
  score: NormalizedOpportunityScore,
  evidenceMatrix: OpportunityEvidenceMatch[] = [],
  scoring?: OpportunityScoringReason,
): string {
  const reason: OpportunityReasonJson = {
    confidence: score.confidence,
    dataQualityWarnings: score.dataQualityWarnings,
    evidenceMatrix,
    fitReasons: score.fitReasons,
    missingInfo: score.missingInfo,
    risks: score.risks,
    ...(scoring ? { scoring } : {}),
    suggestedNextAction: score.suggestedNextAction,
  };
  return JSON.stringify(reason, null, 2);
}

export function parseOpportunityReasonJson(
  value: unknown,
): OpportunityReasonJson {
  const record = unknownRecord(
    typeof value === 'string' && value.trim()
      ? parseJsonObjectFromText(value)
      : value,
  );
  const scoringRecord = unknownRecord(record.scoring);
  const scoringInput = unknownRecord(scoringRecord.input);
  const scoring =
    scoringInput.version === OPPORTUNITY_SCORING_INPUT_VERSION &&
    scoringRecord.promptVersion === OPPORTUNITY_SCORING_PROMPT_VERSION
      ? (scoringRecord as unknown as OpportunityScoringReason)
      : undefined;
  return {
    confidence: normalizeOpportunityConfidence(record.confidence),
    dataQualityWarnings: normalizeStringList(record.dataQualityWarnings),
    evidenceMatrix: jsonArray(record.evidenceMatrix).map((entry) => {
      const source = unknownRecord(entry);
      return {
        requirement: stringValue(source.requirement),
        sources: jsonArray(source.sources).map((rawSource) => {
          const evidence = unknownRecord(rawSource);
          return {
            excerpt: stringValue(evidence.excerpt),
            id: stringValue(evidence.id),
            kind: stringValue(evidence.kind),
            title: stringValue(evidence.title),
          };
        }),
        status:
          stringValue(source.status) === 'supported' ? 'supported' : 'gap',
      };
    }),
    fitReasons: normalizeStringList(record.fitReasons),
    missingInfo: normalizeStringList(record.missingInfo),
    risks: normalizeStringList(record.risks),
    ...(scoring ? { scoring } : {}),
    suggestedNextAction: stringValue(record.suggestedNextAction),
  };
}

export function statusForOpportunityRecommendation(options: {
  confidence: number;
  currentStatus?: unknown;
  recommendation: OpportunityRecommendation;
  score: number | null;
}): 'found' | 'recommended' | null {
  const currentStatus = stringValue(options.currentStatus);
  if (
    [
      'apply',
      'applied',
      'archived',
      'interviewing',
      'offer',
      'rejected',
    ].includes(currentStatus)
  ) {
    return null;
  }
  const highConfidenceApply =
    options.recommendation === 'recommend' &&
    (options.score ?? 0) >= 75 &&
    options.confidence >= 0.7;
  if (highConfidenceApply) return 'recommended';
  if (currentStatus === 'recommended') return 'found';
  return null;
}

async function collection(className: string): Promise<Collection> {
  return (await getCollection(className)) as unknown as Collection;
}

async function optionalList(
  className: string,
  options?: Record<string, unknown>,
): Promise<MutableRecord[]> {
  try {
    return await (await collection(className)).list(options);
  } catch {
    return [];
  }
}

async function optionalGet(
  className: string,
  id: string,
): Promise<MutableRecord | null> {
  try {
    return await (await collection(className)).get(id);
  } catch {
    return null;
  }
}

async function resolveSettings(
  options: OpportunityIntelligenceOptions,
  feature: string,
  defaultProfile = 'opportunity-intelligence',
): Promise<AiProfileClient | null> {
  const clientOptions = {
    aiClient: options.aiClient,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    timeout: options.timeout,
    usageTags: { feature },
  };
  return defaultProfile === 'opportunity-intelligence'
    ? await resolveOpportunityIntelligenceAiProfileClient(clientOptions)
    : await resolveAiProfileClient(defaultProfile, clientOptions);
}

async function requestJson(
  settings: AiProfileClient,
  messages: AIMessage[],
  label: string,
  options: {
    estimatedInputTokens?: number;
    governance?: {
      identity: Parameters<
        typeof executeGovernedOpportunityIntelligenceRequest<
          Record<string, unknown>
        >
      >[0]['identity'];
      store?: OpportunityIntelligenceGovernanceStore;
    };
    maxTokens: number;
    inputTokenCeiling?: number;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const inputTokenCeiling =
    options.inputTokenCeiling ?? inputTokenCeilingForModel(settings.model);
  const estimatedInputTokens =
    options.estimatedInputTokens ??
    (await countOpportunityInputTokens(
      messages,
      settings.model,
      settings.aiClient.countTokens
        ? settings.aiClient.countTokens.bind(settings.aiClient)
        : undefined,
    ));
  if (estimatedInputTokens > inputTokenCeiling && !options.governance) {
    throw new Error(
      `${label} requires ${estimatedInputTokens} input tokens, above the ${inputTokenCeiling}-token ceiling.`,
    );
  }
  const chatOptions: ChatOptions = {
    maxTokens: options.maxTokens,
    reasoning: { maxTokens: 1_024 },
    responseFormat: { type: 'json_object' },
    signal: options.signal,
    temperature: 0,
    timeout: settings.timeout,
  };
  if (settings.model) chatOptions.model = settings.model;
  const invoke = async (requestId = '') => {
    const response = await settings.aiClient.chat(messages, {
      ...chatOptions,
      ...(requestId ? { user: requestId } : {}),
    });
    const content = stringValue(response.content);
    if (!content) throw new Error(`${label} returned an empty response.`);
    const responseMetadata = response as unknown as Record<string, unknown>;
    const providerRequestId =
      stringValue(
        responseMetadata.providerRequestId ??
          responseMetadata.requestId ??
          responseMetadata.id,
      ) || requestId;
    let output: Record<string, unknown>;
    try {
      output = requireJsonObjectFromText(content, label);
    } catch (error) {
      throw attachOpportunityIntelligenceInvocationMetadata(error, {
        providerRequestId,
        usage: response.usage,
      });
    }
    return {
      output,
      providerRequestId,
      usage: response.usage,
    };
  };
  if (!options.governance) return (await invoke()).output;
  return (
    await executeGovernedOpportunityIntelligenceRequest({
      estimatedInputTokens,
      identity: options.governance.identity,
      inputTokenCeiling,
      invoke,
      maxOutputTokens: options.maxTokens,
      signal: options.signal,
      store: options.governance.store,
    })
  ).output;
}

async function recordOpportunityAudit(options: {
  application?: Record<string, unknown>;
  error?: string;
  input?: Record<string, unknown>;
  opportunityId: string;
  output?: Record<string, unknown>;
  runType: string;
  sourceId?: string;
  status: string;
  taskId?: string;
  user?: Pick<User, 'id'> | null;
}): Promise<Record<string, unknown>> {
  try {
    return await recordAgentAudit({
      application: options.application ?? {
        opportunityId: options.opportunityId,
        sourceId: options.sourceId ?? options.input?.sourceId,
      },
      error: options.error,
      input: options.input,
      output: options.output,
      runType: options.runType,
      status: options.status,
      taskId: options.taskId,
      user: options.user,
    });
  } catch {
    return {};
  }
}

function sourceTextForOpportunity(
  opportunity: Record<string, unknown>,
): string {
  return (
    stringValue(opportunity.descriptionRaw) ||
    stringValue(opportunity.descriptionSummary)
  );
}

function compactOpportunity(opportunity: Record<string, unknown>) {
  return Object.fromEntries(
    [
      'title',
      'postingUrl',
      'canonicalUrl',
      'applyMethod',
      'applyUrl',
      'applyInstructions',
      'employmentType',
      'seniority',
      'workMode',
      'locations',
      'locationNotes',
      'salaryMin',
      'salaryMax',
      'currency',
      'hourlyMin',
      'hourlyMax',
      'equityMinPercent',
      'equityMaxPercent',
      'compNotes',
      'requiredSkills',
      'preferredSkills',
      'domainTags',
      'roleTags',
      'greenfieldSignal',
      'founderSignal',
      'relocationSupported',
      'visaOrEorPossible',
      'descriptionSummary',
    ]
      .map((key) => [key, opportunity[key]] as const)
      .filter(([, value]) => {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string') return Boolean(value.trim());
        return true;
      }),
  );
}

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'string') return Boolean(value.trim());
      return true;
    }),
  );
}

function evidenceSourceText(source: EvidenceSource): string {
  return `${source.title}\n${source.text}`.toLowerCase();
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only the candidate's own background can satisfy a skill requirement. Company
// research describes the employer (its stack, stage, concerns), so a skill named
// there must never mask a genuine candidate gap — e.g. "Python" appearing in a
// company's tech summary should not count as the candidate having Python.
const CANDIDATE_EVIDENCE_KINDS = new Set([
  'achievement',
  'candidate_profile',
  'fact_candidate',
  'resume_skill',
]);

function candidateEvidence(sources: EvidenceSource[]): EvidenceSource[] {
  return sources.filter((source) => CANDIDATE_EVIDENCE_KINDS.has(source.kind));
}

function matchRequirement(
  requirement: string,
  sources: EvidenceSource[],
  maxSources = OPPORTUNITY_SCORING_MAX_SOURCES_PER_REQUIREMENT,
): OpportunityEvidenceMatch {
  const normalizedRequirement = normalizeMatchText(requirement);
  const tokens = normalizedRequirement
    .split(' ')
    .filter((token) => token.length > 2);
  const matched = sources
    .map((source, index) => ({ index, source }))
    .filter(({ source }) => {
      const text = normalizeMatchText(evidenceSourceText(source));
      return (
        text.includes(normalizedRequirement) ||
        (tokens.length > 0 &&
          tokens.every((token) => text.includes(normalizeMatchText(token))))
      );
    })
    .sort(
      (left, right) =>
        left.source.kind.localeCompare(right.source.kind) ||
        left.source.id.localeCompare(right.source.id) ||
        left.source.title.localeCompare(right.source.title) ||
        left.index - right.index,
    )
    .slice(0, Math.max(0, maxSources))
    .map(({ source }) => ({
      excerpt:
        source.text.length > OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH
          ? `${source.text.slice(0, OPPORTUNITY_SCORING_MAX_EXCERPT_LENGTH - 3)}...`
          : source.text,
      id: source.id,
      kind: source.kind,
      title: source.title,
    }));

  return {
    requirement,
    sources: matched,
    status: matched.length > 0 ? 'supported' : 'gap',
  };
}

async function loadEvidenceSources(
  opportunity: MutableRecord,
): Promise<EvidenceSource[]> {
  const organizationProfileId = stringValue(opportunity.organizationProfileId);
  const opportunityId = stringValue(opportunity.id);
  const [
    factCandidates,
    achievements,
    resumeSkills,
    profiles,
    companyResearch,
  ] = await Promise.all([
    optionalList('FactCandidate', {
      limit: 200,
      orderBy: 'updated_at DESC',
      where: { reviewStatus: 'accepted' },
    }),
    optionalList('Achievement', { limit: 200, orderBy: 'sortOrder ASC' }),
    optionalList('ResumeSkill', { limit: 200, orderBy: 'sortOrder ASC' }),
    optionalList('CandidateProfile', {
      limit: 25,
      orderBy: 'isDefault DESC, updated_at DESC',
    }),
    organizationProfileId
      ? optionalList('CompanyResearch', {
          limit: 25,
          orderBy: 'updated_at DESC',
          where: { organizationProfileId },
        })
      : Promise.resolve([]),
  ]);

  const sources: EvidenceSource[] = [];
  for (const candidate of factCandidates) {
    const targetEntityId = stringValue(candidate.targetEntityId);
    const targetEntityType = stringValue(candidate.targetEntityType);
    if (
      targetEntityId &&
      targetEntityId !== opportunityId &&
      targetEntityId !== organizationProfileId &&
      targetEntityType !== 'CandidateProfile'
    ) {
      continue;
    }
    sources.push({
      id: stringValue(candidate.id),
      kind: 'fact_candidate',
      text:
        stringValue(candidate.editedStatement) ||
        stringValue(candidate.statement) ||
        stringValue(candidate.sourceExcerpt),
      title: 'Reviewed fact',
    });
  }
  for (const achievement of achievements) {
    sources.push({
      id: stringValue(achievement.id),
      kind: 'achievement',
      text: [achievement.title, achievement.body, achievement.metric]
        .map(stringValue)
        .filter(Boolean)
        .join('\n'),
      title: stringValue(achievement.title) || 'Achievement',
    });
  }
  for (const skill of resumeSkills) {
    sources.push({
      id: stringValue(skill.id),
      kind: 'resume_skill',
      text: stringValue(skill.label),
      title: stringValue(skill.label) || 'Resume skill',
    });
  }
  for (const profile of profiles.slice(0, 5)) {
    sources.push({
      id: stringValue(profile.id),
      kind: 'candidate_profile',
      text: [profile.title, profile.summary].map(stringValue).join('\n'),
      title: stringValue(profile.name) || 'Candidate profile',
    });
  }
  for (const research of companyResearch) {
    sources.push({
      id: stringValue(research.id),
      kind: 'company_research',
      text: [
        research.productSummary,
        research.technicalSummary,
        research.whyInteresting,
        research.concerns,
        research.remotePolicy,
        research.stage,
      ]
        .map(stringValue)
        .filter(Boolean)
        .join('\n'),
      title: 'Company research',
    });
  }
  return sources.filter((source) => stringValue(source.text));
}

function buildEvidenceMatrix(
  opportunity: MutableRecord,
  sources: EvidenceSource[],
): OpportunityEvidenceMatch[] {
  const candidateSources = candidateEvidence(sources);
  const requirements = [
    ...textList(opportunity.requiredSkills),
    ...textList(opportunity.preferredSkills),
  ].slice(0, OPPORTUNITY_SCORING_MAX_REQUIREMENTS);
  let remainingEvidence = OPPORTUNITY_SCORING_MAX_EVIDENCE_COUNT;
  return requirements.map((requirement) => {
    const match = matchRequirement(
      requirement,
      candidateSources,
      Math.min(
        OPPORTUNITY_SCORING_MAX_SOURCES_PER_REQUIREMENT,
        remainingEvidence,
      ),
    );
    remainingEvidence -= match.sources.length;
    return match;
  });
}

function latestRecord(records: MutableRecord[]): MutableRecord | null {
  return records[0] ?? null;
}

async function latestEvaluationScore(
  opportunityId: string,
  expectedSourceContentFingerprint = '',
): Promise<MutableRecord | null> {
  return latestRecord(
    await (await collection('EvaluationScore')).list({
      limit: 1,
      orderBy: 'updated_at DESC',
      where: {
        opportunityId,
        ...(expectedSourceContentFingerprint
          ? { sourceContentFingerprint: expectedSourceContentFingerprint }
          : {}),
      },
    }),
  );
}

async function latestApplication(
  opportunityId: string,
  applicationId = '',
): Promise<MutableRecord | null> {
  if (applicationId) {
    const application = await optionalGet('Application', applicationId);
    if (!application) return null;
    return stringValue(application.opportunityId) === opportunityId
      ? application
      : null;
  }
  return latestRecord(
    await optionalList('Application', {
      limit: 1,
      orderBy: 'updated_at DESC',
      where: { opportunityId },
    }),
  );
}

export async function applyRecommendationSideEffects(options: {
  expectedSourceContentFingerprint?: string;
  expectedSourceContentVersion?: number;
  opportunity: MutableRecord;
  score: NormalizedOpportunityScore;
}): Promise<boolean> {
  const status = statusForOpportunityRecommendation({
    confidence: options.score.confidence,
    currentStatus: options.opportunity.status,
    recommendation: options.score.recommendation,
    score: options.score.score,
  });
  if (status) {
    const expected = stringValue(options.expectedSourceContentFingerprint);
    const expectedVersion = Math.max(
      0,
      Math.trunc(numberValue(options.expectedSourceContentVersion) ?? 0),
    );
    const expectedStatus = stringValue(options.opportunity.status);
    const database = await resolveDatabase(getDbConfig());
    const result = await database.update(
      'opportunities',
      Object.fromEntries([
        ['id', stringValue(options.opportunity.id)],
        ['source_content_fingerprint', expected],
        ...(expectedVersion > 0
          ? ([['source_content_version', expectedVersion]] as const)
          : []),
        ['status', expectedStatus],
      ]),
      Object.fromEntries([
        ['status', status],
        ['updated_at', new Date()],
      ]),
    );
    if (result.affected === 0) {
      const current = await getOpportunity(stringValue(options.opportunity.id));
      if (
        !current ||
        stringValue(current.sourceContentFingerprint) !== expected ||
        (expectedVersion > 0 &&
          Math.max(
            0,
            Math.trunc(numberValue(current.sourceContentVersion) ?? 0),
          ) !== expectedVersion)
      ) {
        return false;
      }
      options.opportunity = current;
      return true;
    }
    await bumpOpportunityChangeFeed(database, [
      stringValue(options.opportunity.id),
    ]);
    options.opportunity.status = status;
  }
  if (
    status === 'recommended' ||
    stringValue(options.opportunity.status) === 'recommended'
  ) {
    await syncRecommendedOpportunityDecisionTasks();
  } else if (status === 'found') {
    await syncRecommendedOpportunityDecisionTasks();
  }
  return true;
}

async function runExtract(
  opportunityId: string,
  options: OpportunityIntelligenceOptions,
): Promise<OpportunityIntelligenceStepResult> {
  const result = await processOpportunityWithLlm(opportunityId, options);
  return {
    message: result.message,
    mode: 'extract',
    skipReason: result.status === 'skipped' ? 'stale' : undefined,
    status:
      result.status === 'processed'
        ? 'processed'
        : result.status === 'skipped'
          ? 'skipped'
          : 'error',
  };
}

async function runScore(
  opportunity: MutableRecord,
  options: OpportunityIntelligenceOptions,
): Promise<OpportunityIntelligenceStepResult> {
  const opportunityId = stringValue(opportunity.id);
  const preparedValidation = validatePreparedPostingForScoring({
    expectedSourceContentFingerprint: options.expectedSourceContentFingerprint,
    expectedSourceContentVersion: options.sourceContentVersion,
    opportunity,
  });
  if (preparedValidation.kind !== 'ready') {
    return {
      message: preparedValidation.message,
      mode: 'score',
      skipReason:
        preparedValidation.kind === 'stale' ? 'stale' : 'prerequisite',
      status: 'skipped',
    };
  }

  const scoreSourceFingerprint =
    stringValue(options.expectedSourceContentFingerprint) ||
    stringValue(opportunity.sourceContentFingerprint) ||
    preparedValidation.prepared.provenance.sourceContentFingerprint ||
    preparedValidation.prepared.fingerprint;
  const scoreSourceVersion =
    Math.max(0, Math.trunc(numberValue(options.sourceContentVersion) ?? 0)) ||
    Math.max(
      0,
      Math.trunc(numberValue(opportunity.sourceContentVersion) ?? 0),
    ) ||
    preparedValidation.prepared.provenance.sourceContentVersion;
  const scoringOptions: OpportunityIntelligenceOptions = {
    ...options,
    expectedSourceContentFingerprint: scoreSourceFingerprint,
    sourceContentVersion: scoreSourceVersion,
  };
  let auditInput = compactRecord({
    ...opportunityIntelligenceProvenance(scoringOptions),
    opportunityId,
    scoringInputVersion: OPPORTUNITY_SCORING_INPUT_VERSION,
  });
  try {
    const policy = resolveOpportunityScoringConfig();
    const evidenceSources = candidateEvidence(
      await loadEvidenceSources(opportunityWithSourceContent(opportunity)),
    );
    let request = await buildBoundedOpportunityScoringRequest({
      evidenceSources,
      inputTokenCeiling: policy.inputTokenCeiling,
      model: resolveOpportunityIntelligenceProfile().model,
      opportunity,
      policy,
      prepared: preparedValidation.prepared,
    });
    let decision = preScoreOpportunity(request.input);
    const existingScore = await latestEvaluationScore(
      opportunityId,
      scoreSourceFingerprint,
    );
    if (existingScore && stringValue(existingScore.createdByProfileId)) {
      return {
        evaluationScoreId: stringValue(existingScore.id),
        message:
          'The current evaluation is human-owned; automation scoring was skipped.',
        mode: 'score',
        skipReason: 'prerequisite',
        status: 'skipped',
      };
    }
    let settings: AiProfileClient | null = null;
    if (decision.modelEligible && policy.modelEnabled) {
      settings = await resolveSettings(options, 'admin-opportunity-llm-score');
      if (!settings) {
        const message =
          'Configure the dedicated key for the explicitly selected opportunity-intelligence profile before optional model scoring.';
        auditInput = compactRecord({
          ...auditInput,
          decision: decision.kind,
          evidenceCount: request.input.evidenceCount,
          inputFingerprint: request.input.fingerprint,
          inputTokenCeiling: request.inputTokenCeiling,
          inputTokenCount: request.inputTokenCount,
          modelScoringEnabled: policy.modelEnabled,
          promptVersion: OPPORTUNITY_SCORING_PROMPT_VERSION,
        });
        const run = await recordOpportunityAudit({
          error: message,
          input: auditInput,
          opportunityId,
          runType: 'opportunity_llm_score',
          status: 'failed',
          user: options.user,
        });
        return {
          agentRunId: stringValue(run.id),
          message,
          mode: 'score',
          status: 'error',
        };
      }
      request = await buildBoundedOpportunityScoringRequest({
        counter: settings.aiClient.countTokens
          ? settings.aiClient.countTokens.bind(settings.aiClient)
          : undefined,
        evidenceSources,
        inputTokenCeiling: policy.inputTokenCeiling,
        model: settings.model,
        opportunity,
        policy,
        prepared: preparedValidation.prepared,
      });
      decision = preScoreOpportunity(request.input);
    }
    const modelInvoked = Boolean(
      settings && decision.modelEligible && policy.modelEnabled,
    );
    auditInput = compactRecord({
      ...auditInput,
      decision: decision.kind,
      evidenceCount: request.input.evidenceCount,
      inputFingerprint: request.input.fingerprint,
      inputTokenCeiling: request.inputTokenCeiling,
      inputTokenCount: request.inputTokenCount,
      model: modelInvoked ? settings?.model : '',
      modelInvoked,
      modelScoringEnabled: policy.modelEnabled,
      outputSchemaVersion: OPPORTUNITY_SCORING_OUTPUT_SCHEMA_VERSION,
      preparedPostingFingerprint: preparedValidation.prepared.fingerprint,
      preparedPostingVersion: preparedValidation.prepared.version,
      profile: modelInvoked ? settings?.profile : 'deterministic',
      promptVersion: OPPORTUNITY_SCORING_PROMPT_VERSION,
      provider: modelInvoked ? settings?.provider : 'deterministic',
    });

    const existingReason = parseOpportunityReasonJson(
      existingScore?.reasonJson,
    );
    if (
      existingScore &&
      !stringValue(existingScore.createdByProfileId) &&
      existingReason.scoring?.input.fingerprint === request.input.fingerprint &&
      existingReason.scoring.modelInvoked === modelInvoked &&
      existingReason.scoring.model === (modelInvoked ? settings?.model : '')
    ) {
      return {
        evaluationScoreId: stringValue(existingScore.id),
        message: 'Reused the current idempotent opportunity score.',
        mode: 'score',
        status: 'processed',
      };
    }

    let score: NormalizedOpportunityScore;
    if (modelInvoked && settings) {
      if (!options.aiClient && !options.agentRunId) {
        throw new Error(
          'Governed opportunity scoring requires an AgentRun reservation owner.',
        );
      }
      const output = await requestJson(
        settings,
        request.messages,
        'LLM scoring',
        {
          estimatedInputTokens: request.inputTokenCount,
          governance: !options.aiClient
            ? {
                identity: {
                  agentRunId: stringValue(options.agentRunId),
                  contentFingerprint: scoreSourceFingerprint,
                  feature: 'opportunity-score',
                  inputFingerprint: request.input.fingerprint,
                  model: settings.model,
                  opportunityId,
                  outputSchemaVersion:
                    OPPORTUNITY_SCORING_OUTPUT_SCHEMA_VERSION,
                  preparedPayloadVersion: preparedValidation.prepared.version,
                  profile: settings.profile,
                  promptVersion: OPPORTUNITY_SCORING_PROMPT_VERSION,
                  sourceCrawlId: options.sourceCrawlId,
                  sourceCrawlItemId: options.sourceCrawlItemId,
                },
                store: options.governanceStore,
              }
            : undefined,
          inputTokenCeiling: request.inputTokenCeiling,
          maxTokens: 2_048,
          signal: options.signal,
        },
      );
      score = normalizeOpportunityScoreOutput(output);
      const attributable = attributableOpportunityScoringReasons(request);
      score.fitReasons = [
        ...new Set([...score.fitReasons, ...attributable.fitReasons]),
      ];
      score.missingInfo = [
        ...new Set([...score.missingInfo, ...attributable.missingInfo]),
      ];
      score.dataQualityWarnings = [
        ...new Set([
          ...score.dataQualityWarnings,
          ...attributable.dataQualityWarnings,
        ]),
      ];
    } else {
      score = normalizeOpportunityScoreOutput(
        deterministicOpportunityScore(request, decision),
      );
    }

    const currentOpportunity = await getOpportunity(opportunityId);
    if (
      !currentOpportunity ||
      !opportunityMatchesExpectedSource(currentOpportunity, scoringOptions)
    ) {
      const run = await recordOpportunityAudit({
        input: auditInput,
        opportunityId,
        output: {
          decision: decision.kind,
          discardedAsStale: true,
          inputFingerprint: request.input.fingerprint,
          recommendation: score.recommendation,
          score: score.score,
        },
        runType: 'opportunity_llm_score',
        sourceId: options.sourceId,
        status: 'succeeded',
        user: options.user,
      });
      return {
        agentRunId: stringValue(run.id),
        message: 'Discarded stale opportunity scoring results.',
        mode: 'score',
        skipReason: 'stale',
        status: 'skipped',
      };
    }
    if (currentOpportunity) opportunity = currentOpportunity;
    const scoringProvenance = scoringReason({
      decision,
      model: modelInvoked ? settings?.model : '',
      modelInvoked,
      request,
    });
    const run = await recordOpportunityAudit({
      input: auditInput,
      opportunityId,
      output: {
        confidence: score.confidence,
        decision: decision.kind,
        inputFingerprint: request.input.fingerprint,
        modelInvoked,
        recommendation: score.recommendation,
        score: score.score,
      },
      runType: 'opportunity_llm_score',
      sourceId: options.sourceId,
      status: 'succeeded',
      user: options.user,
    });
    const evaluationScore = await (await collection('EvaluationScore')).create({
      agentRunId: stringValue(run.id),
      createdByProfileId: '',
      opportunityId,
      reasonJson: reasonJsonForScore(
        score,
        request.evidenceMatrix,
        scoringProvenance,
      ),
      recommendation: score.recommendation,
      score: score.score,
      sourceContentFingerprint: scoreSourceFingerprint,
      sourceContentVersion: scoreSourceVersion,
      sourceCrawlId: stringValue(options.sourceCrawlId),
      sourceCrawlItemId: stringValue(options.sourceCrawlItemId),
      sourceId: stringValue(options.sourceId),
      summary: score.summary,
    });
    await evaluationScore.save();
    const latestOpportunity = await getOpportunity(opportunityId);
    if (
      !latestOpportunity ||
      !opportunityMatchesExpectedSource(latestOpportunity, scoringOptions)
    ) {
      return {
        agentRunId: stringValue(run.id),
        evaluationScoreId: stringValue(evaluationScore.id),
        message: 'Discarded stale opportunity scoring results.',
        mode: 'score',
        skipReason: 'stale',
        status: 'skipped',
      };
    }
    if (latestOpportunity) opportunity = latestOpportunity;
    const sideEffectsApplied = await applyRecommendationSideEffects({
      expectedSourceContentFingerprint: scoreSourceFingerprint,
      expectedSourceContentVersion: scoreSourceVersion,
      opportunity,
      score,
    });
    if (!sideEffectsApplied) {
      return {
        agentRunId: stringValue(run.id),
        evaluationScoreId: stringValue(evaluationScore.id),
        message: 'Discarded stale opportunity scoring results.',
        mode: 'score',
        skipReason: 'stale',
        status: 'skipped',
      };
    }
    if (score.recommendation === 'needs_research') {
      const current = await getOpportunity(opportunityId);
      if (
        !current ||
        !opportunityMatchesExpectedSource(current, scoringOptions) ||
        !(await ensureResearchTasks(current, score, scoringOptions))
      ) {
        return {
          agentRunId: stringValue(run.id),
          evaluationScoreId: stringValue(evaluationScore.id),
          message: 'Discarded stale opportunity research task results.',
          mode: 'score',
          skipReason: 'stale',
          status: 'skipped',
        };
      }
    }
    return {
      agentRunId: stringValue(run.id),
      evaluationScoreId: stringValue(evaluationScore.id),
      message: `${modelInvoked ? 'Model-scored' : 'Deterministically scored'} opportunity as ${score.recommendation}.`,
      mode: 'score',
      status: 'processed',
    };
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'LLM scoring failed.';
    const run = await recordOpportunityAudit({
      error: message,
      input: auditInput,
      opportunityId,
      output: llmJsonParseDiagnostics(cause),
      runType: 'opportunity_llm_score',
      status: 'failed',
      user: options.user,
    });
    if (options.signal?.aborted) throw cause;
    return {
      agentRunId: stringValue(run.id),
      message,
      mode: 'score',
      status: 'error',
    };
  }
}

async function runEvidence(
  opportunity: MutableRecord,
  options: OpportunityIntelligenceOptions,
): Promise<OpportunityIntelligenceStepResult> {
  const opportunityId = stringValue(opportunity.id);
  const evaluationScore = await latestEvaluationScore(
    opportunityId,
    stringValue(options.expectedSourceContentFingerprint),
  );
  if (!evaluationScore) {
    return {
      message: 'Score the opportunity before evidence matching.',
      mode: 'evidence',
      skipReason: 'prerequisite',
      status: 'skipped',
    };
  }
  if (stringValue(evaluationScore.createdByProfileId)) {
    return {
      message:
        'The latest evaluation is human-owned; evidence updates were skipped.',
      mode: 'evidence',
      skipReason: 'prerequisite',
      status: 'skipped',
    };
  }

  const intelligenceOpportunity = opportunityWithSourceContent(opportunity);
  const evidenceSources = await loadEvidenceSources(intelligenceOpportunity);
  const evidenceMatrix = buildEvidenceMatrix(
    intelligenceOpportunity,
    evidenceSources,
  );
  const reason = parseOpportunityReasonJson(evaluationScore.reasonJson);
  reason.evidenceMatrix = evidenceMatrix;
  reason.missingInfo = [
    ...new Set([
      ...reason.missingInfo,
      ...evidenceMatrix
        .filter((entry) => entry.status === 'gap')
        .map((entry) => `No reviewed evidence for ${entry.requirement}.`),
    ]),
  ];
  let currentOpportunity = await getOpportunity(opportunityId);
  let stale = Boolean(
    !currentOpportunity ||
      !opportunityMatchesExpectedSource(currentOpportunity, options),
  );
  if (!stale) {
    evaluationScore.reasonJson = JSON.stringify(reason, null, 2);
    await evaluationScore.save();
    currentOpportunity = await getOpportunity(opportunityId);
    stale = Boolean(
      !currentOpportunity ||
        !opportunityMatchesExpectedSource(currentOpportunity, options),
    );
  }
  const run = await recordOpportunityAudit({
    input: compactRecord({
      ...opportunityIntelligenceProvenance(options),
      evaluationScoreId: stringValue(evaluationScore.id),
      opportunityId,
    }),
    opportunityId,
    output: {
      ...(stale ? { discardedAsStale: true } : {}),
      gapCount: evidenceMatrix.filter((entry) => entry.status === 'gap').length,
      requirementCount: evidenceMatrix.length,
    },
    runType: 'opportunity_llm_evidence',
    sourceId: options.sourceId,
    status: 'succeeded',
    user: options.user,
  });

  if (stale) {
    return {
      agentRunId: stringValue(run.id),
      evaluationScoreId: stringValue(evaluationScore.id),
      message: 'Discarded stale opportunity evidence results.',
      mode: 'evidence',
      skipReason: 'stale',
      status: 'skipped',
    };
  }

  return {
    agentRunId: stringValue(run.id),
    evaluationScoreId: stringValue(evaluationScore.id),
    message: `Matched evidence for ${evidenceMatrix.length} requirements.`,
    mode: 'evidence',
    status: 'processed',
  };
}

function qualityWarningsForOpportunity(
  opportunity: MutableRecord,
  reason: OpportunityReasonJson,
): string[] {
  const warnings: string[] = [];
  if (!sourceTextForOpportunity(opportunity)) {
    warnings.push('Posting text is missing.');
  }
  if (!stringValue(opportunity.requiredSkills)) {
    warnings.push('Required skills are missing.');
  }
  const employmentType = stringValue(opportunity.employmentType);
  if (!employmentType || employmentType === 'unknown') {
    warnings.push('Employment type is unknown.');
  }
  const workMode = stringValue(opportunity.workMode);
  if (!workMode || workMode === 'unknown') {
    warnings.push('Work mode is unknown.');
  }
  if (
    numberValue(opportunity.salaryMin) === null &&
    numberValue(opportunity.salaryMax) === null &&
    numberValue(opportunity.hourlyMin) === null &&
    numberValue(opportunity.hourlyMax) === null
  ) {
    warnings.push('Compensation range is missing.');
  }
  const gapCount = reason.evidenceMatrix.filter(
    (entry) => entry.status === 'gap',
  ).length;
  if (gapCount > 0) {
    warnings.push(
      `${gapCount} posting requirements have no reviewed evidence.`,
    );
  }
  return [...new Set([...reason.dataQualityWarnings, ...warnings])];
}

async function runQuality(
  opportunity: MutableRecord,
  options: OpportunityIntelligenceOptions,
): Promise<OpportunityIntelligenceStepResult> {
  const opportunityId = stringValue(opportunity.id);
  const evaluationScore = await latestEvaluationScore(
    opportunityId,
    stringValue(options.expectedSourceContentFingerprint),
  );
  if (!evaluationScore) {
    return {
      message: 'Score the opportunity before quality review.',
      mode: 'quality',
      skipReason: 'prerequisite',
      status: 'skipped',
    };
  }
  if (stringValue(evaluationScore.createdByProfileId)) {
    return {
      message:
        'The latest evaluation is human-owned; quality updates were skipped.',
      mode: 'quality',
      skipReason: 'prerequisite',
      status: 'skipped',
    };
  }

  const reason = parseOpportunityReasonJson(evaluationScore.reasonJson);
  reason.dataQualityWarnings = qualityWarningsForOpportunity(
    opportunityWithSourceContent(opportunity),
    reason,
  );
  let currentOpportunity = await getOpportunity(opportunityId);
  let stale = Boolean(
    !currentOpportunity ||
      !opportunityMatchesExpectedSource(currentOpportunity, options),
  );
  if (!stale) {
    evaluationScore.reasonJson = JSON.stringify(reason, null, 2);
    await evaluationScore.save();
    currentOpportunity = await getOpportunity(opportunityId);
    stale = Boolean(
      !currentOpportunity ||
        !opportunityMatchesExpectedSource(currentOpportunity, options),
    );
  }
  const output = {
    dataQualityWarnings: reason.dataQualityWarnings,
    ...(stale ? { discardedAsStale: true } : {}),
    evaluationScoreId: stringValue(evaluationScore.id),
  };
  const run = await recordOpportunityAudit({
    input: compactRecord({
      ...opportunityIntelligenceProvenance(options),
      opportunityId,
    }),
    opportunityId,
    output,
    runType: 'opportunity_llm_quality',
    sourceId: options.sourceId,
    status: 'succeeded',
    user: options.user,
  });
  if (stale) {
    return {
      agentRunId: stringValue(run.id),
      evaluationScoreId: stringValue(evaluationScore.id),
      message: 'Discarded stale opportunity quality results.',
      mode: 'quality',
      skipReason: 'stale',
      status: 'skipped',
    };
  }
  if (stringValue(evaluationScore.recommendation) === 'needs_research') {
    if (
      !currentOpportunity ||
      !opportunityMatchesExpectedSource(currentOpportunity, options) ||
      !(await ensureResearchTasks(
        currentOpportunity,
        {
          dataQualityWarnings: reason.dataQualityWarnings,
          missingInfo: reason.missingInfo,
          risks: reason.risks,
          suggestedNextAction: reason.suggestedNextAction,
        },
        options,
      ))
    ) {
      return {
        agentRunId: stringValue(run.id),
        evaluationScoreId: stringValue(evaluationScore.id),
        message: 'Discarded stale opportunity research task results.',
        mode: 'quality',
        skipReason: 'stale',
        status: 'skipped',
      };
    }
  }
  return {
    agentRunId: stringValue(run.id),
    evaluationScoreId: stringValue(evaluationScore.id),
    message: `Quality review found ${reason.dataQualityWarnings.length} warnings.`,
    mode: 'quality',
    status: 'processed',
  };
}

async function findTaskByExternalId(externalTaskId: string) {
  const tasks = await collection('Task');
  const records = await tasks.list({
    limit: 25,
    orderBy: 'updated_at DESC',
    where: { externalTaskId },
  });
  return records[0] ?? null;
}

function mergeOpportunityIntelligenceArtifactRefs(
  artifactRefsJson: unknown,
  contentFingerprint: string,
  contentVersion: number,
): string {
  let refs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(stringValue(artifactRefsJson) || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      refs = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed legacy metadata must not prevent task recovery.
  }
  return JSON.stringify({
    ...refs,
    opportunityIntelligence: {
      contentFingerprint,
      contentVersion,
    },
  });
}

async function upsertIntelligenceTask(options: {
  assigneeRole: TaskAssigneeRole;
  description: string;
  externalTaskId: string;
  opportunity: MutableRecord;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  taskType: 'research_company' | 'score_opportunity';
  title: string;
}) {
  const existing = await findTaskByExternalId(options.externalTaskId);
  if (existing) {
    Object.assign(existing, {
      assigneeRole: options.assigneeRole,
      artifactRefsJson: mergeOpportunityIntelligenceArtifactRefs(
        existing.artifactRefsJson,
        options.sourceContentFingerprint,
        options.sourceContentVersion,
      ),
      blockerOwnerRole: '',
      blockerReason: '',
      completedAt: null,
      description: options.description,
      kanbanColumn: 'researching',
      opportunityId: stringValue(options.opportunity.id),
      organizationProfileId: stringValue(
        options.opportunity.organizationProfileId,
      ),
      sourceId: stringValue(options.opportunity.sourceId),
      status: isActiveTaskStatus(existing.status) ? existing.status : 'open',
      taskType: options.taskType,
      title: options.title,
    });
    await existing.save();
    return { created: false, task: existing };
  }

  const task = await (await collection('Task')).create({
    assigneeRole: options.assigneeRole,
    artifactRefsJson: mergeOpportunityIntelligenceArtifactRefs(
      undefined,
      options.sourceContentFingerprint,
      options.sourceContentVersion,
    ),
    createdBy: 'automation',
    description: options.description,
    externalTaskId: options.externalTaskId,
    kanbanColumn: 'researching',
    opportunityId: stringValue(options.opportunity.id),
    organizationProfileId: stringValue(
      options.opportunity.organizationProfileId,
    ),
    sourceId: stringValue(options.opportunity.sourceId),
    status: 'open',
    taskType: options.taskType,
    title: options.title,
  });
  await task.save();
  return { created: true, task };
}

async function ensureResearchTasks(
  opportunity: MutableRecord,
  score: Pick<
    NormalizedOpportunityScore,
    'dataQualityWarnings' | 'missingInfo' | 'risks' | 'suggestedNextAction'
  >,
  provenance: {
    expectedSourceContentFingerprint?: string;
    sourceContentVersion?: number;
  } = {},
): Promise<boolean> {
  const opportunityId = stringValue(opportunity.id);
  const sourceContentFingerprint = stringValue(
    provenance.expectedSourceContentFingerprint,
  );
  const sourceContentVersion = Math.max(
    0,
    Math.trunc(numberValue(provenance.sourceContentVersion) ?? 0),
  );
  const versionSuffix = sourceContentFingerprint
    ? `:${sourceContentFingerprint}`
    : '';
  const matchesProvenance = (current: MutableRecord | null) =>
    Boolean(
      current &&
        (!sourceContentFingerprint ||
          stringValue(current.sourceContentFingerprint) ===
            sourceContentFingerprint) &&
        (sourceContentVersion === 0 ||
          Math.max(
            0,
            Math.trunc(numberValue(current.sourceContentVersion) ?? 0),
          ) === sourceContentVersion),
    );
  const initial = await getOpportunity(opportunityId);
  if (!matchesProvenance(initial)) {
    await cancelStaleOpportunityIntelligenceTasks(
      opportunityId,
      stringValue(initial?.sourceContentFingerprint),
      Math.max(0, Math.trunc(numberValue(initial?.sourceContentVersion) ?? 0)),
    );
    return false;
  }
  const title = stringValue(opportunity.title) || opportunityId;
  const missing = [
    ...score.missingInfo,
    ...score.dataQualityWarnings,
    ...score.risks,
  ];
  await upsertIntelligenceTask({
    assigneeRole: 'hermes',
    description:
      missing.length > 0
        ? missing.map((item) => `- ${item}`).join('\n')
        : stringValue(score.suggestedNextAction) ||
          'Research company, role fit, risks, compensation, and application path.',
    externalTaskId: `company-research:${opportunityId}${versionSuffix}`,
    opportunity,
    sourceContentFingerprint,
    sourceContentVersion,
    taskType: 'research_company',
    title: `Research before decision: ${title}`,
  });
  await upsertIntelligenceTask({
    assigneeRole: 'automation',
    description:
      stringValue(score.suggestedNextAction) ||
      'Re-run scoring after missing details or evidence are available.',
    externalTaskId: `revise-score:${opportunityId}${versionSuffix}`,
    opportunity,
    sourceContentFingerprint,
    sourceContentVersion,
    taskType: 'score_opportunity',
    title: `Revise opportunity score: ${title}`,
  });
  const current = await getOpportunity(opportunityId);
  if (matchesProvenance(current)) {
    await cancelStaleOpportunityIntelligenceTasks(
      opportunityId,
      sourceContentFingerprint,
      sourceContentVersion,
    );
    return true;
  }
  await cancelStaleOpportunityIntelligenceTasks(
    opportunityId,
    stringValue(current?.sourceContentFingerprint),
    Math.max(0, Math.trunc(numberValue(current?.sourceContentVersion) ?? 0)),
  );
  return false;
}

async function runResearch(
  opportunity: MutableRecord,
  options: OpportunityIntelligenceOptions,
): Promise<OpportunityIntelligenceStepResult> {
  const opportunityId = stringValue(opportunity.id);
  const evaluationScore = await latestEvaluationScore(
    opportunityId,
    stringValue(options.expectedSourceContentFingerprint),
  );
  const reason = parseOpportunityReasonJson(evaluationScore?.reasonJson);
  const tasksCurrent = await ensureResearchTasks(
    opportunity,
    {
      dataQualityWarnings: reason.dataQualityWarnings,
      missingInfo: reason.missingInfo,
      risks: reason.risks,
      suggestedNextAction: reason.suggestedNextAction,
    },
    options,
  );
  const run = await recordOpportunityAudit({
    input: compactRecord({
      ...opportunityIntelligenceProvenance(options),
      evaluationScoreId: stringValue(evaluationScore?.id),
      opportunityId,
    }),
    opportunityId,
    output: {
      ...(!tasksCurrent ? { discardedAsStale: true } : {}),
      taskTypes: ['research_company', 'score_opportunity'],
    },
    runType: 'opportunity_llm_research',
    sourceId: options.sourceId,
    status: 'succeeded',
    user: options.user,
  });
  if (!tasksCurrent) {
    return {
      agentRunId: stringValue(run.id),
      evaluationScoreId: stringValue(evaluationScore?.id),
      message: 'Discarded stale opportunity research task results.',
      mode: 'research',
      skipReason: 'stale',
      status: 'skipped',
    };
  }
  return {
    agentRunId: stringValue(run.id),
    evaluationScoreId: stringValue(evaluationScore?.id),
    message: 'Research and scoring tasks are open.',
    mode: 'research',
    status: 'processed',
  };
}

function buildPlanMessages(options: {
  application: MutableRecord;
  evaluationScore: MutableRecord | null;
  opportunity: MutableRecord;
  reason: OpportunityReasonJson;
}): AIMessage[] {
  return [
    {
      role: 'user',
      content: [
        'Plan the application workflow for this accepted recommendation.',
        'Return one JSON object only. Do not wrap it in Markdown or add prose.',
        'Do not draft final resume or cover-letter prose.',
        'Use applyMethod company_site|email|recruiter|platform|referral|other, resumeMode default|generate_tailored|custom|none, coverLetterMode none|generate|custom|default.',
        JSON.stringify({
          // jsonRecord serializes via the SMRT object's toJSON so live
          // internals (_db handles with timers) never reach JSON.stringify.
          application: compactRecord(jsonRecord(options.application)),
          evaluationScore: options.evaluationScore
            ? compactRecord({
                id: options.evaluationScore.id,
                recommendation: options.evaluationScore.recommendation,
                score: options.evaluationScore.score,
                summary: options.evaluationScore.summary,
              })
            : null,
          expectedFields: [
            'applyMethod',
            'resumeMode',
            'coverLetterMode',
            'applicationInstructions',
            'requiredAnswers',
            'dueAt',
            'accountStatus',
            'accountNotes',
          ],
          opportunity: compactOpportunity(options.opportunity),
          reason: options.reason,
        }),
      ].join('\n\n'),
    },
  ];
}

function normalizeApplicationPlan(output: unknown): Record<string, unknown> {
  const record = unknownRecord(output);
  const applyMethod = stringValue(record.applyMethod);
  const resumeMode = stringValue(record.resumeMode);
  const coverLetterMode = stringValue(record.coverLetterMode);
  const dueAt = dateValue(record.dueAt);
  return compactRecord({
    accountNotes: stringValue(record.accountNotes),
    accountStatus: [
      'active',
      'blocked',
      'logged_in',
      'needs_2fa',
      'needs_login',
      'needs_signup',
      'none_needed',
      'unknown',
    ].includes(stringValue(record.accountStatus))
      ? stringValue(record.accountStatus)
      : '',
    applicationInstructions: stringValue(record.applicationInstructions),
    applyMethod: [
      'company_site',
      'email',
      'other',
      'platform',
      'recruiter',
      'referral',
    ].includes(applyMethod)
      ? applyMethod
      : '',
    coverLetterMode: ['custom', 'default', 'generate', 'none'].includes(
      coverLetterMode,
    )
      ? coverLetterMode
      : '',
    dueAt,
    requiredAnswers: stringValue(record.requiredAnswers),
    resumeMode: ['custom', 'default', 'generate_tailored', 'none'].includes(
      resumeMode,
    )
      ? resumeMode
      : '',
  });
}

function assignPlanValue(
  application: MutableRecord,
  key: string,
  value: unknown,
  options: { replaceDefault?: boolean } = {},
): void {
  if (value === null || value === undefined || value === '') return;
  if (key === 'dueAt') {
    if (!application.dueAt) application.dueAt = value;
    return;
  }
  const currentValue = stringValue(application[key]);
  const defaultPlanningValues: Record<string, readonly string[]> = {
    accountStatus: ['unknown'],
    applyMethod: ['company_site'],
    coverLetterMode: ['none'],
    resumeMode: ['default'],
  };
  const defaultValues = defaultPlanningValues[key] ?? [];
  if (
    !currentValue ||
    (options.replaceDefault && defaultValues.includes(currentValue))
  ) {
    application[key] = value;
  }
}

function restoreMutableRecord(
  record: MutableRecord,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(snapshot, key)) delete record[key];
  }
  Object.assign(record, snapshot);
}

function changedApplicationUpdates(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(applicationUpdatesFromPayload(after)).filter(
      ([field, value]) => before[field] !== value,
    ),
  );
}

async function runPlan(
  opportunity: MutableRecord,
  options: OpportunityIntelligenceOptions,
): Promise<OpportunityIntelligenceStepResult> {
  const opportunityId = stringValue(opportunity.id);
  const application = await latestApplication(
    opportunityId,
    options.applicationId,
  );
  if (!application) {
    return {
      message: 'No application exists yet; planning skipped.',
      mode: 'plan',
      skipReason: 'prerequisite',
      status: 'skipped',
    };
  }
  if (applicationMaterialsAreLockedOrLeased(application.status, application)) {
    return {
      message: 'Application materials are locked; planning skipped.',
      mode: 'plan',
      skipReason: 'stale',
      status: 'skipped',
    };
  }
  const evaluationScore = await latestEvaluationScore(
    opportunityId,
    stringValue(options.expectedSourceContentFingerprint),
  );
  const reason = parseOpportunityReasonJson(evaluationScore?.reasonJson);
  const settings = await resolveSettings(
    options,
    'admin-opportunity-llm-plan',
    'good',
  );
  const auditInput = compactRecord({
    applicationId: application.id,
    evaluationScoreId: evaluationScore?.id,
    model: settings?.model ?? '',
    opportunityId,
    profile: settings?.profile ?? 'good',
    provider: settings?.provider ?? 'bifrost',
  });
  if (!settings) {
    const message =
      'Set BIFROST_API_KEY or HAVE_AI_API_KEY before application planning.';
    options.assertWriteAllowed?.();
    const run = await runLifecycleMutation(
      options,
      async () =>
        await recordOpportunityAudit({
          application,
          error: message,
          input: auditInput,
          opportunityId,
          runType: 'opportunity_llm_plan',
          status: 'failed',
          user: options.user,
        }),
    );
    return {
      agentRunId: stringValue(run.id),
      message,
      mode: 'plan',
      status: 'error',
    };
  }

  const applicationBeforePlan = { ...application };
  // SmrtObject keeps id behind an accessor, which object spread omits. The
  // fence needs that public id, while restoration must retain the exact
  // enumerable snapshot that existed before plan normalization.
  const applicationBeforePlanFence = {
    ...applicationBeforePlan,
    id: stringValue(application.id),
  };
  try {
    const output = await requestJson(
      settings,
      buildPlanMessages({ application, evaluationScore, opportunity, reason }),
      'LLM application planning',
      { maxTokens: 4_096, signal: options.signal },
    );
    const plan = normalizeApplicationPlan(output);
    const replaceDefaultPlanningValues = !stringValue(
      application.evaluationScoreId,
    );
    for (const [key, value] of Object.entries(plan)) {
      assignPlanValue(application, key, value, {
        replaceDefault: replaceDefaultPlanningValues,
      });
    }
    if (evaluationScore?.id) {
      application.evaluationScoreId = stringValue(evaluationScore.id);
    }
    if (stringValue(application.status) === 'draft') {
      application.status = 'application_drafting';
    }
    const updates = changedApplicationUpdates(
      applicationBeforePlan,
      application,
    );
    let stale = false;
    let run: Record<string, unknown>;
    try {
      run = await runLifecycleMutation(options, async (database) => {
        options.assertWriteAllowed?.();
        if (
          Object.keys(updates).length > 0 &&
          !(await commitApplicationIfCurrent(
            applicationBeforePlanFence,
            updates,
            database,
          ))
        ) {
          stale = true;
          restoreMutableRecord(application, applicationBeforePlan);
          return {};
        }
        options.assertWriteAllowed?.();
        await syncApplicationWorkflowTasks(application);
        options.assertWriteAllowed?.();
        return await recordOpportunityAudit({
          application,
          input: auditInput,
          opportunityId,
          output: plan,
          runType: 'opportunity_llm_plan',
          status: 'succeeded',
          user: options.user,
        });
      });
    } catch (error) {
      restoreMutableRecord(application, applicationBeforePlan);
      throw error;
    }
    if (stale) {
      return {
        message:
          'Application changed while planning; generated plan was discarded.',
        mode: 'plan',
        skipReason: 'stale',
        status: 'skipped',
      };
    }
    return {
      agentRunId: stringValue(run.id),
      evaluationScoreId: stringValue(evaluationScore?.id),
      message: 'Application planning fields were populated.',
      mode: 'plan',
      status: 'processed',
    };
  } catch (cause) {
    restoreMutableRecord(application, applicationBeforePlan);
    options.assertWriteAllowed?.();
    const message =
      cause instanceof Error
        ? cause.message
        : 'LLM application planning failed.';
    const run = await runLifecycleMutation(
      options,
      async () =>
        await recordOpportunityAudit({
          application,
          error: message,
          input: auditInput,
          opportunityId,
          output: llmJsonParseDiagnostics(cause),
          runType: 'opportunity_llm_plan',
          status: 'failed',
          user: options.user,
        }),
    );
    if (options.signal?.aborted) throw cause;
    return {
      agentRunId: stringValue(run.id),
      message,
      mode: 'plan',
      status: 'error',
    };
  }
}

function expandModes(
  modes: OpportunityIntelligenceMode | OpportunityIntelligenceMode[],
): Array<Exclude<OpportunityIntelligenceMode, 'all'>> {
  const values = Array.isArray(modes) ? modes : [modes];
  const selected = new Set<Exclude<OpportunityIntelligenceMode, 'all'>>();
  if (values.includes('all')) {
    for (const mode of automaticProcessModes) selected.add(mode);
  }
  for (const mode of values) {
    if (mode !== 'all') selected.add(mode);
  }
  return processOrder.filter((mode) => selected.has(mode));
}

async function getOpportunity(
  opportunityId: string,
): Promise<MutableRecord | null> {
  return await (await collection('Opportunity')).get(opportunityId);
}

async function processOpportunityIntelligenceInternal(
  options: OpportunityIntelligenceOptions,
) {
  const opportunityId = stringValue(options.opportunityId);
  const modes = expandModes(options.modes);
  if (!opportunityId) {
    return {
      failed: 1,
      message: 'Opportunity id is required.',
      modes,
      opportunityId,
      results: [],
      status: 'error',
    };
  }

  let opportunity = await getOpportunity(opportunityId);
  if (!opportunity) {
    return {
      failed: 1,
      message: 'Opportunity not found.',
      modes,
      opportunityId,
      results: [],
      status: 'error',
    };
  }
  if (!opportunityMatchesExpectedSource(opportunity, options)) {
    return {
      failed: 0,
      message: 'Skipped stale opportunity intelligence content fingerprint.',
      modes,
      opportunityId,
      results: [],
      stale: true,
      status: 'skipped',
    };
  }

  const results: OpportunityIntelligenceStepResult[] = [];
  for (const mode of modes) {
    options.signal?.throwIfAborted();
    opportunity = (await getOpportunity(opportunityId)) ?? opportunity;
    if (!opportunityMatchesExpectedSource(opportunity, options)) {
      results.push({
        message: 'Skipped stale opportunity intelligence content fingerprint.',
        mode,
        skipReason: 'stale',
        status: 'skipped',
      });
      break;
    }
    if (mode === 'extract')
      results.push(await runExtract(opportunityId, options));
    else if (mode === 'score')
      results.push(await runScore(opportunity, options));
    else if (mode === 'evidence') {
      results.push(await runEvidence(opportunity, options));
    } else if (mode === 'quality') {
      results.push(await runQuality(opportunity, options));
    } else if (mode === 'research') {
      results.push(await runResearch(opportunity, options));
    } else if (mode === 'plan') {
      results.push(await runPlan(opportunity, options));
    }
  }

  const processed = results.filter((result) => result.status === 'processed');
  const failed = results.filter((result) => result.status === 'error');
  const skipped = results.filter((result) => result.status === 'skipped');
  const stale = skipped.some((result) => result.skipReason === 'stale');
  const latestScore = await latestEvaluationScore(
    opportunityId,
    stringValue(options.expectedSourceContentFingerprint),
  );
  return {
    count: processed.length,
    evaluationScoreId: stringValue(latestScore?.id),
    failed: failed.length,
    message:
      failed.length > 0
        ? `Processed ${processed.length} intelligence steps; ${failed.length} failed.`
        : stale && processed.length === 0
          ? 'Skipped stale opportunity intelligence content fingerprint.'
          : skipped.length > 0 && processed.length === 0
            ? skipped.map((result) => result.message).join(' ')
            : `Processed ${processed.length} intelligence steps.`,
    modes,
    opportunity: opportunity ? jsonRecord(opportunity) : null,
    opportunityId,
    results,
    stale,
    status:
      processed.length > 0
        ? 'processed'
        : skipped.length > 0
          ? 'skipped'
          : 'error',
  };
}

export async function processOpportunityIntelligence(
  options: OpportunityIntelligenceOptions,
) {
  const usesPaidModel = expandModes(options.modes).some((mode) =>
    ['extract', 'score'].includes(mode),
  );
  if (options.agentRunId || options.aiClient || !usesPaidModel) {
    return await processOpportunityIntelligenceInternal(options);
  }
  const agentRunId = await startOpportunityIntelligenceAgentRun({
    opportunityId: stringValue(options.opportunityId),
    sourceCrawlId: options.sourceCrawlId,
    sourceId: options.sourceId,
    userId: stringValue(options.user?.id),
  });
  try {
    const result = await processOpportunityIntelligenceInternal({
      ...options,
      agentRunId,
    });
    const succeeded =
      result.status === 'processed' && Number(result.failed ?? 0) === 0;
    await finishOpportunityIntelligenceAgentRun(
      agentRunId,
      succeeded ? 'succeeded' : 'failed',
      succeeded ? '' : result.message,
    );
    return result;
  } catch (error) {
    await finishOpportunityIntelligenceAgentRun(
      agentRunId,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function bulkProcessOpportunityIntelligence(
  opportunityIds: string[],
  options: Omit<OpportunityIntelligenceOptions, 'modes' | 'opportunityId'> & {
    modes?: OpportunityIntelligenceMode | OpportunityIntelligenceMode[];
  } = {},
) {
  const uniqueOpportunityIds = Array.from(
    new Set(opportunityIds.map(stringValue).filter(Boolean)),
  );
  if (uniqueOpportunityIds.length === 0) {
    return {
      count: 0,
      failed: 0,
      message: 'Select at least one opportunity.',
      results: [],
      status: 'error',
    };
  }
  const results = [];
  for (const opportunityId of uniqueOpportunityIds) {
    results.push(
      await processOpportunityIntelligence({
        ...options,
        modes: options.modes ?? 'all',
        opportunityId,
      }),
    );
  }
  const processed = results.filter((result) => result.status === 'processed');
  const failed = results.filter(
    (result) => result.status !== 'processed' || result.failed > 0,
  );
  return {
    count: processed.length,
    failed: failed.length,
    message:
      failed.length > 0
        ? `Processed ${processed.length} opportunities; ${failed.length} had failures.`
        : `Processed ${processed.length} opportunities.`,
    results,
    status: processed.length > 0 ? 'processed' : 'error',
  };
}
