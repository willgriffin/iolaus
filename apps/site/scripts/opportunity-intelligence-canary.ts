import {
  OPPORTUNITY_INTELLIGENCE_PROFILES,
  resolveOpenAiOpportunityIntelligenceCanaryClient,
  resolveOpportunityIntelligenceProfile,
} from '../src/lib/server/ai-config.js';
import {
  OPPORTUNITY_INTELLIGENCE_CANARY_REPORT_VERSION,
  OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS,
  runOpportunityIntelligenceCanary,
} from '../src/lib/server/opportunity-intelligence-canary.js';
import {
  opportunityIntelligenceCanaryCategories,
  opportunityIntelligenceCanaryFixtures,
} from '../src/lib/server/fixtures/opportunity-intelligence-canary.js';

const command = process.argv[2] ?? 'preflight';
const canaryProfile = OPPORTUNITY_INTELLIGENCE_PROFILES.openai;

if (!['preflight', 'run'].includes(command)) {
  throw new Error(
    'Usage: pnpm --filter @willgriffin/iolaus-site opportunities:intelligence-canary <preflight|run>',
  );
}

const configured = (() => {
  try {
    return resolveOpportunityIntelligenceProfile();
  } catch {
    return null;
  }
})();
const credentialConfigured = Boolean(
  process.env[canaryProfile.apiKeyEnv]?.trim(),
);
const configuredCanaryModel =
  process.env[canaryProfile.modelEnv]?.trim() || canaryProfile.model;
const preflight = {
  categories: opportunityIntelligenceCanaryCategories,
  caseCount: opportunityIntelligenceCanaryFixtures.length,
  credentialConfigured,
  profile: {
    configuredSelection: configured?.selection ?? 'missing',
    expectedModel: canaryProfile.model,
    expectedName: canaryProfile.profile,
    modelPinned: configuredCanaryModel === canaryProfile.model,
  },
  ready:
    configured?.selection === 'openai' &&
    credentialConfigured &&
    configuredCanaryModel === canaryProfile.model,
  schemaVersion: OPPORTUNITY_INTELLIGENCE_CANARY_REPORT_VERSION,
  thresholds: OPPORTUNITY_INTELLIGENCE_CANARY_THRESHOLDS,
};

if (command === 'preflight') {
  console.log(JSON.stringify(preflight, null, 2));
} else {
  if (!preflight.ready) {
    console.log(JSON.stringify(preflight, null, 2));
    throw new Error(
      `OpenAI canary preflight failed; explicitly set OPPORTUNITY_INTELLIGENCE_PROFILE=openai, ${canaryProfile.apiKeyEnv}, and the pinned OpenAI model.`,
    );
  }
  const profile = await resolveOpenAiOpportunityIntelligenceCanaryClient();
  if (!profile) {
    throw new Error('The dedicated OpenAI Bifrost profile is unavailable.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
  try {
    const report = await runOpportunityIntelligenceCanary({
      fixtures: opportunityIntelligenceCanaryFixtures,
      profile,
      signal: controller.signal,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.accepted) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}
