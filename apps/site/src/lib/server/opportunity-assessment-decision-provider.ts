import { createHash } from 'node:crypto';
import {
  type DecisionRequest,
  type DecisionResult,
  getAI,
} from '@happyvertical/ai';
import {
  assessmentDecisionOutputTokenCeiling,
  OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS,
  OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES,
  OPPORTUNITY_ASSESSMENT_VERSION,
  type PreparedOpportunityAssessment,
  resolveOpportunityAssessment,
} from './opportunity-assessment.js';
import { resolveOpportunityIntelligenceBudgetConfig } from './opportunity-intelligence-config.js';
import {
  executeGovernedOpportunityIntelligenceRequest,
  type OpportunityIntelligenceGovernanceStore,
} from './opportunity-intelligence-governance.js';
import type { WorkspaceSubject } from './private-workspace.js';

export {
  assessmentDecisionOutputTokenCeiling,
  OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS,
  OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES,
} from './opportunity-assessment.js';

export class OpportunityAssessmentRequestTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpportunityAssessmentRequestTooLargeError';
  }
}

/** Token-free exact wire preflight, shared by native operators and invocation. */
export function preflightOpportunityAssessmentRequest(
  prepared: PreparedOpportunityAssessment,
): {
  requestBytes: number;
  maxOutputTokens: number;
  offeredSupportPredicates: number;
  offeredContradictionPredicates: number;
  fits: boolean;
  reason?: 'request_bytes' | 'output_reservation' | 'citation_scope';
} {
  const requestBytes = Buffer.byteLength(
    JSON.stringify(prepared.request),
    'utf8',
  );
  const maxOutputTokens = assessmentDecisionOutputTokenCeiling(
    prepared.request,
  );
  const reason =
    requestBytes > OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES
      ? 'request_bytes'
      : maxOutputTokens > OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS
        ? 'output_reservation'
        : prepared.requirements.length > 0 &&
            prepared.citationScopes.some(
              (scope) => scope.candidateKeys.length === 0,
            )
          ? 'citation_scope'
          : undefined;
  return {
    requestBytes,
    maxOutputTokens,
    offeredSupportPredicates: Object.keys(prepared.request.questions).filter(
      (key) => /^r\d+_c\d+_supports$/u.test(key),
    ).length,
    offeredContradictionPredicates: Object.keys(
      prepared.request.questions,
    ).filter((key) => /^r\d+_c\d+_contradicts$/u.test(key)).length,
    fits: !reason,
    ...(reason ? { reason } : {}),
  };
}

function opaqueInputFingerprint(
  prepared: PreparedOpportunityAssessment,
  subjectFingerprint: string,
): string {
  return createHash('sha256')
    .update(`${prepared.fingerprint}:${subjectFingerprint}`)
    .digest('hex');
}

/**
 * Runs the broader JEV request through the same reservation, circuit and
 * actual-usage accounting as the existing skill matcher. `subjectFingerprint`
 * must be a stable opaque server-derived identity; it is never sent to JEV.
 */
export async function evaluateOpportunityAssessment(
  prepared: PreparedOpportunityAssessment,
  options: {
    agentRunId?: string;
    contentFingerprint: string;
    opportunityId: string;
    sourceCrawlId?: string;
    sourceCrawlItemId?: string;
    signal?: AbortSignal;
    store?: OpportunityIntelligenceGovernanceStore;
    subjectFingerprint: string;
    /** Server-resolved tuple; never supplied by the model or browser. */
    workspaceSubject: WorkspaceSubject;
  },
) {
  if (process.env.OPPORTUNITY_ASSESSMENT_DECISIONS_ENABLED !== 'true')
    return undefined;
  if (prepared.requirements.length === 0)
    throw new Error(
      'Extract structured role requirements before private matching.',
    );
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      'TYPESAFE_API_KEY is required for opportunity assessments.',
    );
  if (!options.agentRunId)
    throw new Error(
      'Opportunity assessments require an AgentRun reservation owner.',
    );
  if (!options.subjectFingerprint.trim())
    throw new Error(
      'Opportunity assessments require an opaque subject fingerprint.',
    );
  const model =
    process.env.OPPORTUNITY_ASSESSMENT_DECISION_MODEL?.trim() ||
    process.env.OPPORTUNITY_SKILL_DECISION_MODEL?.trim() ||
    'jev-latest';
  const price = (name: string) => {
    const raw = process.env[name];
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error(
        `Configure ${name} for opportunity assessment accounting.`,
      );
    return Number(raw);
  };
  const config = resolveOpportunityIntelligenceBudgetConfig();
  config.pricing = {
    configured: true,
    inputMicrosPerMillion: price(
      'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
    ),
    outputMicrosPerMillion: price(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
    ),
  };
  // Never reserve or invoke a partial wire representation to make it fit.
  const preflight = preflightOpportunityAssessmentRequest(prepared);
  if (!preflight.fits) {
    throw new OpportunityAssessmentRequestTooLargeError(
      preflight.reason === 'request_bytes'
        ? `Complete opportunity assessment request is ${preflight.requestBytes} bytes, above the ${OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES}-byte limit.`
        : preflight.reason === 'citation_scope'
          ? 'No candidate citation scope is available for every role requirement within the assessment limits.'
          : `Complete opportunity assessment response reservation is ${preflight.maxOutputTokens} tokens, above the ${OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS}-token limit.`,
    );
  }
  const estimatedInputTokens = preflight.requestBytes;
  const maxOutputTokens = preflight.maxOutputTokens;
  const { output } =
    await executeGovernedOpportunityIntelligenceRequest<DecisionResult>({
      config,
      estimatedInputTokens,
      inputTokenCeiling: estimatedInputTokens,
      maxOutputTokens,
      identity: {
        agentRunId: options.agentRunId,
        contentFingerprint: options.contentFingerprint,
        feature: 'opportunity-assessment',
        inputFingerprint: opaqueInputFingerprint(
          prepared,
          options.subjectFingerprint,
        ),
        model,
        opportunityId: options.opportunityId,
        outputSchemaVersion: OPPORTUNITY_ASSESSMENT_VERSION,
        preparedPayloadVersion: OPPORTUNITY_ASSESSMENT_VERSION,
        profile: 'typesafe-opportunity-assessment',
        promptVersion: OPPORTUNITY_ASSESSMENT_VERSION,
        sourceCrawlId: options.sourceCrawlId,
        sourceCrawlItemId: options.sourceCrawlItemId,
      },
      signal: options.signal,
      store: options.store,
      workspaceSubject: options.workspaceSubject,
      invoke: async () => {
        const client = await getAI({
          type: 'typesafe',
          apiKey,
          defaultModel: model,
        });
        if (!(await client.getCapabilities()).decisions || !client.decide)
          throw new Error(
            'Configured provider does not support typed decisions.',
          );
        const result = await client.decide(prepared.request, {
          model,
          signal: options.signal,
          timeout: 30_000,
        });
        // Validate before a successful governed completion can be recorded.
        resolveOpportunityAssessment(prepared, result);
        return { output: result, usage: result.usage };
      },
    });
  return resolveOpportunityAssessment(prepared, output);
}
