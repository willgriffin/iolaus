import { type DecisionResult, getAI } from '@happyvertical/ai';
import { resolveOpportunityIntelligenceBudgetConfig } from './opportunity-intelligence-config.js';
import {
  executeGovernedOpportunityIntelligenceRequest,
  type OpportunityIntelligenceGovernanceStore,
} from './opportunity-intelligence-governance.js';
import {
  type prepareSkillMatching,
  resolveSkillMatching,
  SKILL_MATCH_VERSION,
} from './skill-matching.js';

/** Separate credentials and pricing: decision traffic must not use chat rates. */
export async function evaluateSkillMatches(
  prepared: ReturnType<typeof prepareSkillMatching>,
  options: {
    agentRunId?: string;
    opportunityId: string;
    contentFingerprint: string;
    sourceCrawlId?: string;
    sourceCrawlItemId?: string;
    signal?: AbortSignal;
    store?: OpportunityIntelligenceGovernanceStore;
  },
) {
  if (process.env.OPPORTUNITY_SKILL_DECISIONS_ENABLED !== 'true')
    return undefined;
  if (
    Object.keys(prepared.request.questions).length === 0 ||
    prepared.candidates.length === 0
  )
    return resolveSkillMatching(prepared);
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey)
    throw new Error('TYPESAFE_API_KEY is required for skill decisions.');
  if (!options.agentRunId)
    throw new Error('Skill decisions require an AgentRun reservation owner.');
  const model =
    process.env.OPPORTUNITY_SKILL_DECISION_MODEL?.trim() || 'jev-latest';
  const config = resolveOpportunityIntelligenceBudgetConfig();
  const price = (name: string) => {
    const raw = process.env[name];
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error(`Configure ${name} for skill decision spend accounting.`);
    return Number(raw);
  };
  config.pricing = {
    configured: true,
    inputMicrosPerMillion: price(
      'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
    ),
    outputMicrosPerMillion: price(
      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
    ),
  };
  // Conservative byte bound avoids reliance on a chat tokenizer for Jev.
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
        opportunityId: options.opportunityId,
        contentFingerprint: options.contentFingerprint,
        inputFingerprint: prepared.fingerprint,
        feature: 'opportunity-skill-match',
        profile: 'typesafe-skills',
        model,
        promptVersion: SKILL_MATCH_VERSION,
        outputSchemaVersion: SKILL_MATCH_VERSION,
        preparedPayloadVersion: SKILL_MATCH_VERSION,
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
        resolveSkillMatching(prepared, result);
        return { output: result, usage: result.usage };
      },
    });
  return resolveSkillMatching(prepared, output);
}
