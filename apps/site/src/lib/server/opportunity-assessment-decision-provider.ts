import { createHash } from 'node:crypto';
import {
  type DecisionRequest,
  type DecisionResult,
  getAI,
} from '@happyvertical/ai';
import {
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

/** TypeSafe's decision operation has no remote max-output control. */
export const OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES = 64_000;
export const OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS = 20_000;

export class OpportunityAssessmentRequestTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpportunityAssessmentRequestTooLargeError';
  }
}

/**
 * A typed choice response carries a probability for every criterion. Reserve
 * from that wire shape rather than inheriting the old small skill batch's
 * 4,096-token estimate. This is a conservative accounting ceiling, not a
 * provider-side generation control (the TypeSafe decision API exposes none).
 */
export function assessmentDecisionOutputTokenCeiling(
  request: DecisionRequest,
): number {
  const responseBytes = Object.values(request.questions).reduce(
    (total, question) =>
      total +
      (question.type === 'predicate'
        ? 96
        : 192 + Object.keys(question.criteria).length * 32),
    256,
  );
  // Three bytes/token is intentionally conservative for JSON keys and decimal
  // probability values. The hard ceiling rejects an oversized batch before a
  // billable provider call.
  return Math.max(1_024, Math.ceil(responseBytes / 3));
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
  // Byte bounds avoid pretending a chat tokenizer can exactly price Jev.
  const estimatedInputTokens = Buffer.byteLength(
    JSON.stringify(prepared.request),
    'utf8',
  );
  if (estimatedInputTokens > OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES) {
    throw new OpportunityAssessmentRequestTooLargeError(
      `Opportunity assessment request is ${estimatedInputTokens} bytes, above the ${OPPORTUNITY_ASSESSMENT_MAX_REQUEST_BYTES}-byte limit.`,
    );
  }
  const maxOutputTokens = assessmentDecisionOutputTokenCeiling(
    prepared.request,
  );
  if (maxOutputTokens > OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS) {
    throw new OpportunityAssessmentRequestTooLargeError(
      `Opportunity assessment response reservation is ${maxOutputTokens} tokens, above the ${OPPORTUNITY_ASSESSMENT_MAX_OUTPUT_TOKENS}-token limit.`,
    );
  }
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
