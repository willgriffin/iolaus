// Load local SMRT objects before resolving collections or the database.
import '../src/lib/server/manifest-preload.js';
import { resolveOpportunityIntelligenceProfile } from '../src/lib/server/ai-config.js';
import { resolveOpportunityIntelligenceBudgetConfig } from '../src/lib/server/opportunity-intelligence-config.js';
import {
  getOpportunityIntelligenceControlStatus,
  reconcileOpportunityIntelligenceStatuses,
  setOpportunityIntelligenceControl,
} from '../src/lib/server/opportunity-intelligence-governance.js';

const command = process.argv[2] ?? 'status';

function requireCanaryConfiguration(): {
  inputTokenThreshold: number;
  requestThreshold: number;
} {
  const config = resolveOpportunityIntelligenceBudgetConfig();
  const missing: string[] = [];
  if (!config.enabled) missing.push('OPPORTUNITY_INTELLIGENCE_ENABLED=true');
  let selected: ReturnType<typeof resolveOpportunityIntelligenceProfile> | null = null;
  try {
    selected = resolveOpportunityIntelligenceProfile();
  } catch (error) {
    missing.push(error instanceof Error ? error.message : 'explicit intelligence profile');
  }
  if (selected && !process.env[selected.apiKeyEnv]?.trim()) {
    missing.push(selected.apiKeyEnv);
  }
  if (!config.pricing.configured) missing.push('input/output pricing');
  if (
    config.run.calls <= 0 ||
    config.run.inputTokens <= 0 ||
    config.run.spendMicros <= 0
  ) {
    missing.push('per-run call/token/spend limits');
  }
  if (
    config.crawl.calls <= 0 ||
    config.crawl.inputTokens <= 0 ||
    config.crawl.spendMicros <= 0
  ) {
    missing.push('per-crawl call/token/spend limits');
  }
  const model = selected
    ? process.env[selected.modelEnv]?.trim() || selected.model
    : '';
  if (selected && model !== selected.model) {
    missing.push(`pinned ${selected.selection} model (${selected.model})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Cannot enable opportunity intelligence; missing or invalid: ${missing.join('; ')}.`,
    );
  }
  return {
    inputTokenThreshold: config.circuit.inputTokenThreshold,
    requestThreshold: config.circuit.requestThreshold,
  };
}

if (!['enable', 'reconcile-status', 'status', 'stop'].includes(command)) {
  throw new Error(
    'Usage: pnpm --filter @willgriffin/iolaus-site opportunities:intelligence-control <status|stop|enable|reconcile-status>',
  );
}

const reconciliation =
  command === 'reconcile-status'
    ? await reconcileOpportunityIntelligenceStatuses()
    : null;
const status =
  command === 'stop'
    ? await setOpportunityIntelligenceControl({
        enabled: false,
        reason: 'operator_stop',
      })
    : command === 'enable'
      ? await setOpportunityIntelligenceControl({
          enabled: true,
          reason: 'operator_enable',
          ...requireCanaryConfiguration(),
        })
      : await getOpportunityIntelligenceControlStatus();

console.log(
  JSON.stringify(
    { action: command, ...(reconciliation ?? {}), ...status },
    null,
    2,
  ),
);

if (command === 'stop' && status.enabled) {
  throw new Error('Stop verification failed: persisted control remains enabled.');
}
if (command === 'enable' && (!status.enabled || status.circuitState !== 'closed')) {
  throw new Error('Enable verification failed: persisted control is not closed.');
}
