import type { AIMessage, ChatOptions } from '@happyvertical/ai';
import {
  type AiProfileClient,
  OPPORTUNITY_INTELLIGENCE_PROFILES,
} from './ai-config.js';
import type {
  OpportunityIntelligenceCanaryFixture,
  OpportunityIntelligenceFieldCheck,
} from './fixtures/opportunity-intelligence-canary.js';
import {
  opportunityIntelligenceCanaryCategories,
  opportunityIntelligenceCanaryFixtures,
} from './fixtures/opportunity-intelligence-canary.js';
import { requireJsonObjectFromText } from './llm-json.js';
import {
  buildOpportunityLlmExtractionMessages,
  normalizeOpportunityLlmExtraction,
} from './opportunity-details.js';
import { normalizeOpportunityScoreOutput } from './opportunity-intelligence.js';
import {
  buildBoundedPreparedPostingChunks,
  mergeOpportunityExtractionChunks,
  OPPORTUNITY_INPUT_MIN_CONTEXT_HEADROOM_RATIO,
  prepareOpportunityPosting,
} from './opportunity-posting-preparation.js';
import {
  buildBoundedOpportunityScoringRequest,
  deterministicOpportunityScore,
  preScoreOpportunity,
} from './opportunity-scoring.js';

export const OPPORTUNITY_INTELLIGENCE_CANARY_REPORT_VERSION =
  'opportunity-intelligence-canary/v1';

// These gates are intentionally source-controlled before any live canary run.
// A failed run must not move these values or the production profile default.
export const OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS = {
  maxFailureRate: 0,
  maxRequestP95LatencyMs: 90_000,
  minCaseCount: 7,
  minContextHeadroomRatio: OPPORTUNITY_INPUT_MIN_CONTEXT_HEADROOM_RATIO,
  minFieldQualityRate: 0.9,
  minPerFieldQualityRate: 0.75,
  minModelScoringCases: 2,
  minScoringAgreementRate: 0.85,
} as const;

export interface OpportunityIntelligenceCanaryContextMeasurement {
  ceilingTokens: number;
  headroomRatio: number;
  headroomTokens: number;
  inputTokens: number;
  invoked: boolean;
  phase: 'extraction' | 'scoring';
}

export interface OpportunityIntelligenceCanaryCaseResult {
  categories: string[];
  context: OpportunityIntelligenceCanaryContextMeasurement[];
  extraction: {
    checks: Array<{ field: string; passed: boolean }>;
    failedFields: string[];
    requestCount: number;
  };
  failureMode?: string;
  id: string;
  latencyMs: {
    case: number;
    extraction: number;
    requests: number[];
    scoring: number;
  };
  scoring: {
    actualDecision: string;
    actualRecommendation: string;
    agreed: boolean;
    expectedDecision: string;
    expectedRecommendation: string;
    modelInvoked: boolean;
  };
  status: 'failed' | 'succeeded';
}

interface Distribution {
  max: number;
  p50: number;
  p95: number;
}

export interface OpportunityIntelligenceCanaryReport {
  accepted: boolean;
  cases: OpportunityIntelligenceCanaryCaseResult[];
  generatedAt: string;
  gates: Record<string, boolean>;
  profile: { model: string; name: string; provider: string };
  schemaVersion: string;
  summary: {
    caseCount: number;
    context: {
      everyInputWithinCeiling: boolean;
      measurementCount: number;
      minHeadroomRatio: number;
      minHeadroomTokens: number;
      totalInputTokens: number;
    };
    failureModes: Record<string, number>;
    failureRate: number;
    failedCases: number;
    fieldQuality: {
      byField: Record<string, { passed: number; rate: number; total: number }>;
      passed: number;
      rate: number;
      total: number;
    };
    latencyMs: {
      case: Distribution;
      extraction: Distribution;
      request: Distribution;
      scoring: Distribution;
    };
    modelScoringCases: number;
    scoringAgreement: { agreed: number; rate: number; total: number };
  };
  thresholds: typeof OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value))
    return value.map(stringValue).filter(Boolean).join('\n');
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function normalizedComparable(value: unknown): string {
  return stringValue(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9+#./]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function fieldCheckPassed(
  output: Record<string, unknown>,
  check: OpportunityIntelligenceFieldCheck,
): boolean {
  const actual = output[check.field];
  if (check.operator === 'empty') {
    const normalized = normalizedComparable(actual);
    return !normalized || normalized === 'unknown';
  }
  if (typeof check.value === 'number') return Number(actual) === check.value;
  const actualText = normalizedComparable(actual);
  const expectedText = normalizedComparable(check.value);
  return check.operator === 'equals'
    ? actualText === expectedText
    : actualText.includes(expectedText);
}

function rounded(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : 0;
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { max: 0, p50: 0, p95: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * value) - 1),
      )
    ];
  return {
    max: Math.round(sorted.at(-1) ?? 0),
    p50: Math.round(percentile(0.5)),
    p95: Math.round(percentile(0.95)),
  };
}

export function classifyOpportunityIntelligenceCanaryFailure(
  error: unknown,
): string {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  if (name.includes('abort') || message.includes('abort')) return 'aborted';
  if (message.includes('timeout') || message.includes('timed out'))
    return 'timeout';
  if (
    message.includes('insufficient_quota') ||
    message.includes('insufficient balance') ||
    message.includes('no resource package')
  ) {
    return 'provider_quota';
  }
  if (
    message.includes('request limit exceeded') ||
    message.includes('rate limit check failed') ||
    message.includes('rate limit') ||
    message.includes('429')
  ) {
    return 'rate_limit';
  }
  if (
    message.includes('401') ||
    message.includes('403') ||
    message.includes('auth')
  )
    return 'authentication';
  if (
    message.includes('token') ||
    message.includes('context') ||
    message.includes('ceiling')
  ) {
    return 'context_limit';
  }
  if (message.includes('json')) return 'invalid_json';
  if (message.includes('empty response')) return 'empty_response';
  return 'provider_error';
}

async function chatJson(options: {
  messages: AIMessage[];
  profile: AiProfileClient;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const chatOptions: ChatOptions = {
    maxTokens: 2_048,
    model: options.profile.model,
    reasoning: { maxTokens: 1_024 },
    responseFormat: { type: 'json_object' },
    signal: options.signal,
    temperature: 0,
    timeout: options.profile.timeout,
  };
  const response = await options.profile.aiClient.chat(
    options.messages,
    chatOptions,
  );
  const content = stringValue(response.content);
  if (!content) throw new Error('Canary provider returned an empty response.');
  return requireJsonObjectFromText(content, 'Opportunity intelligence canary');
}

function contextMeasurement(options: {
  ceilingTokens: number;
  inputTokens: number;
  invoked: boolean;
  phase: 'extraction' | 'scoring';
}): OpportunityIntelligenceCanaryContextMeasurement {
  const headroomTokens = options.ceilingTokens - options.inputTokens;
  return {
    ...options,
    headroomRatio: rounded(headroomTokens / options.ceilingTokens),
    headroomTokens,
  };
}

async function runCase(options: {
  fixture: OpportunityIntelligenceCanaryFixture;
  now: () => number;
  profile: AiProfileClient;
  signal?: AbortSignal;
}): Promise<OpportunityIntelligenceCanaryCaseResult> {
  const { fixture, now, profile, signal } = options;
  const caseStarted = now();
  const requestLatencies: number[] = [];
  const context: OpportunityIntelligenceCanaryContextMeasurement[] = [];
  let extractionLatency = 0;
  let scoringLatency = 0;
  let extractionRequestCount = 0;
  let checks = fixture.expectedExtraction.map((check) => ({
    field: check.field,
    passed: false,
  }));
  let actualDecision = '';
  let actualRecommendation = '';
  let modelInvoked = false;

  try {
    signal?.throwIfAborted();
    const prepared = prepareOpportunityPosting(fixture.opportunity);
    const chunks = await buildBoundedPreparedPostingChunks({
      buildMessages: buildOpportunityLlmExtractionMessages,
      counter: profile.aiClient.countTokens
        ? profile.aiClient.countTokens.bind(profile.aiClient)
        : undefined,
      model: profile.model,
      minContextHeadroomRatio:
        OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.minContextHeadroomRatio,
      prepared,
    });
    extractionRequestCount = chunks.length;
    const extractionStarted = now();
    const chunkResults = [];
    for (const chunk of chunks) {
      context.push(
        contextMeasurement({
          ceilingTokens: chunk.inputTokenCeiling,
          inputTokens: chunk.inputTokenCount,
          invoked: true,
          phase: 'extraction',
        }),
      );
      const requestStarted = now();
      const output = await chatJson({
        messages: buildOpportunityLlmExtractionMessages(chunk),
        profile,
        signal,
      });
      requestLatencies.push(now() - requestStarted);
      chunkResults.push({
        chunkIndex: chunk.chunkIndex,
        output,
        sectionIds: chunk.sections.map((section) => section.id),
      });
    }
    extractionLatency = now() - extractionStarted;
    const merged = mergeOpportunityExtractionChunks(
      chunkResults,
      prepared.facts,
    );
    const extraction = normalizeOpportunityLlmExtraction(merged.output);
    checks = fixture.expectedExtraction.map((check) => ({
      field: check.field,
      passed: fieldCheckPassed(extraction, check),
    }));

    const scoringOpportunity = {
      ...fixture.opportunity,
      ...extraction,
      ...fixture.scoring.opportunity,
    };
    const scoringStarted = now();
    const request = await buildBoundedOpportunityScoringRequest({
      counter: profile.aiClient.countTokens
        ? profile.aiClient.countTokens.bind(profile.aiClient)
        : undefined,
      evidenceSources: fixture.scoring.evidenceSources,
      inputTokenCeiling: fixture.scoring.policy.inputTokenCeiling,
      minContextHeadroomRatio:
        OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.minContextHeadroomRatio,
      model: profile.model,
      opportunity: scoringOpportunity,
      policy: fixture.scoring.policy,
      prepared,
    });
    const decision = preScoreOpportunity(request.input);
    actualDecision = decision.kind;
    modelInvoked =
      decision.modelEligible && fixture.scoring.policy.modelEnabled;
    context.push(
      contextMeasurement({
        ceilingTokens: request.inputTokenCeiling,
        inputTokens: request.inputTokenCount,
        invoked: modelInvoked,
        phase: 'scoring',
      }),
    );
    if (modelInvoked) {
      const requestStarted = now();
      const output = await chatJson({
        messages: request.messages,
        profile,
        signal,
      });
      requestLatencies.push(now() - requestStarted);
      actualRecommendation =
        normalizeOpportunityScoreOutput(output).recommendation;
    } else {
      actualRecommendation = deterministicOpportunityScore(
        request,
        decision,
      ).recommendation;
    }
    scoringLatency = now() - scoringStarted;

    return {
      categories: fixture.categories,
      context,
      extraction: {
        checks,
        failedFields: checks
          .filter((check) => !check.passed)
          .map((check) => check.field),
        requestCount: extractionRequestCount,
      },
      id: fixture.id,
      latencyMs: {
        case: now() - caseStarted,
        extraction: extractionLatency,
        requests: requestLatencies,
        scoring: scoringLatency,
      },
      scoring: {
        actualDecision,
        actualRecommendation,
        agreed:
          actualDecision === fixture.scoring.expectedDecision &&
          actualRecommendation === fixture.scoring.expectedRecommendation,
        expectedDecision: fixture.scoring.expectedDecision,
        expectedRecommendation: fixture.scoring.expectedRecommendation,
        modelInvoked,
      },
      status: 'succeeded',
    };
  } catch (error) {
    return {
      categories: fixture.categories,
      context,
      extraction: {
        checks,
        failedFields: checks
          .filter((check) => !check.passed)
          .map((check) => check.field),
        requestCount: extractionRequestCount,
      },
      failureMode: classifyOpportunityIntelligenceCanaryFailure(error),
      id: fixture.id,
      latencyMs: {
        case: now() - caseStarted,
        extraction: extractionLatency,
        requests: requestLatencies,
        scoring: scoringLatency,
      },
      scoring: {
        actualDecision,
        actualRecommendation,
        agreed: false,
        expectedDecision: fixture.scoring.expectedDecision,
        expectedRecommendation: fixture.scoring.expectedRecommendation,
        modelInvoked,
      },
      status: 'failed',
    };
  }
}

export function evaluateOpportunityIntelligenceCanary(options: {
  cases: OpportunityIntelligenceCanaryCaseResult[];
  generatedAt?: string;
  profile: { model: string; name: string; provider: string };
}): OpportunityIntelligenceCanaryReport {
  const { cases } = options;
  const failedCases = cases.filter(
    (result) => result.status === 'failed',
  ).length;
  const checkResults = cases.flatMap((result) => result.extraction.checks);
  const passedChecks = checkResults.filter((check) => check.passed).length;
  const byField: Record<
    string,
    { passed: number; rate: number; total: number }
  > = {};
  for (const check of checkResults) {
    const current = byField[check.field] ?? { passed: 0, rate: 0, total: 0 };
    current.total += 1;
    if (check.passed) current.passed += 1;
    current.rate = rounded(current.passed / current.total);
    byField[check.field] = current;
  }
  const scoringAgreed = cases.filter((result) => result.scoring.agreed).length;
  const contexts = cases.flatMap((result) => result.context);
  const requestLatencies = cases.flatMap((result) => result.latencyMs.requests);
  const failureModes: Record<string, number> = {};
  for (const result of cases) {
    if (result.failureMode) {
      failureModes[result.failureMode] =
        (failureModes[result.failureMode] ?? 0) + 1;
    }
  }
  const failureRate = cases.length > 0 ? failedCases / cases.length : 1;
  const fieldQualityRate =
    checkResults.length > 0 ? passedChecks / checkResults.length : 0;
  const scoringAgreementRate =
    cases.length > 0 ? scoringAgreed / cases.length : 0;
  const minHeadroomRatio = contexts.length
    ? Math.min(...contexts.map((measurement) => measurement.headroomRatio))
    : 0;
  const everyInputWithinCeiling =
    contexts.length > 0 &&
    contexts.every((measurement) => measurement.headroomTokens >= 0);
  const requestDistribution = distribution(requestLatencies);
  const modelScoringCases = cases.filter(
    (result) => result.scoring.modelInvoked,
  ).length;
  const coveredCategories = new Set(
    cases.flatMap((result) => result.categories),
  );
  const expectedCaseIds = new Set(
    opportunityIntelligenceCanaryFixtures.map((fixture) => fixture.id),
  );
  const completeCorpus =
    cases.length === opportunityIntelligenceCanaryFixtures.length &&
    new Set(cases.map((result) => result.id)).size === cases.length &&
    cases.every((result) => expectedCaseIds.has(result.id)) &&
    opportunityIntelligenceCanaryCategories.every((category) =>
      coveredCategories.has(category),
    );
  const expectedCanaryProfile = OPPORTUNITY_INTELLIGENCE_PROFILES.openai;
  const gates = {
    caseCount:
      cases.length >= OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.minCaseCount,
    corpusCoverage: completeCorpus,
    contextHeadroom:
      everyInputWithinCeiling &&
      minHeadroomRatio >=
        OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.minContextHeadroomRatio,
    failureRate:
      failureRate <= OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.maxFailureRate,
    fieldQuality:
      fieldQualityRate >=
        OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.minFieldQualityRate &&
      Object.values(byField).every(
        (field) =>
          field.rate >=
          OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.minPerFieldQualityRate,
      ),
    canaryProfile:
      options.profile.model === expectedCanaryProfile.model &&
      options.profile.name === expectedCanaryProfile.profile &&
      options.profile.provider === 'bifrost',
    modelScoringCoverage:
      modelScoringCases >=
      OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.minModelScoringCases,
    requestLatency:
      requestLatencies.length > 0 &&
      requestDistribution.p95 <=
        OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.maxRequestP95LatencyMs,
    scoringAgreement:
      scoringAgreementRate >=
      OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS.minScoringAgreementRate,
  };

  return {
    accepted: Object.values(gates).every(Boolean),
    cases,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    gates,
    profile: options.profile,
    schemaVersion: OPPORTUNITY_INTELLIGENCE_CANARY_REPORT_VERSION,
    summary: {
      caseCount: cases.length,
      context: {
        everyInputWithinCeiling,
        measurementCount: contexts.length,
        minHeadroomRatio: rounded(minHeadroomRatio),
        minHeadroomTokens: contexts.length
          ? Math.min(
              ...contexts.map((measurement) => measurement.headroomTokens),
            )
          : 0,
        totalInputTokens: contexts.reduce(
          (total, measurement) => total + measurement.inputTokens,
          0,
        ),
      },
      failureModes,
      failureRate: rounded(failureRate),
      failedCases,
      fieldQuality: {
        byField,
        passed: passedChecks,
        rate: rounded(fieldQualityRate),
        total: checkResults.length,
      },
      latencyMs: {
        case: distribution(cases.map((result) => result.latencyMs.case)),
        extraction: distribution(
          cases.map((result) => result.latencyMs.extraction),
        ),
        request: requestDistribution,
        scoring: distribution(cases.map((result) => result.latencyMs.scoring)),
      },
      modelScoringCases,
      scoringAgreement: {
        agreed: scoringAgreed,
        rate: rounded(scoringAgreementRate),
        total: cases.length,
      },
    },
    thresholds: OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS,
  };
}

export async function runOpportunityIntelligenceCanary(options: {
  fixtures: OpportunityIntelligenceCanaryFixture[];
  generatedAt?: string;
  now?: () => number;
  profile: AiProfileClient;
  signal?: AbortSignal;
}): Promise<OpportunityIntelligenceCanaryReport> {
  const now = options.now ?? (() => performance.now());
  const cases: OpportunityIntelligenceCanaryCaseResult[] = [];
  for (const fixture of options.fixtures) {
    cases.push(
      await runCase({
        fixture,
        now,
        profile: options.profile,
        signal: options.signal,
      }),
    );
  }
  return evaluateOpportunityIntelligenceCanary({
    cases,
    generatedAt: options.generatedAt,
    profile: {
      model: options.profile.model,
      name: options.profile.profile,
      provider: options.profile.provider,
    },
  });
}
