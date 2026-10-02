import { createHash } from 'node:crypto';
import { type DecisionResult, getAI } from '@happyvertical/ai';
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
  const estimatedInputTokens = Buffer.byteLength(
    JSON.stringify(prepared.request),
    'utf8',
  );
  const { output } =
    await executeGovernedOpportunityIntelligenceRequest<DecisionResult>({
      config,
      estimatedInputTokens,
      inputTokenCeiling: Math.min(64_000, Math.max(1, estimatedInputTokens)),
      maxOutputTokens: 4096,
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
