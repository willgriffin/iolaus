import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
} from '@happyvertical/smrt-jobs';
import {
  runOpportunityLifecycleTransaction,
  withOpportunityLifecycleLock,
} from './application-workflow.js';
import { getDbConfig, getSmrtOptions } from './db.js';
import {
  type RuntimeWorkspaceSubject,
  requireActiveRunnerExecutionContext,
  runAsRevalidatedJobWorkspaceSubject,
  runtimeWorkspaceSubjectFromJobArgs,
  withRuntimeWorkspaceSubject,
} from './job-workspace-subject.js';
import { defaultFencedOpportunityUpdate } from './opportunity-details.js';
import {
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import {
  buildRequirementCoverage,
  normalizeRequirementCoverageForAudit,
  type PreparedRequirementCoverageRepair,
  prepareRequirementCoverageRepair,
  REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION,
  REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION,
  requirementCoverageContextForOpportunity,
} from './opportunity-requirement-coverage.js';
import { requirementCoverageSourceDependencyFingerprint } from './opportunity-requirement-coverage-provider.js';
import { opportunityWithSourceContent } from './opportunity-source-content.js';
import { getCollection } from './smrt.js';
import { requireSourceCrawlOperator } from './source-crawl-operator.js';

const HISTORICAL_LITERAL_AUDIT_VERSION =
  'requirement-coverage-audit/v4-keyed-binding';
export const SOURCE_COVERAGE_REPAIR_JOB_CONTRACT =
  'native-source-coverage-repair/v1';

/** Explicit operator-selected historical identities, never a supplied ledger. */
export interface SourceCoverageRepairReceiptSelection {
  baseRequestId: string;
  feedbackRequestId: string;
  feedbackInputFingerprint: string;
  targetClauseIds: string[];
}

/** Native operator-only submission; receipt/source fields are server-derived. */
export async function enqueueOpportunityRequirementCoverageRepair(
  opportunityId: string,
  selection: SourceCoverageRepairReceiptSelection,
): Promise<SmrtJob> {
  requireSourceCrawlOperator();
  const args = withRuntimeWorkspaceSubject({});
  const subject = runtimeWorkspaceSubjectFromJobArgs(args);
  return await runAsRevalidatedJobWorkspaceSubject(
    subject,
    'audit.record',
    async (_fresh, run) => {
      requireSourceCrawlOperator();
      await run.assertOperation('opportunities', 'read');
      await run.assertOperation('opportunities', 'update');
      return await withOpportunityLifecycleLock(
        identifier(opportunityId),
        async () =>
          await runAsRevalidatedJobWorkspaceSubject(
            subject,
            'audit.record',
            async (_current, currentRun) => {
              requireSourceCrawlOperator();
              await currentRun.assertOperation('opportunities', 'read');
              await currentRun.assertOperation('opportunities', 'update');
              const opportunity = await (
                await getCollection('Opportunity')
              ).get(opportunityId);
              if (!opportunity)
                throw new Error('Source repair opportunity is missing.');
              const native = opportunity.toJSON();
              const attested = await attestOpportunityRequirementCoverageRepair(
                native,
                selection,
              );
              const jobs = await SmrtJobCollection.create(getSmrtOptions());
              return await jobs.enqueueJob({
                objectId: opportunityId,
                objectType: '@willgriffin/iolaus-site:Opportunity',
                method: 'prepareAssessmentCoverage',
                queue: 'opportunity-intelligence',
                tenantId: subject.tenantId,
                maxAttempts: 1,
                timeout: 3 * 60 * 1000,
                priority: 80,
                args: {
                  ...args,
                  contentFingerprint: native.sourceContentFingerprint,
                  contentVersion: native.sourceContentVersion,
                  sourceDependencyFingerprint:
                    requirementCoverageSourceDependencyFingerprint(native),
                  repairInputFingerprint:
                    attested.prepared.provenance.inputFingerprint,
                  sourceCoverageRepair: {
                    contract: SOURCE_COVERAGE_REPAIR_JOB_CONTRACT,
                    baseRequestId: attested.prepared.provenance.baseRequestId,
                    feedbackRequestId:
                      attested.prepared.provenance.feedbackRequestId,
                    feedbackInputFingerprint:
                      attested.prepared.provenance.feedbackAuditFingerprint,
                    targetClauseIds: [
                      ...attested.prepared.provenance.targetClauseIds,
                    ],
                  },
                },
              });
            },
          ),
      );
    },
  );
}

export interface SourceCoverageHistoricalReservation {
  calls: number;
  reservedTokens: number;
  spendMicros: number;
}

export interface AttestedSourceCoverageRepair {
  prepared: PreparedRequirementCoverageRepair;
  /** Kept separate: lifecycle admission must apply the root-approved policy. */
  baseReservation: SourceCoverageHistoricalReservation;
  feedbackReservation: SourceCoverageHistoricalReservation;
  feedbackAuthority: 'native-persisted-historical-request-identity';
}

type NativeReceipt = Record<string, unknown>;
type ReceiptDatabase = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: NativeReceipt[] }>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Source repair receipt is malformed.');
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new Error('Source repair receipt identity is invalid.');
  return value;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error('Source repair receipt lacks bounded actual accounting.');
  return number;
}

function reservation(
  receipt: NativeReceipt,
): SourceCoverageHistoricalReservation {
  const input = positiveInteger(receipt.reserved_input_tokens);
  const output = positiveInteger(receipt.requested_max_output_tokens);
  const reservedTokens = input + output;
  if (!Number.isSafeInteger(reservedTokens))
    throw new Error('Source repair receipt reservation is invalid.');
  return {
    calls: 1,
    reservedTokens,
    spendMicros: positiveInteger(receipt.reserved_spend_micros),
  };
}

function requireNativeReceipt(
  receipt: NativeReceipt,
  expected: {
    requestId: string;
    opportunityId: string;
    sourceFingerprint: string;
    inputFingerprint: string;
    feature: string;
    promptVersion: string;
    schemaVersion: string;
  },
): void {
  if (
    receipt.owner_request_id !== expected.requestId ||
    receipt.request_id !== expected.requestId ||
    receipt.request_opportunity_id !== expected.opportunityId ||
    receipt.opportunity_id !== expected.opportunityId ||
    receipt.content_fingerprint !== expected.sourceFingerprint ||
    receipt.request_content_fingerprint !== expected.sourceFingerprint ||
    receipt.input_fingerprint !== expected.inputFingerprint ||
    receipt.request_input_fingerprint !== expected.inputFingerprint ||
    receipt.feature !== expected.feature ||
    receipt.request_feature !== expected.feature ||
    receipt.prompt_version !== expected.promptVersion ||
    receipt.output_schema_version !== expected.schemaVersion ||
    receipt.status !== 'completed' ||
    receipt.request_status !== 'succeeded' ||
    receipt.accounting_basis !== 'actual' ||
    [
      'tenant_id',
      'owner_user_id',
      'candidate_profile_id',
      'request_tenant_id',
      'request_owner_user_id',
      'request_candidate_profile_id',
    ].some((key) => receipt[key] !== '' && receipt[key] !== null)
  )
    throw new Error(
      'Source repair requires exact completed GLOBAL native receipts.',
    );
  positiveInteger(receipt.actual_total_tokens);
}

/** Read-only native bootstrap. No provider call or historical mutation occurs. */
export async function attestOpportunityRequirementCoverageRepair(
  opportunity: Record<string, unknown>,
  selection: SourceCoverageRepairReceiptSelection,
  database?: ReceiptDatabase,
): Promise<AttestedSourceCoverageRepair> {
  const opportunityId = identifier(opportunity.id);
  const baseRequestId = identifier(selection.baseRequestId);
  const feedbackRequestId = identifier(selection.feedbackRequestId);
  const feedbackInputFingerprint = identifier(
    selection.feedbackInputFingerprint,
  );
  if (baseRequestId === feedbackRequestId)
    throw new Error(
      'Source repair requires distinct base and feedback receipts.',
    );
  const planned = prepareOpportunityPosting(
    opportunityWithSourceContent(opportunity),
  );
  if (opportunity.preparedPostingFingerprint !== planned.fingerprint)
    throw new Error(
      'Source repair requires the current canonical prepared source.',
    );
  const context = requirementCoverageContextForOpportunity({
    ...opportunity,
    preparedPostingFingerprint: planned.fingerprint,
  });
  identifier(context.sourceFingerprint);
  positiveInteger(context.sourceVersion);
  const db = database ?? (await resolveDatabase(getDbConfig()));
  const result = await db.query(
    `SELECT r.owner_request_id, r.opportunity_id, r.content_fingerprint,
      r.input_fingerprint, r.feature, r.prompt_version, r.output_schema_version,
      r.status, r.output_json, r.tenant_id, r.owner_user_id, r.candidate_profile_id,
      q.request_id, q.opportunity_id AS request_opportunity_id,
      q.content_fingerprint AS request_content_fingerprint,
      q.input_fingerprint AS request_input_fingerprint, q.feature AS request_feature,
      q.status AS request_status, q.accounting_basis, q.actual_total_tokens,
      q.reserved_input_tokens, q.requested_max_output_tokens, q.reserved_spend_micros,
      q.tenant_id AS request_tenant_id, q.owner_user_id AS request_owner_user_id,
      q.candidate_profile_id AS request_candidate_profile_id
    FROM opportunity_intelligence_results r
    JOIN opportunity_intelligence_requests q ON q.request_id = r.owner_request_id
    WHERE r.owner_request_id IN (?, ?) AND r.opportunity_id = ?
      AND COALESCE(r.tenant_id, '') = '' AND COALESCE(r.owner_user_id, '') = ''
      AND COALESCE(r.candidate_profile_id, '') = ''
      AND COALESCE(q.tenant_id, '') = '' AND COALESCE(q.owner_user_id, '') = ''
      AND COALESCE(q.candidate_profile_id, '') = ''`,
    [baseRequestId, feedbackRequestId, opportunityId],
  );
  const bases = result.rows.filter(
    (row) => row.owner_request_id === baseRequestId,
  );
  const feedbacks = result.rows.filter(
    (row) => row.owner_request_id === feedbackRequestId,
  );
  if (bases.length !== 1 || feedbacks.length !== 1 || result.rows.length !== 2)
    throw new Error('Source repair native receipts are missing or ambiguous.');
  const baseReceipt = bases[0];
  const feedbackReceipt = feedbacks[0];
  requireNativeReceipt(baseReceipt, {
    requestId: baseRequestId,
    opportunityId,
    sourceFingerprint: context.sourceFingerprint,
    inputFingerprint: context.extractionFingerprint,
    feature: 'opportunity-extraction-chunk-1',
    promptVersion: REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION,
    schemaVersion: REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION,
  });
  requireNativeReceipt(feedbackReceipt, {
    requestId: feedbackRequestId,
    opportunityId,
    sourceFingerprint: context.sourceFingerprint,
    inputFingerprint: feedbackInputFingerprint,
    feature: 'opportunity-source-requirement-coverage',
    promptVersion: HISTORICAL_LITERAL_AUDIT_VERSION,
    schemaVersion: HISTORICAL_LITERAL_AUDIT_VERSION,
  });
  const base = normalizeRequirementCoverageForAudit(
    context,
    buildRequirementCoverage(context, [
      JSON.parse(String(baseReceipt.output_json)),
    ]),
  );
  const answers = record(
    record(JSON.parse(String(feedbackReceipt.output_json))).answers,
  );
  const probabilities: Record<string, number> = {};
  for (const [index, clause] of base.clauses.entries()) {
    if (clause.kind !== 'body') continue;
    const disposition = base.dispositions.find(
      (row) => row.clauseId === clause.id,
    );
    if (!disposition)
      throw new Error('Source repair base clause mapping is missing.');
    const nonmaterial =
      disposition.type === 'nonrequirement' ||
      disposition.type === 'source_context' ||
      disposition.auditPending === 'nonmaterial';
    const key = `c${index}_${nonmaterial ? 'contains_no_material_criterion' : 'mapping_retains_all_material_meaning'}`;
    const answer = record(answers[key]);
    if (
      answer.type !== 'predicate' ||
      typeof answer.probability !== 'number' ||
      !Number.isFinite(answer.probability) ||
      answer.probability < 0 ||
      answer.probability > 1
    )
      throw new Error(
        'Source repair requires every recorded body clause probability.',
      );
    probabilities[clause.id] = answer.probability;
  }
  const prepared = prepareRequirementCoverageRepair(
    context,
    base,
    baseRequestId,
    {
      sourceFingerprint: context.sourceFingerprint,
      sourceVersion: context.sourceVersion,
      extractionFingerprint: context.extractionFingerprint,
      auditInputFingerprint: feedbackInputFingerprint,
      requestId: feedbackRequestId,
      probabilities,
    },
    selection.targetClauseIds,
    { inputTokenCeiling: 6000, maxOutputTokens: 4096 },
  );
  return {
    prepared,
    baseReservation: reservation(baseReceipt),
    feedbackReservation: reservation(feedbackReceipt),
    feedbackAuthority: 'native-persisted-historical-request-identity',
  };
}

interface RepairProcessorOptions {
  agentRunId: string;
  expectedSourceContentFingerprint: string;
  sourceContentVersion: number;
  baseReservation: SourceCoverageHistoricalReservation;
  assertCurrentAuthority: () => Promise<void>;
  fencedOpportunityUpdate: typeof defaultFencedOpportunityUpdate;
}

interface RepairJobDependencies {
  getOpportunity?: (id: string) => Promise<Record<string, unknown> | null>;
  getJob?: (id: string) => Promise<SmrtJob | null>;
  attest?: typeof attestOpportunityRequirementCoverageRepair;
  /** Supplied by the frozen source runtime; never an AI/provider test adapter. */
  processRepair: (
    id: string,
    prepared: PreparedRequirementCoverageRepair,
    options: RepairProcessorOptions,
  ) => Promise<{ status: string; message: string }>;
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  requireOperator?: typeof requireSourceCrawlOperator;
  withLock?: typeof withOpportunityLifecycleLock;
  transaction?: typeof runOpportunityLifecycleTransaction;
  update?: typeof defaultFencedOpportunityUpdate;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
}

/** Explicit source-only repair on the existing native source method. */
export async function runOpportunityRequirementCoverageRepairJob(
  opportunityId: string,
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  dependencies: RepairJobDependencies,
): Promise<{ status: string; message: string }> {
  const runner = requireActiveRunnerExecutionContext(context);
  if (
    runner.job.queue !== 'opportunity-intelligence' ||
    runner.job.objectType !== '@willgriffin/iolaus-site:Opportunity' ||
    runner.job.method !== 'prepareAssessmentCoverage' ||
    runner.job.tenantId !== subject.tenantId
  )
    throw new Error('Source repair requires its authentic native source job.');
  const runFresh = dependencies.runFresh ?? runAsRevalidatedJobWorkspaceSubject;
  const requireOperator =
    dependencies.requireOperator ?? requireSourceCrawlOperator;
  const getOpportunity =
    dependencies.getOpportunity ??
    (async (id) => {
      const opportunity = await (await getCollection('Opportunity')).get(id);
      return opportunity ? opportunity.toJSON() : null;
    });
  const getJob =
    dependencies.getJob ??
    (async (id) =>
      await (await SmrtJobCollection.create(getSmrtOptions())).get(id));
  const attest =
    dependencies.attest ?? attestOpportunityRequirementCoverageRepair;
  const withLock = dependencies.withLock ?? withOpportunityLifecycleLock;
  const transaction =
    dependencies.transaction ?? runOpportunityLifecycleTransaction;
  const update = dependencies.update ?? defaultFencedOpportunityUpdate;
  const startRun =
    dependencies.startRun ?? startOpportunityIntelligenceAgentRun;
  const finishRun =
    dependencies.finishRun ?? finishOpportunityIntelligenceAgentRun;
  const fresh = async <T>(work: (run: PrincipalRun) => Promise<T>) =>
    await runFresh(subject, 'audit.record', async (_subject, run) => {
      requireOperator();
      await run.assertOperation('opportunities', 'read');
      await run.assertOperation('opportunities', 'update');
      return await work(run);
    });
  // Validate before waiting for the lease, and independently again afterwards.
  await fresh(async () => undefined);
  return await withLock(
    opportunityId,
    async () =>
      await fresh(async () => {
        const job = await getJob(identifier(runner.job.jobId));
        if (
          !job ||
          job.status !== 'running' ||
          job.attempts !== runner.job.attempt ||
          job.tenantId !== subject.tenantId ||
          job.queue !== runner.job.queue ||
          job.objectType !== runner.job.objectType ||
          job.method !== runner.job.method ||
          job.objectId !== opportunityId
        )
          throw new Error('Source repair durable job is not current.');
        const storedSubject = runtimeWorkspaceSubjectFromJobArgs(job.args);
        if (
          storedSubject.tenantId !== subject.tenantId ||
          storedSubject.userId !== subject.userId ||
          storedSubject.profileId !== subject.profileId
        )
          throw new Error('Source repair durable owner is not current.');
        const current = await getOpportunity(opportunityId);
        if (
          !current ||
          current.id !== opportunityId ||
          job.args.contentFingerprint !== current.sourceContentFingerprint ||
          job.args.contentVersion !== current.sourceContentVersion ||
          job.args.sourceDependencyFingerprint !==
            requirementCoverageSourceDependencyFingerprint(current)
        )
          throw new Error('Source repair durable source is not current.');
        const intent = record(job.args.sourceCoverageRepair);
        if (
          intent.contract !== SOURCE_COVERAGE_REPAIR_JOB_CONTRACT ||
          !Array.isArray(intent.targetClauseIds) ||
          !intent.targetClauseIds.every((id) => typeof id === 'string')
        )
          throw new Error(
            'Source repair requires an explicit native operator intent.',
          );
        const selection: SourceCoverageRepairReceiptSelection = {
          baseRequestId: identifier(intent.baseRequestId),
          feedbackRequestId: identifier(intent.feedbackRequestId),
          feedbackInputFingerprint: identifier(intent.feedbackInputFingerprint),
          targetClauseIds: intent.targetClauseIds,
        };
        const attested = await attest(current, selection);
        const prepared = attested.prepared;
        if (
          job.args.repairInputFingerprint !==
          prepared.provenance.inputFingerprint
        )
          throw new Error(
            'Source repair durable attestation fingerprint is not current.',
          );
        const agentRunId = await startRun({
          opportunityId,
          sourceId:
            typeof current.sourceId === 'string' ? current.sourceId : '',
          userId: subject.userId,
          workspaceSubject: subject,
        });
        try {
          // Only this authentic native row can carry the provider correlation link.
          job.args = {
            ...job.args,
            sourcePreparationAgentRunId: agentRunId,
            repairInputFingerprint: prepared.provenance.inputFingerprint,
          };
          await job.save();
          const requireCurrentSource = async () => {
            const latest = await getOpportunity(opportunityId);
            if (
              !latest ||
              latest.sourceContentFingerprint !==
                prepared.context.sourceFingerprint ||
              latest.sourceContentVersion !== prepared.context.sourceVersion ||
              requirementCoverageSourceDependencyFingerprint(latest) !==
                job.args.sourceDependencyFingerprint
            )
              throw new Error(
                'Source repair source changed before persistence.',
              );
          };
          const assertCurrentAuthority = async () =>
            await fresh(async () => await requireCurrentSource());
          const result = await dependencies.processRepair(
            opportunityId,
            prepared,
            {
              agentRunId,
              expectedSourceContentFingerprint:
                prepared.context.sourceFingerprint,
              sourceContentVersion: prepared.context.sourceVersion,
              baseReservation: attested.baseReservation,
              assertCurrentAuthority,
              fencedOpportunityUpdate: async (id, fingerprint, updates) =>
                await fresh(async () => {
                  if (
                    id !== opportunityId ||
                    fingerprint !== prepared.context.sourceFingerprint
                  )
                    throw new Error(
                      'Source repair publication identity is invalid.',
                    );
                  await requireCurrentSource();
                  return await transaction(
                    async (database) =>
                      await update(
                        id,
                        fingerprint,
                        updates,
                        prepared.context.sourceVersion,
                        database,
                      ),
                  );
                }),
            },
          );
          await finishRun(
            agentRunId,
            result.status === 'processed' ? 'succeeded' : 'failed',
            result.status === 'processed' ? '' : result.message,
            subject,
          );
          return result;
        } catch (error) {
          await finishRun(
            agentRunId,
            'failed',
            error instanceof Error ? error.message : String(error),
            subject,
          );
          throw error;
        }
      }),
  );
}
