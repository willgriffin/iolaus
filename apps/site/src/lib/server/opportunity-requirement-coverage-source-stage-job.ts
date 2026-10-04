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
import {
  defaultFencedOpportunityUpdate,
  type OpportunityLlmExtractionOptions,
  processOpportunityWithLlm,
} from './opportunity-details.js';
import {
  type OpportunityIntelligenceBudgetConfig,
  reservedRequestSpendMicros,
  resolveOpportunityIntelligenceBudgetConfig,
} from './opportunity-intelligence-config.js';
import {
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import {
  buildRequirementCoverage,
  normalizeRequirementCoverageForAudit,
  REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION,
  REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION,
  requirementCoverageContextForOpportunity,
} from './opportunity-requirement-coverage.js';
import {
  evaluateRequirementCoverageAudit,
  evaluateRequirementEvidenceAudit,
  preflightRequirementCoverageAudit,
  preflightRequirementCoverageLifecycle,
  preflightRequirementEvidenceAudit,
  prepareCapturedSourceCompositeRequirementEvidenceAudit,
  prepareQuarantinedSourceCompositeRequirementEvidenceAudit,
  prepareCompositeRequirementEvidenceAudit,
  prepareRequirementCoverageAudit,
  prepareSourceEligibilityCompositeRequirementEvidenceAudit,
  REQUIREMENT_EVIDENCE_AUDIT_VERSION,
  REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
  REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION,
  REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION,
  readPartialOpportunityRequirementEvidence,
  readVerifiedOpportunitySourceEligibilityEvidence,
  requirementCoverageLedgerFingerprint,
  requirementCoverageSourceDependencyFingerprint,
  validateVerifiedRequirementCoverage,
} from './opportunity-requirement-coverage-provider.js';
import { OPPORTUNITY_SCREENING_SUPPORTED_VERSIONS } from './opportunity-screening.js';
import {
  OPPORTUNITY_SCREENING_FEATURE,
  OPPORTUNITY_SCREENING_PROFILE,
} from './opportunity-screening-provider.js';
import { opportunityWithSourceContent } from './opportunity-source-content.js';
import { getCollection } from './smrt.js';
import { requireSourceCrawlOperator } from './source-crawl-operator.js';

export const SOURCE_COVERAGE_STAGE_JOB_CONTRACT =
  'native-source-coverage-stage/v1';
export const OPPORTUNITY_REQUIREMENT_EVIDENCE_AUDIT_PILOT_QUEUE =
  'opportunity-assessment-pilot';
export const OPPORTUNITY_REQUIREMENT_EVIDENCE_AUDIT_PILOT_CONTRACT =
  'native-source-evidence-audit-pilot/v1';
export const OPPORTUNITY_QUARANTINED_REQUIREMENT_EVIDENCE_AUDIT_PILOT_CONTRACT =
  'native-quarantined-source-evidence-audit-pilot/v1';
export type SourceRequirementEvidenceVersion =
  | typeof REQUIREMENT_EVIDENCE_AUDIT_VERSION
  | typeof REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION
  | typeof REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION
  | typeof REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION;
export type SourceCoverageStageSelection =
  | { stage: 'extract' }
  | { stage: 'audit_completed_extraction'; extractionRequestId: string }
  | {
      stage: 'evidence_completed_extraction';
      extractionRequestId: string;
      evidenceVersion?: SourceRequirementEvidenceVersion;
    };
function sourceRequirementEvidenceVersion(
  value: unknown,
): SourceRequirementEvidenceVersion {
  if (
    value !== REQUIREMENT_EVIDENCE_AUDIT_VERSION &&
    value !== REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION &&
    value !== REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION &&
    value !== REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION
  )
    throw new Error('Source evidence audit contract is not current.');
  return value;
}
type Row = Record<string, unknown>;
type ReceiptDatabase = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>;
};
export interface SourceCoverageReservation {
  calls: number;
  reservedTokens: number;
  spendMicros: number;
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in durable source identity values.
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw new Error('Source stage identity is invalid.');
  return value;
}
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Source stage intent is malformed.');
  return value as Row;
}
function positive(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error('Source stage requires bounded native actual accounting.');
  return number;
}
function publicReceipt(row: Row): boolean {
  return [
    'tenant_id',
    'owner_user_id',
    'candidate_profile_id',
    'request_tenant_id',
    'request_owner_user_id',
    'request_candidate_profile_id',
  ].every((key) => row[key] === '' || row[key] === null);
}

/** Native requestId is a selector only. Cache JSON never supplies audit authority. */
export async function attestCompletedOpportunitySourceExtraction(
  opportunity: Row,
  requestId: string,
  database?: ReceiptDatabase,
) {
  const opportunityId = identifier(opportunity.id);
  identifier(requestId);
  const posting = prepareOpportunityPosting(
    opportunityWithSourceContent(opportunity),
  );
  if (opportunity.preparedPostingFingerprint !== posting.fingerprint)
    throw new Error('Source stage requires current canonical prepared source.');
  const context = requirementCoverageContextForOpportunity({
    ...opportunity,
    preparedPostingFingerprint: posting.fingerprint,
  });
  identifier(context.sourceFingerprint);
  positive(context.sourceVersion);
  const db = database ?? (await resolveDatabase(getDbConfig()));
  // Carry only this exact native lifecycle, including its prior audit attempts.
  // Separate historical contracts remain in global accounting, not recharged.
  const { rows } = await db.query(
    `SELECT r.owner_request_id, r.request_id AS result_request_id,
    r.idempotency_key AS result_idempotency_key, q.idempotency_key AS request_idempotency_key, r.opportunity_id, r.content_fingerprint,
    r.input_fingerprint, r.feature, r.prompt_version, r.output_schema_version,
    r.prepared_payload_version, r.profile, r.model, r.status, r.output_json, r.agent_run_id,
    q.agent_run_id AS request_agent_run_id, a.tenant_id AS run_tenant_id,
    a.owner_user_id AS run_owner_user_id, a.candidate_profile_id AS run_candidate_profile_id,
    a.opportunity_id AS run_opportunity_id,
    r.tenant_id, r.owner_user_id, r.candidate_profile_id,
    q.request_id, q.opportunity_id AS request_opportunity_id,
    q.content_fingerprint AS request_content_fingerprint,
    q.input_fingerprint AS request_input_fingerprint, q.feature AS request_feature,
    q.profile AS request_profile, q.model AS request_model, q.status AS request_status,
    q.accounting_basis, q.actual_total_tokens, q.reserved_input_tokens,
    q.requested_max_output_tokens, q.reserved_spend_micros,
    q.tenant_id AS request_tenant_id, q.owner_user_id AS request_owner_user_id,
    q.candidate_profile_id AS request_candidate_profile_id
    FROM opportunity_intelligence_requests q
    LEFT JOIN opportunity_intelligence_results r ON r.owner_request_id = q.request_id
    LEFT JOIN agent_runs a ON CAST(a.id AS TEXT) = CAST(q.agent_run_id AS TEXT)
    WHERE q.opportunity_id = ? AND q.content_fingerprint = ?
    AND q.agent_run_id = (SELECT agent_run_id FROM opportunity_intelligence_requests WHERE request_id = ?)
    AND ((
      (q.feature LIKE 'opportunity-extraction-chunk-%' OR q.feature = 'opportunity-source-requirement-repair' OR q.feature = 'opportunity-source-requirement-coverage' OR q.feature = 'opportunity-source-requirement-evidence')
      AND COALESCE(q.tenant_id, '') = '' AND COALESCE(q.owner_user_id, '') = '' AND COALESCE(q.candidate_profile_id, '') = '')
      OR q.feature = 'opportunity-screening')`,
    [opportunityId, context.sourceFingerprint, requestId],
  );
  const selected = rows.filter((row) => row.request_id === requestId);
  if (selected.length !== 1)
    throw new Error(
      'Completed GLOBAL extraction receipt is missing or ambiguous.',
    );
  const receipt = selected[0];
  if (
    !publicReceipt(receipt) ||
    receipt.owner_request_id !== requestId ||
    receipt.result_request_id !== requestId ||
    typeof receipt.result_idempotency_key !== 'string' ||
    !receipt.result_idempotency_key ||
    receipt.result_idempotency_key !== receipt.request_idempotency_key ||
    receipt.opportunity_id !== opportunityId ||
    receipt.request_opportunity_id !== opportunityId ||
    receipt.content_fingerprint !== context.sourceFingerprint ||
    receipt.request_content_fingerprint !== context.sourceFingerprint ||
    receipt.input_fingerprint !== context.extractionFingerprint ||
    receipt.request_input_fingerprint !== context.extractionFingerprint ||
    receipt.feature !== 'opportunity-extraction-chunk-1' ||
    receipt.request_feature !== receipt.feature ||
    receipt.profile !== 'opportunity-intelligence-extraction' ||
    receipt.request_profile !== receipt.profile ||
    receipt.model !== 'openai/gpt-6-luna' ||
    receipt.request_model !== receipt.model ||
    receipt.prompt_version !== REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION ||
    receipt.output_schema_version !==
      REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION ||
    receipt.prepared_payload_version !== posting.version
  )
    throw new Error(
      'Completed extraction receipt does not match the exact current source contract.',
    );
  const agentRunId = identifier(receipt.agent_run_id);
  if (
    receipt.request_agent_run_id !== agentRunId ||
    receipt.run_opportunity_id !== opportunityId
  )
    throw new Error('Completed extraction native lifecycle is missing.');
  const workspaceSubject = {
    tenantId: identifier(receipt.run_tenant_id),
    userId: identifier(receipt.run_owner_user_id),
    profileId: identifier(receipt.run_candidate_profile_id),
  };
  const history: SourceCoverageReservation = {
    calls: 0,
    reservedTokens: 0,
    spendMicros: 0,
  };
  const seen = new Set<string>();
  for (const row of rows) {
    const nativeId = identifier(row.request_id);
    const screen = row.feature === OPPORTUNITY_SCREENING_FEATURE;
    const ownedReceipt = screen
      ? [
          ['tenant_id', workspaceSubject.tenantId],
          ['owner_user_id', workspaceSubject.userId],
          ['candidate_profile_id', workspaceSubject.profileId],
        ].every(
          ([key, value]) =>
            row[key] === value && row[`request_${key}`] === value,
        )
      : publicReceipt(row);
    if (
      screen &&
      (row.profile !== OPPORTUNITY_SCREENING_PROFILE ||
        !OPPORTUNITY_SCREENING_SUPPORTED_VERSIONS.some(
          (version) => row.prompt_version === version,
        ) ||
        row.output_schema_version !== row.prompt_version ||
        row.prepared_payload_version !== row.prompt_version ||
        typeof row.input_fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(row.input_fingerprint))
    ) {
      throw new Error(
        'Source lifecycle contains an invalid private screening contract; operator review is required.',
      );
    }
    if (
      seen.has(nativeId) ||
      row.agent_run_id !== agentRunId ||
      row.request_agent_run_id !== agentRunId ||
      row.run_opportunity_id !== opportunityId ||
      row.run_tenant_id !== workspaceSubject.tenantId ||
      row.run_owner_user_id !== workspaceSubject.userId ||
      row.run_candidate_profile_id !== workspaceSubject.profileId ||
      !ownedReceipt ||
      row.owner_request_id !== nativeId ||
      row.result_request_id !== nativeId ||
      typeof row.result_idempotency_key !== 'string' ||
      !row.result_idempotency_key ||
      row.result_idempotency_key !== row.request_idempotency_key ||
      row.status !== 'completed' ||
      row.request_status !== 'succeeded' ||
      row.accounting_basis !== 'actual' ||
      row.opportunity_id !== opportunityId ||
      row.request_opportunity_id !== opportunityId ||
      row.content_fingerprint !== context.sourceFingerprint ||
      row.request_content_fingerprint !== context.sourceFingerprint ||
      row.input_fingerprint !== row.request_input_fingerprint ||
      row.feature !== row.request_feature ||
      row.model !== row.request_model ||
      row.profile !== row.request_profile
    )
      throw new Error(
        'Source lifecycle contains an unattested or terminal failed native request; operator review is required.',
      );
    positive(row.actual_total_tokens);
    seen.add(nativeId);
    history.calls += 1;
    history.reservedTokens +=
      positive(row.reserved_input_tokens) +
      positive(row.requested_max_output_tokens);
    history.spendMicros += positive(row.reserved_spend_micros);
    if (
      !Number.isSafeInteger(history.reservedTokens) ||
      !Number.isSafeInteger(history.spendMicros)
    )
      throw new Error('Source lifecycle reservation is invalid.');
  }
  const output = object(JSON.parse(String(receipt.output_json)));
  const ledger = normalizeRequirementCoverageForAudit(
    context,
    buildRequirementCoverage(context, [output]),
  );
  return {
    requestId,
    opportunityId,
    agentRunId,
    workspaceSubject,
    context,
    posting,
    output,
    sourceContentJson:
      typeof opportunity.sourceContentJson === 'string'
        ? opportunity.sourceContentJson
        : '',
    ledger,
    ledgerFingerprint: requirementCoverageLedgerFingerprint(ledger),
    reservation: history,
  };
}
export type AttestedCompletedSourceExtraction = Awaited<
  ReturnType<typeof attestCompletedOpportunitySourceExtraction>
>;

/** Pure exact evidence admission over the freshly attested original lifecycle. */
export function preflightCompletedOpportunityRequirementEvidenceAudit(
  attested: AttestedCompletedSourceExtraction,
  options: {
    auditPricing: OpportunityIntelligenceBudgetConfig['pricing'];
    auditContract?: SourceRequirementEvidenceVersion;
    limits?: OpportunityIntelligenceBudgetConfig['run'];
  },
) {
  const history = attested.reservation;
  if (
    !Number.isSafeInteger(history.calls) ||
    history.calls < 1 ||
    !Number.isSafeInteger(history.reservedTokens) ||
    history.reservedTokens < 1 ||
    !Number.isSafeInteger(history.spendMicros) ||
    history.spendMicros < 1
  )
    throw new Error(
      'Evidence admission requires bounded native historical reservations.',
    );
  const limits =
    options.limits ?? resolveOpportunityIntelligenceBudgetConfig().run;
  // The composite factory is immutable and only adds video questions when the
  // captured source has exact nominated clauses. This keeps the original
  // evidence call authoritative for both coverage and video requirements.
  const version = sourceRequirementEvidenceVersion(
    options.auditContract ?? REQUIREMENT_EVIDENCE_AUDIT_VERSION,
  );
  const preparedAudit =
    version === REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION
      ? prepareQuarantinedSourceCompositeRequirementEvidenceAudit(
          attested.context,
          attested.ledger,
          {
            sourceContentJson: attested.sourceContentJson,
            extractionRequestId: attested.requestId,
          },
        )
      : version === REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION
        ? prepareCapturedSourceCompositeRequirementEvidenceAudit(
            attested.context,
            attested.ledger,
            {
              sourceContentJson: attested.sourceContentJson,
              extractionRequestId: attested.requestId,
            },
          )
        : version === REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION
          ? prepareSourceEligibilityCompositeRequirementEvidenceAudit(
              attested.context,
              attested.ledger,
            )
          : prepareCompositeRequirementEvidenceAudit(
              attested.context,
              attested.ledger,
            );
  const exact = preflightRequirementEvidenceAudit(
    preparedAudit,
    history,
    Math.min(80_000, limits.inputTokens),
  );
  const pricing = options.auditPricing;
  const priced =
    pricing.configured &&
    Number.isSafeInteger(pricing.inputMicrosPerMillion) &&
    pricing.inputMicrosPerMillion >= 0 &&
    Number.isSafeInteger(pricing.outputMicrosPerMillion) &&
    pricing.outputMicrosPerMillion >= 0;
  const reservedSpendMicros = priced
    ? history.spendMicros +
      reservedRequestSpendMicros({
        inputTokens: exact.requestBytes,
        maxOutputTokens: exact.maxOutputTokens,
        pricing,
      })
    : null;
  return {
    preparedAudit,
    exact,
    reservedSpendMicros,
    admitted:
      exact.fits &&
      exact.calls <= Math.min(4, limits.calls) &&
      reservedSpendMicros !== null &&
      reservedSpendMicros <= Math.min(100_000, limits.spendMicros),
  };
}

/** Any prior exact native identity requires explicit completed resume/operator review. */
export async function assertOpportunitySourceExtractionNotAttempted(
  opportunity: Row,
  database?: ReceiptDatabase,
): Promise<void> {
  const posting = prepareOpportunityPosting(
    opportunityWithSourceContent(opportunity),
  );
  const context = requirementCoverageContextForOpportunity({
    ...opportunity,
    preparedPostingFingerprint: posting.fingerprint,
  });
  const db = database ?? (await resolveDatabase(getDbConfig()));
  const { rows } = await db.query(
    `SELECT request_id FROM opportunity_intelligence_requests
    WHERE opportunity_id = ? AND content_fingerprint = ? AND input_fingerprint = ?
      AND feature = 'opportunity-extraction-chunk-1'
      AND COALESCE(tenant_id, '') = '' AND COALESCE(owner_user_id, '') = '' AND COALESCE(candidate_profile_id, '') = ''`,
    [
      identifier(opportunity.id),
      identifier(context.sourceFingerprint),
      identifier(context.extractionFingerprint),
    ],
  );
  if (rows.length)
    throw new Error(
      'This exact source extraction identity was already attempted; select its completed native receipt or request operator review.',
    );
}

/** Server-created explicit source intent on the existing native source method. */
export async function enqueueOpportunityRequirementCoverageSourceStage(
  opportunityId: string,
  selection: SourceCoverageStageSelection,
): Promise<SmrtJob> {
  return await enqueueSourceStage(opportunityId, selection, false);
}

/** Saved paid extraction only, with no private continuation or extraction fallback. */
export async function enqueueOpportunityRequirementEvidenceAuditPilot(
  opportunityId: string,
  extractionRequestId: string,
): Promise<SmrtJob> {
  return await enqueueSourceStage(
    opportunityId,
    {
      stage: 'evidence_completed_extraction',
      extractionRequestId,
      evidenceVersion: REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
    },
    true,
  );
}

/** Explicit quarantine recovery of an existing paid source; never new extraction. */
export async function enqueueOpportunityQuarantinedRequirementEvidenceAuditPilot(
  opportunityId: string,
  extractionRequestId: string,
): Promise<SmrtJob> {
  return await enqueueSourceStage(
    opportunityId,
    {
      stage: 'evidence_completed_extraction',
      extractionRequestId,
      evidenceVersion: REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION,
    },
    true,
  );
}

async function enqueueSourceStage(
  opportunityId: string,
  selection: SourceCoverageStageSelection,
  pilot: boolean,
): Promise<SmrtJob> {
  identifier(opportunityId);
  requireSourceCrawlOperator();
  const evidenceVersion =
    selection.stage === 'evidence_completed_extraction'
      ? sourceRequirementEvidenceVersion(
          selection.evidenceVersion ?? REQUIREMENT_EVIDENCE_AUDIT_VERSION,
        )
      : undefined;
  const args = withRuntimeWorkspaceSubject({});
  const subject = runtimeWorkspaceSubjectFromJobArgs(args);
  return await withOpportunityLifecycleLock(
    opportunityId,
    async () =>
      await runAsRevalidatedJobWorkspaceSubject(
        subject,
        'audit.record',
        async (_fresh, run) => {
          requireSourceCrawlOperator();
          await run.assertOperation('opportunities', 'read');
          await run.assertOperation('opportunities', 'update');
          const native = await (await getCollection('Opportunity')).get(
            { id: opportunityId },
            { cache: false },
          );
          if (!native) throw new Error('Source stage opportunity is missing.');
          const opportunity = native.toJSON();
          identifier(opportunity.sourceContentFingerprint);
          positive(opportunity.sourceContentVersion);
          const completed =
            selection.stage === 'audit_completed_extraction' ||
            selection.stage === 'evidence_completed_extraction'
              ? await attestCompletedOpportunitySourceExtraction(
                  opportunity,
                  selection.extractionRequestId,
                )
              : undefined;
          if (!completed)
            await assertOpportunitySourceExtractionNotAttempted(opportunity);
          if (
            completed &&
            (completed.workspaceSubject.tenantId !== subject.tenantId ||
              completed.workspaceSubject.userId !== subject.userId ||
              completed.workspaceSubject.profileId !== subject.profileId)
          )
            throw new Error(
              'Completed extraction lifecycle owner is not current.',
            );
          if (selection.stage !== 'extract' && !completed)
            throw new Error('Source stage selection is invalid.');
          return await (
            await SmrtJobCollection.create(getSmrtOptions())
          ).enqueueJob({
            objectId: opportunityId,
            objectType: '@willgriffin/iolaus-site:Opportunity',
            method: 'prepareAssessmentCoverage',
            queue: pilot
              ? OPPORTUNITY_REQUIREMENT_EVIDENCE_AUDIT_PILOT_QUEUE
              : 'opportunity-intelligence',
            tenantId: subject.tenantId,
            maxAttempts: 1,
            timeout: 3 * 60 * 1000,
            priority: 80,
            args: {
              ...args,
              contentFingerprint: opportunity.sourceContentFingerprint,
              contentVersion: opportunity.sourceContentVersion,
              sourceDependencyFingerprint:
                requirementCoverageSourceDependencyFingerprint(opportunity),
              sourceCoverageStage: {
                contract: SOURCE_COVERAGE_STAGE_JOB_CONTRACT,
                stage: selection.stage,
                ...(pilot
                  ? {
                      pilotContract:
                        evidenceVersion ===
                        REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION
                          ? OPPORTUNITY_QUARANTINED_REQUIREMENT_EVIDENCE_AUDIT_PILOT_CONTRACT
                          : OPPORTUNITY_REQUIREMENT_EVIDENCE_AUDIT_PILOT_CONTRACT,
                    }
                  : {}),
                ...(selection.stage === 'evidence_completed_extraction'
                  ? { auditContract: evidenceVersion }
                  : {}),
                ...(completed
                  ? {
                      extractionRequestId: completed.requestId,
                      extractionInputFingerprint:
                        completed.context.extractionFingerprint,
                      ledgerFingerprint: completed.ledgerFingerprint,
                    }
                  : {}),
              },
            },
          });
        },
      ),
  );
}

interface SourceStageDependencies {
  getOpportunity?: (id: string) => Promise<Row | null>;
  getJob?: (id: string) => Promise<SmrtJob | null>;
  attest?: typeof attestCompletedOpportunitySourceExtraction;
  assertNotAttempted?: typeof assertOpportunitySourceExtractionNotAttempted;
  extract?: (
    id: string,
    options: OpportunityLlmExtractionOptions,
  ) => Promise<{ status: string; message: string }>;
  audit?: typeof evaluateRequirementCoverageAudit;
  evidenceAudit?: typeof evaluateRequirementEvidenceAudit;
  readEvidence?: typeof readPartialOpportunityRequirementEvidence;
  readEligibility?: typeof readVerifiedOpportunitySourceEligibilityEvidence;
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  requireOperator?: typeof requireSourceCrawlOperator;
  withLock?: typeof withOpportunityLifecycleLock;
  transaction?: typeof runOpportunityLifecycleTransaction;
  update?: typeof defaultFencedOpportunityUpdate;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
}

/** No private continuation and no fallback to extraction on completed resume. */
export async function runOpportunityRequirementCoverageSourceStageJob(
  opportunityId: string,
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  dependencies: SourceStageDependencies = {},
) {
  const runner = requireActiveRunnerExecutionContext(context);
  if (
    ![
      'opportunity-intelligence',
      OPPORTUNITY_REQUIREMENT_EVIDENCE_AUDIT_PILOT_QUEUE,
    ].includes(runner.job.queue) ||
    runner.job.objectType !== '@willgriffin/iolaus-site:Opportunity' ||
    runner.job.method !== 'prepareAssessmentCoverage' ||
    runner.job.tenantId !== subject.tenantId
  )
    throw new Error('Source stage requires its authentic native source job.');
  const getOpportunity =
    dependencies.getOpportunity ??
    (async (id: string) => {
      const row = await (await getCollection('Opportunity')).get(
        { id },
        { cache: false },
      );
      return row ? row.toJSON() : null;
    });
  const getJob =
    dependencies.getJob ??
    (async (id: string) =>
      await (await SmrtJobCollection.create(getSmrtOptions())).get(
        { id },
        { cache: false },
      ));
  const runFresh = dependencies.runFresh ?? runAsRevalidatedJobWorkspaceSubject;
  const fresh = async <T>(work: () => Promise<T>) =>
    await runFresh(subject, 'audit.record', async (_fresh, run) => {
      (dependencies.requireOperator ?? requireSourceCrawlOperator)();
      // Native principal resolution is repeated at every provider/write fence.
      await run.assertOperation('opportunities', 'read');
      await run.assertOperation('opportunities', 'update');
      return await work();
    });
  await fresh(async () => undefined);
  return await (dependencies.withLock ?? withOpportunityLifecycleLock)(
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
          throw new Error('Source stage durable job is not current.');
        const stored = runtimeWorkspaceSubjectFromJobArgs(job.args);
        if (
          stored.tenantId !== subject.tenantId ||
          stored.userId !== subject.userId ||
          stored.profileId !== subject.profileId
        )
          throw new Error('Source stage durable owner is not current.');
        const requireCurrentSource = async () => {
          const current = await getOpportunity(opportunityId);
          if (
            !current ||
            current.id !== opportunityId ||
            current.sourceContentFingerprint !== job.args.contentFingerprint ||
            current.sourceContentVersion !== job.args.contentVersion ||
            requirementCoverageSourceDependencyFingerprint(current) !==
              job.args.sourceDependencyFingerprint
          )
            throw new Error('Source stage durable source is not current.');
          return current;
        };
        const opportunity = await requireCurrentSource();
        const intent = object(job.args.sourceCoverageStage);
        if (
          intent.contract !== SOURCE_COVERAGE_STAGE_JOB_CONTRACT ||
          (intent.stage !== 'extract' &&
            intent.stage !== 'audit_completed_extraction' &&
            intent.stage !== 'evidence_completed_extraction')
        )
          throw new Error(
            'Source stage requires an explicit native operator intent.',
          );
        const pilot =
          runner.job.queue ===
          OPPORTUNITY_REQUIREMENT_EVIDENCE_AUDIT_PILOT_QUEUE;
        if (
          pilot
            ? intent.pilotContract !==
                (intent.auditContract ===
                REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION
                  ? OPPORTUNITY_QUARANTINED_REQUIREMENT_EVIDENCE_AUDIT_PILOT_CONTRACT
                  : OPPORTUNITY_REQUIREMENT_EVIDENCE_AUDIT_PILOT_CONTRACT) ||
              intent.stage !== 'evidence_completed_extraction' ||
              (intent.auditContract !==
                REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION &&
                intent.auditContract !==
                  REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION) ||
              job.maxAttempts !== 1
            : intent.pilotContract !== undefined
        )
          throw new Error(
            'Source evidence pilot queue does not match its server-captured intent.',
          );
        const assertPilotJob = async () => {
          if (!pilot) return;
          const current = await getJob(identifier(runner.job.jobId));
          if (
            !current ||
            current.id !== job.id ||
            current.status !== 'running' ||
            current.attempts !== runner.job.attempt ||
            current.maxAttempts !== 1 ||
            current.tenantId !== subject.tenantId ||
            current.queue !== runner.job.queue ||
            current.objectType !== runner.job.objectType ||
            current.method !== runner.job.method ||
            current.objectId !== opportunityId ||
            JSON.stringify(current.args.sourceCoverageStage) !==
              JSON.stringify(intent) ||
            [
              'contentFingerprint',
              'contentVersion',
              'sourceDependencyFingerprint',
            ].some((key) => current.args[key] !== job.args[key]) ||
            ['tenantId', 'userId', 'profileId'].some(
              (key) =>
                runtimeWorkspaceSubjectFromJobArgs(current.args)[
                  key as keyof RuntimeWorkspaceSubject
                ] !== subject[key as keyof RuntimeWorkspaceSubject],
            )
          )
            throw new Error(
              'Source evidence pilot durable authority is not current.',
            );
        };
        await assertPilotJob();
        const evidenceVersion =
          intent.stage === 'evidence_completed_extraction'
            ? sourceRequirementEvidenceVersion(intent.auditContract)
            : undefined;
        const attest =
          dependencies.attest ?? attestCompletedOpportunitySourceExtraction;
        const completed =
          intent.stage === 'audit_completed_extraction' ||
          intent.stage === 'evidence_completed_extraction'
            ? await attest(opportunity, identifier(intent.extractionRequestId))
            : undefined;
        if (
          completed &&
          (completed.context.extractionFingerprint !==
            intent.extractionInputFingerprint ||
            completed.ledgerFingerprint !== intent.ledgerFingerprint)
        )
          throw new Error(
            'Source stage completed extraction provenance is not current.',
          );
        if (
          completed &&
          (completed.workspaceSubject.tenantId !== subject.tenantId ||
            completed.workspaceSubject.userId !== subject.userId ||
            completed.workspaceSubject.profileId !== subject.profileId)
        )
          throw new Error(
            'Completed extraction lifecycle owner is not current.',
          );
        if (!completed)
          await (
            dependencies.assertNotAttempted ??
            assertOpportunitySourceExtractionNotAttempted
          )(opportunity);
        const agentRunId =
          completed?.agentRunId ??
          (await (
            dependencies.startRun ?? startOpportunityIntelligenceAgentRun
          )({
            opportunityId,
            sourceId:
              typeof opportunity.sourceId === 'string'
                ? opportunity.sourceId
                : '',
            userId: subject.userId,
            workspaceSubject: subject,
          }));
        const finishRun =
          dependencies.finishRun ?? finishOpportunityIntelligenceAgentRun;
        try {
          job.args = { ...job.args, sourcePreparationAgentRunId: agentRunId };
          await job.save();
          const assertCurrentAuthority = async () =>
            await fresh(async () => {
              await assertPilotJob();
              await requireCurrentSource();
            });
          const persist = async (
            id: string,
            fingerprint: string,
            updates: Row,
          ) =>
            await fresh(async () => {
              if (
                id !== opportunityId ||
                fingerprint !== job.args.contentFingerprint
              )
                throw new Error(
                  'Source stage publication identity is invalid.',
                );
              await assertPilotJob();
              await requireCurrentSource();
              return await (
                dependencies.transaction ?? runOpportunityLifecycleTransaction
              )(
                async (db) =>
                  await (dependencies.update ?? defaultFencedOpportunityUpdate)(
                    id,
                    fingerprint,
                    updates,
                    Number(job.args.contentVersion),
                    db,
                  ),
              );
            });
          let result: { status: string; message: string };
          if (!completed) {
            result = await (dependencies.extract ?? processOpportunityWithLlm)(
              opportunityId,
              {
                agentRunId,
                sourceExtractionStage: 'extract-only',
                expectedSourceContentFingerprint: String(
                  job.args.contentFingerprint,
                ),
                sourceContentVersion: Number(job.args.contentVersion),
                assertCurrentAuthority,
                fencedOpportunityUpdate: persist,
                signal: AbortSignal.timeout(3 * 60 * 1000),
              },
            );
            // Provider failures must also be terminal native job failures. The
            // governed request already owns its failed identity/accounting.
            if (result.status === 'error' || result.status === 'failed')
              throw new Error(result.message);
          } else {
            await assertCurrentAuthority();
            const actual = await attest(
              await requireCurrentSource(),
              completed.requestId,
            );
            if (
              actual.agentRunId !== agentRunId ||
              actual.workspaceSubject.tenantId !== subject.tenantId ||
              actual.workspaceSubject.userId !== subject.userId ||
              actual.workspaceSubject.profileId !== subject.profileId ||
              actual.ledgerFingerprint !== completed.ledgerFingerprint ||
              actual.context.extractionFingerprint !==
                completed.context.extractionFingerprint
            )
              throw new Error(
                'Completed source extraction changed during re-attestation.',
              );
            if (intent.stage === 'evidence_completed_extraction') {
              const price = (name: string) => {
                const value = process.env[name];
                if (
                  !value ||
                  !/^\d+$/u.test(value) ||
                  !Number.isSafeInteger(Number(value))
                )
                  throw new Error(
                    `Configure ${name} before completed source evidence audit.`,
                  );
                return Number(value);
              };
              const plan =
                preflightCompletedOpportunityRequirementEvidenceAudit(actual, {
                  auditContract: evidenceVersion,
                  limits: resolveOpportunityIntelligenceBudgetConfig().run,
                  auditPricing: {
                    configured: true,
                    inputMicrosPerMillion: price(
                      'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
                    ),
                    outputMicrosPerMillion: price(
                      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
                    ),
                  },
                });
              if (!plan.admitted)
                throw new Error(
                  'Completed source checkpoint retained: exact evidence audit and historical reservations exceed the lifecycle ceiling.',
                );
              await assertCurrentAuthority();
              const evidence = await (
                dependencies.evidenceAudit ?? evaluateRequirementEvidenceAudit
              )(plan.preparedAudit, {
                agentRunId,
                opportunityId,
                contentFingerprint: actual.context.sourceFingerprint,
                historicalReservation: actual.reservation,
                ...(evidenceVersion ===
                  REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION ||
                evidenceVersion ===
                  REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION
                  ? {
                      resolveCompletedExtraction: async () => {
                        await assertCurrentAuthority();
                        const native = await requireCurrentSource();
                        return await attest(native, completed.requestId);
                      },
                    }
                  : {}),
                signal: AbortSignal.timeout(3 * 60 * 1000),
              });
              await assertCurrentAuthority();
              const current = await requireCurrentSource();
              const existing = object(
                JSON.parse(String(current.preparedPostingJson || '{}')),
              );
              // Audit diagnostics are a locator. The fresh GLOBAL actual receipt
              // independently reconstructs accepted rows before publication.
              const preparedPostingJson = JSON.stringify({
                ...existing,
                requirementCoverage: actual.ledger,
                requirementCoverageEvidenceAudit: evidence,
              });
              const nativeEvidence = await (
                dependencies.readEvidence ??
                readPartialOpportunityRequirementEvidence
              )({ ...current, preparedPostingJson });
              if (
                !nativeEvidence ||
                nativeEvidence.audit.version !== evidenceVersion ||
                nativeEvidence.audit.requestId !== evidence.requestId ||
                nativeEvidence.audit.fingerprint !== evidence.fingerprint ||
                nativeEvidence.audit.inputFingerprint !==
                  plan.preparedAudit.inputFingerprint ||
                nativeEvidence.audit.ledgerFingerprint !==
                  actual.ledgerFingerprint
              )
                throw new Error(
                  'Completed source evidence lacks its exact native GLOBAL actual receipt.',
                );
              if (
                evidenceVersion ===
                  REQUIREMENT_EVIDENCE_ELIGIBILITY_AUDIT_VERSION ||
                evidenceVersion ===
                  REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION ||
                evidenceVersion ===
                  REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION
              ) {
                const eligibility = await (
                  dependencies.readEligibility ??
                  readVerifiedOpportunitySourceEligibilityEvidence
                )({ ...current, preparedPostingJson });
                if (
                  !eligibility ||
                  eligibility.evidence.requestId !== evidence.requestId ||
                  eligibility.evidence.aggregateFingerprint !==
                    plan.preparedAudit.inputFingerprint ||
                  eligibility.evidence.sourceContentFingerprint !==
                    actual.context.sourceFingerprint ||
                  eligibility.evidence.sourceContentVersion !==
                    actual.context.sourceVersion ||
                  eligibility.sourceContext.sourceContentFingerprint !==
                    actual.context.sourceFingerprint ||
                  eligibility.sourceContext.sourceContentVersion !==
                    actual.context.sourceVersion ||
                  eligibility.sourceContext.sourceText !==
                    actual.context.sourceText
                ) {
                  throw new Error(
                    'Completed source eligibility lacks its exact current native GLOBAL aggregate receipt.',
                  );
                }
                if (
                  evidenceVersion ===
                    REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION ||
                  evidenceVersion ===
                    REQUIREMENT_EVIDENCE_QUARANTINED_SOURCE_AUDIT_VERSION
                ) {
                  const expected =
                    plan.preparedAudit.sourceEligibility?.context;
                  if (
                    !expected?.capturedFieldsFingerprint ||
                    eligibility.sourceContext.capturedFieldsFingerprint !==
                      expected.capturedFieldsFingerprint ||
                    JSON.stringify(eligibility.sourceContext.capturedFields) !==
                      JSON.stringify(expected.capturedFields)
                  ) {
                    throw new Error(
                      'Completed captured-source eligibility fields lack their exact current native GLOBAL aggregate receipt.',
                    );
                  }
                }
              }
              const video = nativeEvidence.audit.video;
              if (
                video &&
                (video.compositeInputFingerprint !==
                  plan.preparedAudit.inputFingerprint ||
                  video.sourceContentFingerprint !==
                    actual.context.sourceFingerprint ||
                  video.sourceContentVersion !== actual.context.sourceVersion ||
                  video.videoRequirements.source.sourceContentFingerprint !==
                    actual.context.sourceFingerprint ||
                  video.videoRequirements.source.sourceContentVersion !==
                    actual.context.sourceVersion)
              )
                throw new Error(
                  'Completed source video evidence is not current for its exact composite receipt.',
                );
              const persistedPosting = JSON.stringify({
                ...existing,
                requirementCoverage: actual.ledger,
                requirementCoverageEvidenceAudit: evidence,
                // `readEvidence` replayed the actual GLOBAL receipt against the
                // current source. Never publish the diagnostic/provider result
                // itself as a video claim.
                ...(video
                  ? {
                      opportunityVideoRequirements: video,
                    }
                  : {}),
              });
              const saved = await persist(
                opportunityId,
                actual.context.sourceFingerprint,
                {
                  preparedPostingJson: persistedPosting,
                  preparedPostingFingerprint: actual.posting.fingerprint,
                  preparedPostingVersion: actual.posting.version,
                  updated_at: new Date(),
                },
              );
              result = saved
                ? {
                    status: 'processed',
                    message: nativeEvidence.audit.fullCoverage
                      ? 'Completed source evidence audit verified every clause.'
                      : 'Completed source evidence audit retained supported rows with unresolved source clauses.',
                  }
                : {
                    status: 'skipped',
                    message: 'Discarded stale source evidence audit result.',
                  };
            } else {
              const audit = prepareRequirementCoverageAudit(
                actual.context,
                actual.ledger,
              );
              const exact = preflightRequirementCoverageAudit(audit);
              const config = resolveOpportunityIntelligenceBudgetConfig();
              const plan = preflightRequirementCoverageLifecycle(
                [actual.reservation, exact],
                {
                  calls: Math.min(4, config.run.calls),
                  inputTokens: Math.min(80_000, config.run.inputTokens),
                },
              );
              const price = (name: string) => {
                const value = process.env[name];
                if (
                  !value ||
                  !/^\d+$/u.test(value) ||
                  !Number.isSafeInteger(Number(value))
                )
                  throw new Error(
                    `Configure ${name} before completed source audit.`,
                  );
                return Number(value);
              };
              const spend =
                actual.reservation.spendMicros +
                reservedRequestSpendMicros({
                  inputTokens: exact.requestBytes,
                  maxOutputTokens: exact.maxOutputTokens,
                  pricing: {
                    configured: true,
                    inputMicrosPerMillion: price(
                      'OPPORTUNITY_SKILL_DECISION_INPUT_COST_MICROS_PER_MILLION',
                    ),
                    outputMicrosPerMillion: price(
                      'OPPORTUNITY_SKILL_DECISION_OUTPUT_COST_MICROS_PER_MILLION',
                    ),
                  },
                });
              if (
                !exact.fits ||
                !plan.fits ||
                spend > Math.min(100_000, config.run.spendMicros)
              )
                throw new Error(
                  'Completed source checkpoint retained: exact audit and historical reservations exceed the lifecycle ceiling.',
                );
              await assertCurrentAuthority();
              actual.ledger.audit = await (
                dependencies.audit ?? evaluateRequirementCoverageAudit
              )(audit, {
                agentRunId,
                opportunityId,
                contentFingerprint: actual.context.sourceFingerprint,
                signal: AbortSignal.timeout(3 * 60 * 1000),
              });
              const current = await requireCurrentSource();
              const existing = object(
                JSON.parse(String(current.preparedPostingJson || '{}')),
              );
              const saved = await persist(
                opportunityId,
                actual.context.sourceFingerprint,
                {
                  preparedPostingJson: JSON.stringify({
                    ...existing,
                    requirementCoverage: actual.ledger,
                  }),
                  preparedPostingFingerprint: actual.posting.fingerprint,
                  preparedPostingVersion: actual.posting.version,
                  updated_at: new Date(),
                },
              );
              result = saved
                ? {
                    status: 'processed',
                    message: validateVerifiedRequirementCoverage(
                      actual.context,
                      actual.ledger,
                    ).complete
                      ? 'Completed source extraction audit verified.'
                      : 'Completed source extraction audit remains incomplete.',
                  }
                : {
                    status: 'skipped',
                    message: 'Discarded stale source audit result.',
                  };
            }
          }
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
