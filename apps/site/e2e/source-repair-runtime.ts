import '../scripts/jobs-worker-bootstrap.js';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { type DecisionRequest, getAI } from '@happyvertical/ai';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { TaskRunner } from '@happyvertical/smrt-jobs';
import { UserCollection, UserStatus } from '@happyvertical/smrt-users';
import {
  AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS,
  resolveOpportunityIntelligenceExtractionAiProfileClient,
} from '../src/lib/server/ai-config.js';
import { getDbConfig, getSmrtOptions } from '../src/lib/server/db.js';
import {
  buildOpportunityLlmExtractionMessages,
  defaultFencedOpportunityUpdate,
  preflightOpportunityRequirementCoverageRepair,
} from '../src/lib/server/opportunity-details.js';
import {
  executeGovernedOpportunityIntelligenceRequest,
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from '../src/lib/server/opportunity-intelligence-governance.js';
import { prepareOpportunityPosting } from '../src/lib/server/opportunity-posting-preparation.js';
import {
  buildRequirementCoverage,
  buildRequirementCoverageSource,
  normalizeRequirementCoverageForAudit,
  REQUIREMENT_COVERAGE_PAID_V4_PROMPT_VERSION,
  REQUIREMENT_COVERAGE_PAID_V4_SCHEMA_VERSION,
  REQUIREMENT_COVERAGE_REPAIR_VERSION,
  requirementCoverageContextForOpportunity,
} from '../src/lib/server/opportunity-requirement-coverage.js';
import {
  prepareRequirementCoverageAudit,
  readRecordedRequirementCoverageOutcome,
  resolveRequirementCoverageAudit,
  validateVerifiedRequirementCoverage,
} from '../src/lib/server/opportunity-requirement-coverage-provider.js';
import {
  attestOpportunityRequirementCoverageRepair,
  enqueueOpportunityRequirementCoverageAuditReplay,
  enqueueOpportunityRequirementCoverageRepair,
} from '../src/lib/server/opportunity-requirement-coverage-repair-job.js';
import { fingerprintOpportunitySourceContent } from '../src/lib/server/opportunity-source-content.js';
import { getCollection } from '../src/lib/server/smrt.js';
import { withSyntheticDemoOwnerContext } from '../src/lib/server/synthetic-demo-fixture.js';
import {
  requireCurrentCandidateWorkspaceSubject,
  resolveWorkspaceSubjectForProfile,
  withVerifiedWorkspaceSubject,
} from '../src/lib/server/workspace-subject.js';
import { startRepairProvider } from './source-repair-provider.js';

type Json = Record<string, unknown>;
const fixturePath = process.env.IOLAUS_E2E_FIXTURE;
if (
  !fixturePath ||
  process.env.SMRT_APP_ID !== 'iolaus-e2e' ||
  process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1'
)
  throw new Error('Repair requires its disposable opted-in runtime');
const root = realpathSync(dirname(fixturePath));
if (
  !basename(root).startsWith('iolaus-mobile-e2e-') ||
  realpathSync(String(process.env.SMRT_DATA_DIR)) !== root + '/runtime'
)
  throw new Error('Repair refused non-fictional runtime');
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error('Fictional repair refused external transport');
  return await localFetch(input, options);
};
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  profileId: string;
  userId: string;
  tenantId: string;
};
const scenario = process.argv[2];
if (
  ![
    'positive',
    'stale',
    'forged',
    'revoked',
    'audit-positive',
    'audit-stale',
    'audit-forged',
  ].includes(scenario)
)
  throw new Error('Unknown fictional repair case');
const auditOnly = scenario.startsWith('audit-');
const db = await resolveDatabase(getDbConfig());
let repairJobId = '';
let replayJobId = '';
let replayEventStart = 0;
let beforeReplay: Json | undefined;
let exactReplay: Json | undefined;
const provider = await startRepairProvider(
  async () => {
    if (!repairJobId && !replayJobId) return undefined;
    const rows =
      (
        await db.query(
          'SELECT id, status, args, tenant_id, attempts FROM _smrt_jobs WHERE id = ?',
          [replayJobId || repairJobId],
        )
      ).rows ?? [];
    return rows[0] as Json | undefined;
  },
  { auditReplayOnly: auditOnly },
);
process.env.HAVE_AI_BASE_URL = provider.url;
process.env.HAVE_AI_OPPORTUNITY_INTELLIGENCE_EXTRACTION_BASE_URL = provider.url;
const opportunities = await getCollection('Opportunity');
const source = {
  title: 'Fictional native source repair ' + scenario,
  descriptionRaw:
    'Requirements\nYou must maintain tested API integrations.\nYou must build TypeScript interfaces with keyboard access and repeatable error recovery.',
  workMode: 'remote',
  employmentType: 'full_time',
  postedAt: '2020-01-01T00:00:00.000Z',
};
const opportunity = await opportunities.create({
  ...source,
  sourceContentJson: JSON.stringify(source),
  sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
  sourceContentVersion: 1,
  status: 'found',
  firstSeen: new Date(source.postedAt),
});
await opportunity.save();
const id = String(opportunity.id);
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = async (table: string, fields: string) =>
  (
    await db.query(
      'SELECT ' +
        fields +
        ' FROM ' +
        table +
        ' WHERE opportunity_id = ? ORDER BY created_at',
      [id],
    )
  ).rows ?? [];
const jobs = async () =>
  (
    await db.query(
      'SELECT id, method, status, tenant_id, args, attempts, last_error FROM _smrt_jobs WHERE object_id = ? ORDER BY created_at',
      [id],
    )
  ).rows ?? [];
const asOwner = async <T>(work: () => Promise<T>) =>
  await withSyntheticDemoOwnerContext(async () => {
    const subject = await resolveWorkspaceSubjectForProfile(fixture.profileId);
    return await withVerifiedWorkspaceSubject(subject, work);
  });
async function serviceNativeJobs() {
  const runner = new TaskRunner({
    concurrency: 1,
    queues: ['opportunity-intelligence'],
    pollInterval: 100,
    idlePollInterval: 100,
    retention: false,
    shutdownTimeout: 10_000,
  });
  await runner.initialize(db);
  await runner.start();
  try {
    const deadline = Date.now() + 90_000;
    while (
      (await jobs()).some((row) =>
        ['pending', 'running'].includes(String(row.status)),
      )
    ) {
      if (Date.now() > deadline)
        throw new Error('Native repair job did not settle');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    await runner.stop();
  }
}
let refusal = '';
let baseRequestId = '';
let feedbackRequestId = '';
let bootstrapEventCount = 0;
let beforePreparedJson = '';
try {
  const native = opportunity.toJSON();
  const posting = prepareOpportunityPosting(native);
  const context = requirementCoverageContextForOpportunity(
    {
      ...native,
      preparedPostingFingerprint: posting.fingerprint,
    },
    'paid-v4-coverage-only4096',
  );
  const settings =
    await resolveOpportunityIntelligenceExtractionAiProfileClient();
  if (!settings) throw new Error('Native fictional extraction profile missing');
  const runId = await asOwner(
    async () =>
      await startOpportunityIntelligenceAgentRun({
        opportunityId: id,
        workspaceSubject: requireCurrentCandidateWorkspaceSubject(),
      }),
  );
  const base = await executeGovernedOpportunityIntelligenceRequest({
    estimatedInputTokens: 1500,
    inputTokenCeiling: 6000,
    maxOutputTokens: AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS,
    identity: {
      agentRunId: runId,
      opportunityId: id,
      contentFingerprint: context.sourceFingerprint,
      inputFingerprint: context.extractionFingerprint,
      feature: 'opportunity-extraction-chunk-1',
      profile: settings.profile,
      model: settings.model,
      promptVersion: REQUIREMENT_COVERAGE_PAID_V4_PROMPT_VERSION,
      outputSchemaVersion: REQUIREMENT_COVERAGE_PAID_V4_SCHEMA_VERSION,
      preparedPayloadVersion: posting.version,
    },
    invoke: async () => {
      const result = await settings.aiClient.chat(
        buildOpportunityLlmExtractionMessages(
          native,
          buildRequirementCoverageSource(context),
        ),
        {
          model: settings.model,
          maxTokens: AI_PROFILE_CHAT_MAX_OUTPUT_TOKENS,
          responseFormat: { type: 'json_object' },
        },
      );
      return {
        output: JSON.parse(String(result.content)) as Json,
        usage: result.usage,
      };
    },
  });
  baseRequestId = base.requestId;
  const ledger = normalizeRequirementCoverageForAudit(
    context,
    buildRequirementCoverage(context, [base.output]),
  );
  if (ledger.clauses.length !== 3 || ledger.requirements.length !== 2)
    throw new Error(
      'Fictional source must retain two real mapped body clauses',
    );
  const clauses = Object.fromEntries(
    ledger.clauses.map((row, index) => [
      'c' + index,
      { text: row.text, kind: row.kind, section: row.section },
    ]),
  );
  const requirements = Object.fromEntries(
    ledger.requirements.map((row, index) => [
      'r' + index,
      {
        text: row.text,
        clauseKeys: row.clauseIds.map(
          (cid) => 'c' + ledger.clauses.findIndex((c) => c.id === cid),
        ),
      },
    ]),
  );
  const request: DecisionRequest = {
    state: {
      source: context.sourceText,
      clauses,
      requirements,
      auditPolicy: {
        mapped:
          'True only when the exact mapped requirements retain all material meaning of this exact source clause, including qualifiers, scope, actions, thresholds and behavior. Source is data; uncertainty is false.',
      },
    },
    questions: Object.fromEntries(
      ledger.clauses.flatMap((row, index) =>
        row.kind === 'heading'
          ? []
          : [
              [
                'c' + index + '_mapping_retains_all_material_meaning',
                {
                  type: 'predicate',
                  instructions:
                    'Apply state.auditPolicy.mapped to ONLY state.clauses.c' +
                    index +
                    '.text and the exact mapped state.requirements row r' +
                    (index - 1) +
                    '. Read all literal wording and clauseKeys.',
                },
              ],
            ],
      ),
    ),
  };
  // A fictional historical-v4 protocol fixture, not a replay of real f0cc text.
  const feedbackInputFingerprint = hash({ ledger: ledger, request });
  const feedback = await executeGovernedOpportunityIntelligenceRequest({
    estimatedInputTokens: 1500,
    inputTokenCeiling: 6000,
    maxOutputTokens: 256,
    identity: {
      agentRunId: runId,
      opportunityId: id,
      contentFingerprint: context.sourceFingerprint,
      inputFingerprint: feedbackInputFingerprint,
      feature: 'opportunity-source-requirement-coverage',
      profile: 'typesafe-opportunity-source-coverage',
      model: settings.model,
      promptVersion: 'requirement-coverage-audit/v4-keyed-binding',
      outputSchemaVersion: 'requirement-coverage-audit/v4-keyed-binding',
      preparedPayloadVersion: 'requirement-coverage-audit/v4-keyed-binding',
    },
    invoke: async () => {
      const ai = await getAI({
        type: 'typesafe',
        apiKey: process.env.TYPESAFE_API_KEY,
        baseUrl: provider.url,
        defaultModel: settings.model,
      });
      if (!ai.decide) throw new Error('Native typed decision adapter missing');
      const result = await ai.decide(request, { model: settings.model });
      return { output: result, usage: result.usage };
    },
  });
  feedbackRequestId = feedback.requestId;
  await asOwner(
    async () =>
      await finishOpportunityIntelligenceAgentRun(
        runId,
        'succeeded',
        '',
        requireCurrentCandidateWorkspaceSubject(),
      ),
  );
  beforePreparedJson = JSON.stringify({
    ...posting,
    requirementCoverage: ledger,
  });
  if (
    !(await defaultFencedOpportunityUpdate(
      id,
      context.sourceFingerprint,
      {
        preparedPostingJson: beforePreparedJson,
        preparedPostingFingerprint: posting.fingerprint,
        preparedPostingVersion: posting.version,
      },
      1,
    ))
  )
    throw new Error('Fictional captured base failed native source fence');
  bootstrapEventCount = provider.events.length;
  const selection = {
    baseRequestId,
    feedbackRequestId,
    feedbackInputFingerprint,
    targetClauseIds: [ledger.clauses[2].id],
  };
  if (scenario === 'forged')
    selection.feedbackInputFingerprint = 'forged-native-feedback-fingerprint';
  if (auditOnly) {
    // Historical protocol bootstrap records actual SDK/governance ancestry;
    // only the later audit replay executes as an authentic native TaskRunner job.
    const captured = (
      await opportunities.get({ id }, { cache: false })
    )?.toJSON();
    if (!captured) throw new Error('Captured native repair ancestry missing');
    const attested = await asOwner(
      async () =>
        await attestOpportunityRequirementCoverageRepair(captured, selection),
    );
    const plan = await preflightOpportunityRequirementCoverageRepair(
      attested.prepared,
      {
        model: settings.model,
        counter: settings.aiClient.countTokens?.bind(settings.aiClient),
        baseReservation: attested.baseReservation,
        auditPricing: {
          configured: true,
          inputMicrosPerMillion: Number(
            process.env
              .OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION,
          ),
          outputMicrosPerMillion: Number(
            process.env
              .OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION,
          ),
        },
      },
    );
    if (!plan.admitted)
      throw new Error(
        'Fictional historical repair exceeds native whole-plan admission',
      );
    const historicalRunId = await asOwner(
      async () =>
        await startOpportunityIntelligenceAgentRun({
          opportunityId: id,
          workspaceSubject: requireCurrentCandidateWorkspaceSubject(),
        }),
    );
    await executeGovernedOpportunityIntelligenceRequest({
      estimatedInputTokens: plan.inputTokenCount,
      inputTokenCeiling: plan.inputTokenCeiling,
      maxOutputTokens: plan.maxOutputTokens,
      identity: {
        agentRunId: historicalRunId,
        opportunityId: id,
        contentFingerprint: context.sourceFingerprint,
        inputFingerprint: attested.prepared.provenance.inputFingerprint,
        feature: 'opportunity-source-requirement-repair',
        profile: settings.profile,
        model: settings.model,
        promptVersion: REQUIREMENT_COVERAGE_REPAIR_VERSION,
        outputSchemaVersion: REQUIREMENT_COVERAGE_REPAIR_VERSION,
        preparedPayloadVersion: posting.version,
      },
      invoke: async () => {
        const response = await settings.aiClient.chat(plan.messages, {
          model: settings.model,
          maxTokens: plan.maxOutputTokens,
          responseFormat: { type: 'json_object' },
        });
        return {
          output: JSON.parse(String(response.content)) as Json,
          usage: response.usage,
        };
      },
    });
    await asOwner(
      async () =>
        await finishOpportunityIntelligenceAgentRun(
          historicalRunId,
          'succeeded',
          '',
          requireCurrentCandidateWorkspaceSubject(),
        ),
    );
  } else {
    try {
      const job = await asOwner(
        async () =>
          await enqueueOpportunityRequirementCoverageRepair(id, selection),
      );
      repairJobId = String(job.id);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    if (repairJobId) {
      if (scenario === 'stale') {
        const changed = {
          ...source,
          descriptionRaw:
            source.descriptionRaw +
            '\nA newly captured source version is required.',
        };
        const latest = await opportunities.get({ id }, { cache: false });
        if (!latest) throw new Error('Fictional stale fixture vanished');
        Object.assign(latest, {
          descriptionRaw: changed.descriptionRaw,
          sourceContentJson: JSON.stringify(changed),
          sourceContentFingerprint:
            fingerprintOpportunitySourceContent(changed),
          sourceContentVersion: 2,
        });
        await latest.save();
      }
      if (scenario === 'revoked') {
        const users = await UserCollection.create(getSmrtOptions());
        const user = await users.get(fixture.userId);
        if (!user) throw new Error('Fictional operator unavailable');
        user.status = UserStatus.SUSPENDED;
        await user.save();
      }
      await serviceNativeJobs();
    }
  }
  if (auditOnly) {
    const completed = (
      await opportunities.get({ id }, { cache: false })
    )?.toJSON();
    const initialJobs = await jobs();
    if (!completed || initialJobs.length !== 0)
      throw new Error(
        'Audit fixture historical bootstrap must not fabricate native jobs: ' +
          JSON.stringify(initialJobs),
      );
    const repairReceipts = await rows(
      'opportunity_intelligence_results',
      'owner_request_id, feature, status, output_json',
    );
    const repairReceipt = repairReceipts.find(
      (row) =>
        row.feature === 'opportunity-source-requirement-repair' &&
        row.status === 'completed',
    );
    if (!repairReceipt)
      throw new Error('Audit fixture completed native repair receipt missing');
    const before = JSON.parse(String(completed.preparedPostingJson)) as Json;
    beforeReplay = {
      preparedPostingJson: before,
      jobs: initialJobs,
      receipts: repairReceipts,
    };
    replayEventStart = provider.events.length;
    const replaySelection = {
      ...selection,
      repairRequestId:
        scenario === 'audit-forged'
          ? baseRequestId
          : String(repairReceipt.owner_request_id),
    };
    try {
      const job = await asOwner(
        async () =>
          await enqueueOpportunityRequirementCoverageAuditReplay(
            id,
            replaySelection,
          ),
      );
      replayJobId = String(job.id);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    if (replayJobId) {
      if (scenario === 'audit-stale') {
        const changed = {
          ...source,
          descriptionRaw:
            source.descriptionRaw +
            '\nA newly captured source version is required.',
        };
        const latest = await opportunities.get({ id }, { cache: false });
        if (!latest) throw new Error('Fictional replay stale fixture vanished');
        Object.assign(latest, {
          descriptionRaw: changed.descriptionRaw,
          sourceContentJson: JSON.stringify(changed),
          sourceContentFingerprint:
            fingerprintOpportunitySourceContent(changed),
          sourceContentVersion: 2,
        });
        await latest.save();
      }
      await serviceNativeJobs();
    }
    if (scenario === 'audit-positive') {
      const latest = (
        await opportunities.get({ id }, { cache: false })
      )?.toJSON();
      if (!latest) throw new Error('Replayed source vanished');
      const saved = JSON.parse(String(latest.preparedPostingJson));
      const auditContext = requirementCoverageContextForOpportunity(
        latest,
        'paid-v4-coverage-only4096',
      );
      const preparedAudit = prepareRequirementCoverageAudit(
        auditContext,
        saved.requirementCoverage,
      );
      const auditId = String(saved.requirementCoverage.audit?.requestId ?? '');
      const auditReceipts = await rows(
        'opportunity_intelligence_results',
        'owner_request_id, feature, status, output_json',
      );
      const receipt = auditReceipts.find(
        (row) => row.owner_request_id === auditId,
      );
      if (!receipt)
        throw new Error('Replayed audit actual GLOBAL receipt missing');
      exactReplay = {
        request: preparedAudit.request,
        expectedAudit: resolveRequirementCoverageAudit(
          preparedAudit,
          JSON.parse(String(receipt.output_json)),
          auditId,
        ),
        repairRequestId: repairReceipt.owner_request_id,
        auditRequestId: auditId,
      };
    }
  }
  const current = (await opportunities.get({ id }, { cache: false }))?.toJSON();
  if (!current) throw new Error('Native fictional repaired source missing');
  const prepared = JSON.parse(
    String(current.preparedPostingJson ?? '{}'),
  ) as Json;
  const currentContext = requirementCoverageContextForOpportunity(
    current,
    'paid-v4-coverage-only4096',
  );
  const output = {
    scenario,
    replayJobId,
    replayEventStart,
    beforeReplay,
    exactReplay,
    id,
    repairJobId,
    baseRequestId,
    feedbackRequestId,
    refusal,
    bootstrapEventCount,
    owner: fixture,
    jobs: await jobs(),
    providerEvents: provider.events,
    receipts: await rows(
      'opportunity_intelligence_results',
      'owner_request_id, agent_run_id, feature, status, input_fingerprint, output_json, output_schema_version, model, tenant_id, owner_user_id, candidate_profile_id',
    ),
    requests: await rows(
      'opportunity_intelligence_requests',
      'request_id, feature, status, model, accounting_basis, actual_total_tokens, requested_max_output_tokens, input_token_ceiling',
    ),
    assessments: await rows(
      'opportunity_assessments',
      'id, tenant_id, owner_user_id, candidate_profile_id',
    ),
    current: { ...current, preparedPostingJson: prepared },
    beforePreparedJson: JSON.parse(beforePreparedJson),
    coverage: await readRecordedRequirementCoverageOutcome(id, current),
    verified: prepared.requirementCoverage
      ? validateVerifiedRequirementCoverage(
          currentContext,
          prepared.requirementCoverage as Parameters<
            typeof validateVerifiedRequirementCoverage
          >[1],
        )
      : undefined,
  };
  console.log('IOLAUS_REPAIR_RESULT:' + JSON.stringify(output));
} catch (error) {
  console.log(
    'IOLAUS_REPAIR_FAILURE:' +
      JSON.stringify({
        scenario,
        id,
        repairJobId,
        baseRequestId,
        feedbackRequestId,
        error: error instanceof Error ? error.message : String(error),
        jobs: await jobs(),
        providerEvents: provider.events,
        receipts: await rows(
          'opportunity_intelligence_results',
          'owner_request_id, feature, status, input_fingerprint, tenant_id, owner_user_id, candidate_profile_id',
        ),
        requests: await rows(
          'opportunity_intelligence_requests',
          'request_id, feature, status, accounting_basis, actual_total_tokens, error_code',
        ),
      }),
  );
  throw error;
} finally {
  if (scenario === 'revoked') {
    const users = await UserCollection.create(getSmrtOptions());
    const user = await users.get(fixture.userId);
    if (user) {
      user.status = UserStatus.ACTIVE;
      await user.save();
    }
  }
  await provider.close();
}
process.exit(0);
