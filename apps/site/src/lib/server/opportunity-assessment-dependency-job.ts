import { createHash } from 'node:crypto';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
  type SmrtJobData,
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
  processOpportunityWithLlm,
} from './opportunity-details.js';
import { resolveOpportunityIntelligenceBudgetConfig } from './opportunity-intelligence-config.js';
import {
  finishOpportunityIntelligenceAgentRun,
  startOpportunityIntelligenceAgentRun,
} from './opportunity-intelligence-governance.js';
import { loadCurrentOpportunityReviewOverlays } from './opportunity-review-overlay.js';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import { requirementCoverageContextForOpportunity } from './opportunity-requirement-coverage.js';
import {
  evaluateRequirementEvidenceAudit,
  prepareCapturedSourceCompositeRequirementEvidenceAudit,
  REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
  readPartialOpportunityRequirementEvidence,
  readRecordedRequirementCoverageOutcome,
  requirementCoverageLedgerFingerprint,
  requirementCoverageSourceDependencyFingerprint,
} from './opportunity-requirement-coverage-provider.js';
import {
  type AttestedCompletedSourceExtraction,
  assertOpportunitySourceExtractionNotAttempted,
  attestCompletedOpportunitySourceExtraction,
} from './opportunity-requirement-coverage-source-stage-job.js';
import {
  assertOpportunityAssessmentScreenNotAttempted,
  type CurrentOpportunityAssessmentScreen,
  evaluateOpportunityAssessmentScreen,
  prepareCurrentOpportunityAssessmentScreen,
  readCurrentOpportunityAssessmentScreen,
} from './opportunity-screening-provider.js';
import { OPPORTUNITY_SCREENING_VERSION } from './opportunity-screening.js';
import { opportunityWithSourceContent } from './opportunity-source-content.js';
import { getCollection } from './smrt.js';

/** A profile-owned prerequisite job on the existing intelligence queue. */
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD =
  'prepareAssessmentCoverage';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT =
  'opportunity-assessment-dependency/v1';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS = 3 * 60 * 1000;
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE =
  'opportunity-intelligence';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE =
  '@willgriffin/iolaus-site:Opportunity';

/** Fixed server-owned route; caller queue names are never accepted. */
export const OPPORTUNITY_ASSESSMENT_PILOT_QUEUE =
  'opportunity-assessment-pilot';
export const OPPORTUNITY_ASSESSMENT_PILOT_CONTRACT =
  'opportunity-assessment-pilot/v1';
export const OPPORTUNITY_ASSESSMENT_FRESH_PILOT_CONTRACT =
  'opportunity-assessment-fresh-pilot/v1';
export function opportunityAssessmentPilotIntent(
  screen: CurrentOpportunityAssessmentScreen,
  freshSource = false,
) {
  return {
    contract: freshSource
      ? OPPORTUNITY_ASSESSMENT_FRESH_PILOT_CONTRACT
      : OPPORTUNITY_ASSESSMENT_PILOT_CONTRACT,
    screeningRequestId: screen.requestId,
    screeningInputFingerprint: screen.inputFingerprint,
  };
}
export async function requireCurrentOpportunityAssessmentPilotScreen(
  opportunityId: string,
  subject: RuntimeWorkspaceSubject,
) {
  const screen = await readCurrentOpportunityAssessmentScreen({
    opportunityId,
    subject,
  });
  if (
    !screen ||
    screen.screen.version !== OPPORTUNITY_SCREENING_VERSION ||
    screen.outcome !== 'potentially_relevant' ||
    !screen.screen.plausiblyRelevant ||
    screen.screen.holdReasons.length
  )
    throw new Error(
      'Assessment pilot requires a current actual potentially relevant V4 PRIVATE screen.',
    );
  return screen;
}

export function opportunityAssessmentJobQueue(
  args: Record<string, unknown>,
): string {
  if (args.assessmentPilot === undefined)
    return OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE;
  const intent = args.assessmentPilot;
  if (
    !intent ||
    typeof intent !== 'object' ||
    Array.isArray(intent) ||
    Object.keys(intent).length !== 3 ||
    typeof (intent as Record<string, unknown>).screeningRequestId !==
      'string' ||
    !(intent as Record<string, unknown>).screeningRequestId ||
    typeof (intent as Record<string, unknown>).screeningInputFingerprint !==
      'string' ||
    !(intent as Record<string, unknown>).screeningInputFingerprint ||
    ![
      OPPORTUNITY_ASSESSMENT_PILOT_CONTRACT,
      OPPORTUNITY_ASSESSMENT_FRESH_PILOT_CONTRACT,
    ].includes(String((intent as Record<string, unknown>).contract))
  )
    throw new Error('Assessment pilot routing intent is invalid.');
  return OPPORTUNITY_ASSESSMENT_PILOT_QUEUE;
}

/** Fresh extraction authority exists only on this exact server-authored durable contract. */
export function opportunityAssessmentPilotAllowsFreshSource(
  args: Record<string, unknown>,
): boolean {
  return (
    opportunityAssessmentJobQueue(args) ===
      OPPORTUNITY_ASSESSMENT_PILOT_QUEUE &&
    (args.assessmentPilot as Record<string, unknown>).contract ===
      OPPORTUNITY_ASSESSMENT_FRESH_PILOT_CONTRACT
  );
}
async function assertFreshPilotHumanReview(
  opportunityId: string,
  subject: RuntimeWorkspaceSubject,
) {
  const review = (
    await loadCurrentOpportunityReviewOverlays({
      opportunityIds: [opportunityId],
      subject,
    })
  ).get(opportunityId);
  if (review && ['reject', 'archived'].includes(review.humanReviewStatus))
    throw new Error(
      'The current human review prevents fresh pilot extraction.',
    );
}

/** Authenticate the server-captured pilot route against a freshly loaded durable job. */
export async function assertOpportunityAssessmentPilotJobRouting(
  opportunityId: string,
  args: Record<string, unknown>,
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
): Promise<void> {
  const runner = requireActiveRunnerExecutionContext(context);
  const queue = opportunityAssessmentJobQueue(args);
  if (runner.job.queue !== queue)
    throw new Error('Assessment job queue does not match its server intent.');
  if (queue !== OPPORTUNITY_ASSESSMENT_PILOT_QUEUE) return;
  const screen = await requireCurrentOpportunityAssessmentPilotScreen(
    opportunityId,
    subject,
  );
  if (
    JSON.stringify(args.assessmentPilot) !==
    JSON.stringify(
      opportunityAssessmentPilotIntent(
        screen,
        opportunityAssessmentPilotAllowsFreshSource(args),
      ),
    )
  )
    throw new Error(
      'Assessment pilot screening material is no longer current.',
    );
  if (opportunityAssessmentPilotAllowsFreshSource(args))
    await assertFreshPilotHumanReview(opportunityId, subject);
  const method =
    args.assessmentCoverageContract === undefined
      ? 'processIntelligence'
      : OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD;
  const job = await (await SmrtJobCollection.create(getSmrtOptions())).get(
    { id: runner.job.jobId },
    { cache: false },
  );
  if (
    !job ||
    job.id !== runner.job.jobId ||
    job.status !== 'running' ||
    job.attempts !== runner.job.attempt ||
    job.maxAttempts !== 1 ||
    job.tenantId !== subject.tenantId ||
    runner.job.tenantId !== subject.tenantId ||
    job.objectId !== opportunityId ||
    job.objectType !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    runner.job.objectType !== job.objectType ||
    job.method !== method ||
    runner.job.method !== method ||
    job.queue !== queue ||
    opportunityAssessmentJobQueue(job.args) !== queue ||
    !sameSubject(runtimeWorkspaceSubjectFromJobArgs(job.args), subject) ||
    !sameSubject(runtimeWorkspaceSubjectFromJobArgs(args), subject) ||
    [
      'contentFingerprint',
      'contentVersion',
      'scoringMaterialFingerprint',
      'assessmentCoverageContract',
      'assessmentCoverageDedupeKey',
      'sourceDependencyFingerprint',
      'partialAssessmentEvidence',
    ].some((key) => job.args[key] !== args[key]) ||
    JSON.stringify(job.args.assessmentPilot) !==
      JSON.stringify(args.assessmentPilot) ||
    JSON.stringify(job.args.modes) !== JSON.stringify(args.modes)
  )
    throw new Error('Assessment pilot durable authority is not current.');
}

export interface OpportunityAssessmentDependencyJobArgs
  extends Record<string, unknown> {
  assessmentCoverageContract?: string;
  assessmentCoverageDedupeKey?: string;
  contentFingerprint?: string;
  contentVersion?: number;
  reason?: string;
  /** Server-written after a live AgentRun is created; callers cannot retain it. */
  sourcePreparationAgentRunId?: string;
  sourceDependencyFingerprint?: string;
}

export interface OpportunityAssessmentDependencyEnqueueResult {
  enqueued: boolean;
  job: SmrtJob;
  sourceDependency: OpportunityAssessmentSourceDependency;
  stage: 'source_preparation';
  sourceStatus?: OpportunityAssessmentSourceStatus;
}

export type OpportunityAssessmentSourceStatus =
  | 'extraction_pending'
  | 'audit_pending'
  | 'audit_blocked'
  | 'operator_required'
  | 'partial'
  | 'screening_pending'
  | 'screening_excluded'
  | 'screening_hold';

export interface OpportunityAssessmentSourceDependency {
  dedupeKey: string;
  kind: 'requirement_coverage';
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  status?: OpportunityAssessmentSourceStatus;
}

export interface OpportunityAssessmentDependencyJobCollection {
  enqueueJob: (data: SmrtJobData) => Promise<SmrtJob>;
  list: (options?: {
    limit?: number;
    where?: Record<string, unknown>;
  }) => Promise<SmrtJob[]>;
}

export interface EnqueueOpportunityAssessmentDependencyOptions {
  collection?: OpportunityAssessmentDependencyJobCollection;
  now?: Date;
  opportunityCollection?: {
    get: (
      id: { id: string },
      options: { cache: false },
    ) => Promise<unknown | null | undefined>;
  };
  reason?: string;
  readCompletedExtraction?: typeof readCompletedSourceExtraction;
  withLifecycleLock?: <T>(
    opportunityId: string,
    action: () => Promise<T>,
  ) => Promise<T>;
}

type OpportunityRecord = Record<string, unknown> & { id?: unknown };

type SourcePreparationResult = {
  message: string;
  stale?: boolean;
  status: 'error' | 'processed' | 'skipped';
};

type FencedOpportunityUpdate = typeof defaultFencedOpportunityUpdate;

type SourceJobBridge = {
  sourcePreparationAgentRunId: string;
  sourceDependencyFingerprint: string;
};

export interface RunOpportunityAssessmentDependencyJobDependencies {
  enqueueAssessment?: (opportunityId: string) => Promise<unknown>;
  finishRun?: typeof finishOpportunityIntelligenceAgentRun;
  getOpportunity?: (opportunityId: string) => Promise<OpportunityRecord | null>;
  readCoverageOutcome?: typeof readRecordedRequirementCoverageOutcome;
  readPriorSourceJobBridge?: (
    context: JobExecutionContext,
    subject: RuntimeWorkspaceSubject,
    expected: {
      fingerprint: string;
      sourceDependencyFingerprint: string;
      version: number;
    },
    opportunityId: string,
  ) => Promise<SourceJobBridge | undefined>;
  recordSourcePreparationRun?: (
    context: JobExecutionContext,
    subject: RuntimeWorkspaceSubject,
    expected: {
      fingerprint: string;
      sourceDependencyFingerprint: string;
      version: number;
    },
    opportunityId: string,
    agentRunId: string,
  ) => Promise<void>;
  prepareSource?: (
    opportunityId: string,
    options: {
      agentRunId: string;
      expectedSourceContentFingerprint: string;
      fencedOpportunityUpdate: FencedOpportunityUpdate;
      signal: AbortSignal;
      sourceContentVersion: number;
      sourceExtractionStage: 'extract-only';
      assertCurrentAuthority: () => Promise<void>;
    },
  ) => Promise<SourcePreparationResult>;
  prepareScreen?: typeof prepareCurrentOpportunityAssessmentScreen;
  readScreen?: typeof readCurrentOpportunityAssessmentScreen;
  evaluateScreen?: typeof evaluateOpportunityAssessmentScreen;
  assertScreenNotAttempted?: typeof assertOpportunityAssessmentScreenNotAttempted;
  readCompletedExtraction?: typeof readCompletedSourceExtraction;
  readPartialEvidence?: typeof readPartialOpportunityRequirementEvidence;
  assertNotAttempted?: typeof assertOpportunitySourceExtractionNotAttempted;
  auditEvidence?: typeof evaluateRequirementEvidenceAudit;
  preflightEvidence?: (actual: AttestedCompletedSourceExtraction) => Promise<{
    preparedAudit: Parameters<typeof evaluateRequirementEvidenceAudit>[0];
    admitted: boolean;
  }>;
  runAsRevalidated?: <T>(
    subject: RuntimeWorkspaceSubject,
    capability: 'assessment.execute',
    work: (subject: RuntimeWorkspaceSubject, run: PrincipalRun) => Promise<T>,
  ) => Promise<T>;
  startRun?: typeof startOpportunityIntelligenceAgentRun;
  withLifecycleLock?: <T>(
    opportunityId: string,
    action: () => Promise<T>,
  ) => Promise<T>;
}

export class OpportunityAssessmentDependencyEnqueueError extends Error {
  constructor(
    readonly code:
      | 'opportunity_id_required'
      | 'opportunity_not_found'
      | 'source_coverage_blocked'
      | 'source_not_current',
    message: string,
  ) {
    super(message);
    this.name = 'OpportunityAssessmentDependencyEnqueueError';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number {
  const number = typeof value === 'number' ? Math.trunc(value) : 0;
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function sameSubject(
  left: RuntimeWorkspaceSubject,
  right: RuntimeWorkspaceSubject,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.profileId === right.profileId
  );
}

function sourceIdentity(opportunity: OpportunityRecord): {
  fingerprint: string;
  version: number;
} {
  return {
    fingerprint: text(opportunity.sourceContentFingerprint),
    version: positiveInteger(opportunity.sourceContentVersion),
  };
}

function sourceIdentityMatches(
  opportunity: OpportunityRecord | null,
  expected: { fingerprint: string; version: number },
): opportunity is OpportunityRecord {
  if (!opportunity) return false;
  const current = sourceIdentity(opportunity);
  return (
    current.fingerprint === expected.fingerprint &&
    current.version === expected.version
  );
}

/** Exact durable identity for one owner-bound source prerequisite. */
export function opportunityAssessmentCoverageDedupeKey(options: {
  sourceDependencyFingerprint: string;
  subject: RuntimeWorkspaceSubject;
  freshPilot?: boolean;
}): string {
  const { subject } = options;
  return `assessment-coverage-job/v1:${createHash('sha256')
    .update(
      JSON.stringify({
        contract: OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT,
        ...(options.freshPilot
          ? { pilotContract: OPPORTUNITY_ASSESSMENT_FRESH_PILOT_CONTRACT }
          : {}),
        profileId: subject.profileId,
        sourceDependencyFingerprint: options.sourceDependencyFingerprint,
        tenantId: subject.tenantId,
        userId: subject.userId,
      }),
    )
    .digest('hex')}`;
}

export function opportunityAssessmentSourceDependency(options: {
  opportunityId: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  subject: RuntimeWorkspaceSubject;
}): OpportunityAssessmentSourceDependency {
  return {
    dedupeKey: `requirement-coverage/v1:${options.opportunityId}:${options.sourceContentFingerprint}:${options.sourceContentVersion}`,
    kind: 'requirement_coverage',
    sourceContentFingerprint: options.sourceContentFingerprint,
    sourceContentVersion: options.sourceContentVersion,
  };
}

function jobMatchesSourceDependency(
  job: SmrtJob,
  opportunityId: string,
  subject: RuntimeWorkspaceSubject,
  source: { fingerprint: string; version: number },
  sourceDependencyFingerprint: string,
): boolean {
  if (
    job.queue !== opportunityAssessmentJobQueue(job.args) ||
    job.objectType !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    job.objectId !== opportunityId ||
    job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD ||
    job.tenantId !== subject.tenantId
  ) {
    return false;
  }
  const args = job.args;
  try {
    return (
      runtimeWorkspaceSubjectFromJobArgs(args).tenantId === subject.tenantId &&
      sameSubject(runtimeWorkspaceSubjectFromJobArgs(args), subject) &&
      args.assessmentCoverageContract ===
        OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT &&
      args.assessmentCoverageDedupeKey ===
        opportunityAssessmentCoverageDedupeKey({
          sourceDependencyFingerprint,
          subject,
          freshPilot: opportunityAssessmentPilotAllowsFreshSource(args),
        }) &&
      args.contentFingerprint === source.fingerprint &&
      args.contentVersion === source.version &&
      args.sourceDependencyFingerprint === sourceDependencyFingerprint
    );
  } catch {
    return false;
  }
}

function activeJobMatches(
  job: SmrtJob,
  opportunityId: string,
  subject: RuntimeWorkspaceSubject,
  source: { fingerprint: string; version: number },
  sourceDependencyFingerprint: string,
): boolean {
  return (
    ['pending', 'running'].includes(job.status) &&
    jobMatchesSourceDependency(
      job,
      opportunityId,
      subject,
      source,
      sourceDependencyFingerprint,
    )
  );
}

function terminalSourceJobBridge(
  job: SmrtJob,
  opportunityId: string,
  currentSubject: RuntimeWorkspaceSubject,
  source: { fingerprint: string; version: number },
  sourceDependencyFingerprint: string,
): SourceJobBridge | undefined {
  if (
    !['completed', 'failed', 'cancelled'].includes(job.status) ||
    job.queue !== opportunityAssessmentJobQueue(job.args) ||
    job.objectType !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    job.objectId !== opportunityId ||
    job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD ||
    job.tenantId !== currentSubject.tenantId
  ) {
    return undefined;
  }
  const args = job.args as OpportunityAssessmentDependencyJobArgs;
  let storedSubject: RuntimeWorkspaceSubject;
  try {
    storedSubject = runtimeWorkspaceSubjectFromJobArgs(args);
  } catch {
    return undefined;
  }
  if (
    storedSubject.tenantId !== currentSubject.tenantId ||
    args.assessmentCoverageContract !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT ||
    args.assessmentCoverageDedupeKey !==
      opportunityAssessmentCoverageDedupeKey({
        sourceDependencyFingerprint,
        subject: storedSubject,
        freshPilot: opportunityAssessmentPilotAllowsFreshSource(args),
      }) ||
    args.contentFingerprint !== source.fingerprint ||
    args.contentVersion !== source.version ||
    args.sourceDependencyFingerprint !== sourceDependencyFingerprint
  ) {
    return undefined;
  }
  const sourcePreparationAgentRunId = text(args.sourcePreparationAgentRunId);
  return sourcePreparationAgentRunId
    ? { sourceDependencyFingerprint, sourcePreparationAgentRunId }
    : undefined;
}

function blockedCoverageMessage(reason: unknown): string {
  if (reason === 'confidence') {
    return 'Current source coverage is blocked by its recorded confidence audit.';
  }
  if (reason === 'attempt_failed') {
    return 'Current source coverage is blocked by its recorded provider attempt.';
  }
  return 'Current source coverage is blocked by its recorded structural audit.';
}

/** Reload the durable row; JobExecutionContext.job is metadata, never a job. */
async function loadCurrentSourceJob(
  context: JobExecutionContext,
): Promise<SmrtJob> {
  const runnerContext = requireActiveRunnerExecutionContext(context);
  const durableJobId = text(runnerContext.job.jobId);
  if (!durableJobId) {
    throw new Error('Source preparation job link cannot be persisted.');
  }
  const jobs = await SmrtJobCollection.create(getSmrtOptions());
  const job = await jobs.get({ id: durableJobId }, { cache: false });
  if (!job) throw new Error('Source preparation job link cannot be persisted.');
  return job;
}

/**
 * A retry can already have a server-created AgentRun link from its prior
 * attempt. Consult that exact currently-claimed row before overwriting it so a
 * paid failed receipt becomes a durable block instead of another provider call.
 */
async function readPriorSourceJobBridge(
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  expected: {
    fingerprint: string;
    sourceDependencyFingerprint: string;
    version: number;
  },
  opportunityId: string,
): Promise<SourceJobBridge | undefined> {
  const runnerContext = requireActiveRunnerExecutionContext(context);
  if (
    runnerContext.job.tenantId !== subject.tenantId ||
    ![
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
      OPPORTUNITY_ASSESSMENT_PILOT_QUEUE,
    ].includes(runnerContext.job.queue) ||
    runnerContext.job.objectType !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    runnerContext.job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD
  ) {
    throw new Error('Source preparation job bridge is not authentic.');
  }
  const job = await loadCurrentSourceJob(context);
  if (
    job.status !== 'running' ||
    job.queue !== runnerContext.job.queue ||
    job.attempts !== runnerContext.job.attempt ||
    !jobMatchesSourceDependency(
      job,
      opportunityId,
      subject,
      expected,
      expected.sourceDependencyFingerprint,
    )
  ) {
    throw new Error('Source preparation job bridge is not current.');
  }
  const sourcePreparationAgentRunId = text(
    (job.args as OpportunityAssessmentDependencyJobArgs)
      .sourcePreparationAgentRunId,
  );
  return sourcePreparationAgentRunId
    ? {
        sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
        sourcePreparationAgentRunId,
      }
    : undefined;
}

async function defaultOpportunity(
  opportunityId: string,
): Promise<OpportunityRecord | null> {
  const collection = await getCollection('Opportunity');
  const row = await collection.get({ id: opportunityId }, { cache: false });
  return row ? (row.toJSON() as OpportunityRecord) : null;
}

/** Discover only the exact GLOBAL identity; a cache leaf never attests it. */
async function readCompletedSourceExtraction(
  opportunity: OpportunityRecord,
): Promise<AttestedCompletedSourceExtraction | undefined> {
  const posting = prepareOpportunityPosting(
    opportunityWithSourceContent(opportunity),
  );
  const coverage = requirementCoverageContextForOpportunity({
    ...opportunity,
    preparedPostingFingerprint: posting.fingerprint,
  });
  const db = await resolveDatabase(getDbConfig());
  const { rows } = await db.query(
    `SELECT request_id FROM opportunity_intelligence_requests
    WHERE opportunity_id = ? AND content_fingerprint = ? AND input_fingerprint = ?
      AND feature = 'opportunity-extraction-chunk-1'
      AND COALESCE(tenant_id, '') = '' AND COALESCE(owner_user_id, '') = ''
      AND COALESCE(candidate_profile_id, '') = ''`,
    [
      opportunity.id,
      coverage.sourceFingerprint,
      coverage.extractionFingerprint,
    ],
  );
  if (!rows.length) return undefined;
  if (rows.length !== 1 || !text(rows[0]?.request_id))
    throw new Error('The current source preparation requires operator review.');
  return await attestCompletedOpportunitySourceExtraction(
    opportunity,
    text(rows[0].request_id),
  );
}

async function preflightSourceEvidence(
  actual: AttestedCompletedSourceExtraction,
) {
  const price = (name: string) => {
    const value = process.env[name];
    if (!value || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`Configure ${name} before source evidence preparation.`);
    return Number(value);
  };
  const { preflightCompletedOpportunityRequirementEvidenceAudit } =
    await import('./opportunity-requirement-coverage-source-stage-job.js');
  return preflightCompletedOpportunityRequirementEvidenceAudit(actual, {
    auditContract: REQUIREMENT_EVIDENCE_CAPTURED_SOURCE_AUDIT_VERSION,
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
}

function requiredSourceArgs(args: OpportunityAssessmentDependencyJobArgs): {
  fingerprint: string;
  sourceDependencyFingerprint: string;
  version: number;
} {
  if (
    args.assessmentCoverageContract !==
    OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT
  ) {
    throw new Error('Assessment coverage job contract is invalid.');
  }
  const fingerprint = text(args.contentFingerprint);
  const sourceDependencyFingerprint = text(args.sourceDependencyFingerprint);
  const version = positiveInteger(args.contentVersion);
  if (!fingerprint || !version || !sourceDependencyFingerprint) {
    throw new Error('Assessment coverage job source identity is invalid.');
  }
  return { fingerprint, sourceDependencyFingerprint, version };
}

/** Persist the source request's AgentRun link only on its authentic job row. */
async function recordSourcePreparationRun(
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  expected: {
    fingerprint: string;
    sourceDependencyFingerprint: string;
    version: number;
  },
  opportunityId: string,
  agentRunId: string,
): Promise<void> {
  const runnerContext = requireActiveRunnerExecutionContext(context);
  const durableJobId = text(runnerContext.job.jobId);
  if (
    !durableJobId ||
    runnerContext.job.tenantId !== subject.tenantId ||
    ![
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
      OPPORTUNITY_ASSESSMENT_PILOT_QUEUE,
    ].includes(runnerContext.job.queue) ||
    runnerContext.job.objectType !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    runnerContext.job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD
  ) {
    throw new Error('Source preparation job link cannot be persisted.');
  }
  // JobExecutionContext.job intentionally contains logging metadata only. Load
  // the durable row while the fresh tenant/principal context is active before
  // reading or changing its untrusted JSON arguments.
  const job = await loadCurrentSourceJob(context);
  const jobArgs = job.args as OpportunityAssessmentDependencyJobArgs;
  if (
    !agentRunId ||
    job.tenantId !== subject.tenantId ||
    job.status !== 'running' ||
    job.queue !== runnerContext.job.queue ||
    job.attempts !== runnerContext.job.attempt ||
    job.queue !== opportunityAssessmentJobQueue(job.args) ||
    job.objectType !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    job.objectId !== opportunityId ||
    job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD ||
    !sameSubject(runtimeWorkspaceSubjectFromJobArgs(jobArgs), subject) ||
    jobArgs.assessmentCoverageContract !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT ||
    jobArgs.contentFingerprint !== expected.fingerprint ||
    jobArgs.contentVersion !== expected.version ||
    jobArgs.sourceDependencyFingerprint !==
      expected.sourceDependencyFingerprint ||
    jobArgs.assessmentCoverageDedupeKey !==
      opportunityAssessmentCoverageDedupeKey({
        sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
        subject,
        freshPilot: opportunityAssessmentPilotAllowsFreshSource(jobArgs),
      })
  ) {
    throw new Error('Source preparation job link cannot be persisted.');
  }
  job.args = { ...jobArgs, sourcePreparationAgentRunId: agentRunId };
  await job.save();
}

/**
 * Captures source identity from the current Opportunity and submits through the
 * native queue API. Caller-provided source values are always overwritten.
 */
export async function enqueueOpportunityAssessmentCoverage(
  opportunityId: string,
  args: OpportunityAssessmentDependencyJobArgs = {},
  options: EnqueueOpportunityAssessmentDependencyOptions = {},
): Promise<OpportunityAssessmentDependencyEnqueueResult> {
  return await enqueueAssessmentCoverage(opportunityId, args, options, false);
}

/** Pilot resumes paid source only; it never authorizes new extraction. */
export async function enqueueOpportunityAssessmentCoveragePilot(
  opportunityId: string,
  options: EnqueueOpportunityAssessmentDependencyOptions = {},
): Promise<OpportunityAssessmentDependencyEnqueueResult> {
  const subject = runtimeWorkspaceSubjectFromJobArgs(
    withRuntimeWorkspaceSubject({}),
  );
  return await runAsRevalidatedJobWorkspaceSubject(
    subject,
    'assessment.execute',
    async (_current, run) => {
      await run.assertOperation('opportunities', 'read');
      return await enqueueAssessmentCoverage(opportunityId, {}, options, true);
    },
  );
}

/** Explicit fresh pilot authorization; normal and saved-only enqueue cannot select it. */
export async function enqueueOpportunityAssessmentCoverageFreshPilot(
  opportunityId: string,
  options: EnqueueOpportunityAssessmentDependencyOptions = {},
): Promise<OpportunityAssessmentDependencyEnqueueResult> {
  const subject = runtimeWorkspaceSubjectFromJobArgs(
    withRuntimeWorkspaceSubject({}),
  );
  return await runAsRevalidatedJobWorkspaceSubject(
    subject,
    'assessment.execute',
    async (_current, run) => {
      await run.assertOperation('opportunities', 'read');
      return await enqueueAssessmentCoverage(
        opportunityId,
        {},
        options,
        true,
        true,
      );
    },
  );
}

async function enqueueAssessmentCoverage(
  opportunityId: string,
  args: OpportunityAssessmentDependencyJobArgs,
  options: EnqueueOpportunityAssessmentDependencyOptions,
  pilot: boolean,
  freshSource = false,
): Promise<OpportunityAssessmentDependencyEnqueueResult> {
  const normalizedOpportunityId = text(opportunityId);
  if (!normalizedOpportunityId) {
    throw new OpportunityAssessmentDependencyEnqueueError(
      'opportunity_id_required',
      'Opportunity id is required.',
    );
  }
  const {
    assessmentPilot: _ignoredPilot,
    sourcePreparationAgentRunId: _ignoredSourcePreparationAgentRunId,
    partialAssessmentEvidence: _ignoredPartialEvidence,
    sourceCoverageStage: _ignoredSourceStage,
    skipScreening: _ignoredSkipScreening,
    screeningOutcome: _ignoredScreeningOutcome,
    screeningEvidence: _ignoredScreeningEvidence,
    screeningInputFingerprint: _ignoredScreeningFingerprint,
    candidatePreferences: _ignoredCandidatePreferences,
    ...callerArgs
  } = args;
  const baseArgs = withRuntimeWorkspaceSubject(callerArgs);
  const currentSubject = runtimeWorkspaceSubjectFromJobArgs(baseArgs);
  if (freshSource)
    await assertFreshPilotHumanReview(normalizedOpportunityId, currentSubject);
  const enveloped = {
    ...baseArgs,
    ...(pilot
      ? {
          assessmentPilot: opportunityAssessmentPilotIntent(
            await requireCurrentOpportunityAssessmentPilotScreen(
              normalizedOpportunityId,
              currentSubject,
            ),
            freshSource,
          ),
        }
      : {}),
  };
  const queue = opportunityAssessmentJobQueue(enveloped);
  const subject = runtimeWorkspaceSubjectFromJobArgs(enveloped);
  const getOpportunity = options.opportunityCollection
    ? async (id: string) =>
        (await options.opportunityCollection!.get(
          { id },
          { cache: false },
        )) as OpportunityRecord | null
    : defaultOpportunity;
  const collection =
    options.collection ??
    ((await SmrtJobCollection.create(
      getSmrtOptions(),
    )) as unknown as OpportunityAssessmentDependencyJobCollection);
  const withLock = options.withLifecycleLock ?? withOpportunityLifecycleLock;
  return await withLock(normalizedOpportunityId, async () => {
    // This brief lock serializes active-job lookup with native enqueue. The
    // worker still has its own cache/provider fence before any paid request.
    const opportunity = await getOpportunity(normalizedOpportunityId);
    if (!opportunity || text(opportunity.id) !== normalizedOpportunityId) {
      throw new OpportunityAssessmentDependencyEnqueueError(
        'opportunity_not_found',
        'Opportunity not found.',
      );
    }
    const source = sourceIdentity(opportunity);
    if (!source.fingerprint || !source.version) {
      throw new OpportunityAssessmentDependencyEnqueueError(
        'source_not_current',
        'A current opportunity source is required for assessment preparation.',
      );
    }
    const sourceDependency = opportunityAssessmentSourceDependency({
      opportunityId: normalizedOpportunityId,
      sourceContentFingerprint: source.fingerprint,
      sourceContentVersion: source.version,
      subject,
    });
    const sourceDependencyFingerprint =
      requirementCoverageSourceDependencyFingerprint(opportunity);
    const requestedDedupeKey = opportunityAssessmentCoverageDedupeKey({
      sourceDependencyFingerprint,
      subject,
      freshPilot: freshSource,
    });
    const matchesRequestedPilotIntent = (job: SmrtJob) =>
      !pilot ||
      (job.args.assessmentCoverageDedupeKey === requestedDedupeKey &&
        JSON.stringify(job.args.assessmentPilot) ===
          JSON.stringify(enveloped.assessmentPilot));
    const candidates = await collection.list({
      limit: 100,
      where: {
        method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
        objectId: normalizedOpportunityId,
        queue: pilot
          ? [
              OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
              OPPORTUNITY_ASSESSMENT_PILOT_QUEUE,
            ]
          : OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
      },
    });
    // Prefer this profile's terminal row when present. A same-tenant row from
    // another profile is still a valid global source receipt fallback.
    const terminalCandidates = [
      ...candidates.filter(
        (job) =>
          ['completed', 'failed', 'cancelled'].includes(job.status) &&
          jobMatchesSourceDependency(
            job,
            normalizedOpportunityId,
            subject,
            source,
            sourceDependencyFingerprint,
          ),
      ),
      ...candidates,
    ];
    const terminalBridge = terminalCandidates
      .map((job) =>
        terminalSourceJobBridge(
          job,
          normalizedOpportunityId,
          subject,
          source,
          sourceDependencyFingerprint,
        ),
      )
      .find((bridge) => bridge !== undefined);
    const coverageOutcome = await readRecordedRequirementCoverageOutcome(
      normalizedOpportunityId,
      opportunity,
      terminalBridge,
    );
    let completed: AttestedCompletedSourceExtraction | undefined;
    let sourceStatus: OpportunityAssessmentSourceStatus = 'screening_pending';
    if (
      coverageOutcome.status === 'missing' ||
      (coverageOutcome.status === 'blocked' &&
        (coverageOutcome.reason === 'confidence' ||
          coverageOutcome.reason === 'structural'))
    ) {
      try {
        completed = await (
          options.readCompletedExtraction ?? readCompletedSourceExtraction
        )(opportunity);
      } catch {
        throw new OpportunityAssessmentDependencyEnqueueError(
          'source_coverage_blocked',
          'The current source lifecycle requires operator review before assessment can resume.',
        );
      }
      if (completed) {
        if (!sameSubject(completed.workspaceSubject, subject))
          throw new OpportunityAssessmentDependencyEnqueueError(
            'source_coverage_blocked',
            'Source evidence preparation belongs to another workspace subject; its operator must complete it.',
          );
        sourceStatus = 'audit_pending';
      }
    }
    if (coverageOutcome.status === 'blocked' && !completed) {
      throw new OpportunityAssessmentDependencyEnqueueError(
        'source_coverage_blocked',
        blockedCoverageMessage(coverageOutcome.reason),
      );
    }
    // A terminal native refusal is an operational block for this exact private
    // intent, not evidence of billing or shared source quality. In particular,
    // do not reuse another profile's conservative/zero-usage failure here.
    if (
      coverageOutcome.status === 'missing' &&
      candidates.some(
        (job) =>
          job.status === 'failed' &&
          matchesRequestedPilotIntent(job) &&
          job.lastError ===
            'This idempotency key has a prior terminal failure and requires operator review.' &&
          jobMatchesSourceDependency(
            job,
            normalizedOpportunityId,
            subject,
            source,
            sourceDependencyFingerprint,
          ) &&
          terminalSourceJobBridge(
            job,
            normalizedOpportunityId,
            subject,
            source,
            sourceDependencyFingerprint,
          ) !== undefined,
      )
    ) {
      throw new OpportunityAssessmentDependencyEnqueueError(
        'source_coverage_blocked',
        'The current source preparation attempt requires operator review before assessment can resume.',
      );
    }
    if (
      pilot &&
      !freshSource &&
      coverageOutcome.status !== 'ready' &&
      !completed &&
      !(await readPartialOpportunityRequirementEvidence(opportunity))
        ?.acceptedRequirements.length
    )
      throw new OpportunityAssessmentDependencyEnqueueError(
        'source_coverage_blocked',
        'Assessment pilot requires a current paid extraction or recorded source proof; new extraction is not permitted.',
      );
    const active = candidates.find(
      (job) =>
        job.queue === queue &&
        matchesRequestedPilotIntent(job) &&
        activeJobMatches(
          job,
          normalizedOpportunityId,
          subject,
          source,
          sourceDependencyFingerprint,
        ),
    );
    if (active) {
      return {
        enqueued: false,
        job: active,
        sourceDependency,
        stage: 'source_preparation' as const,
        sourceStatus,
      };
    }
    const job = await collection.enqueueJob({
      args: {
        ...enveloped,
        assessmentCoverageContract: OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT,
        assessmentCoverageDedupeKey: requestedDedupeKey,
        contentFingerprint: source.fingerprint,
        contentVersion: source.version,
        sourceDependencyFingerprint,
        reason:
          options.reason ??
          (text(enveloped.reason) || 'assessment_prerequisite'),
      },
      maxAttempts: pilot ? 1 : 2,
      method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
      objectId: normalizedOpportunityId,
      objectType: OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE,
      priority: 80,
      queue,
      runAt: options.now ?? new Date(),
      tenantId: subject.tenantId,
      timeout: OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS,
    });
    return {
      enqueued: true,
      job,
      sourceDependency,
      stage: 'source_preparation' as const,
      sourceStatus,
    };
  });
}

/**
 * Screens new extraction intents under the profile principal before source work.
 * Shared source preparation receives only its original run and source identity;
 * the private continuation revalidates both source and screening receipts.
 */
export async function runOpportunityAssessmentDependencyJob(
  opportunity: OpportunityRecord,
  args: OpportunityAssessmentDependencyJobArgs = {},
  context: JobExecutionContext,
  subject: RuntimeWorkspaceSubject,
  dependencies: RunOpportunityAssessmentDependencyJobDependencies = {},
): Promise<{
  message: string;
  status: 'prepared' | 'skipped';
  sourceStatus?: OpportunityAssessmentSourceStatus;
}> {
  const opportunityId = text(opportunity.id);
  if (!opportunityId) throw new Error('Opportunity id is required.');
  const queue = opportunityAssessmentJobQueue(args);
  const pilot = queue === OPPORTUNITY_ASSESSMENT_PILOT_QUEUE;
  const freshSource = opportunityAssessmentPilotAllowsFreshSource(args);
  if (pilot || context.job?.queue === OPPORTUNITY_ASSESSMENT_PILOT_QUEUE)
    await assertOpportunityAssessmentPilotJobRouting(
      opportunityId,
      args,
      context,
      subject,
    );
  const expected = requiredSourceArgs(args);
  const dedupeKey = opportunityAssessmentCoverageDedupeKey({
    sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
    subject,
    freshPilot: freshSource,
  });
  if (args.assessmentCoverageDedupeKey !== dedupeKey) {
    throw new Error('Assessment coverage job ownership identity is invalid.');
  }
  const getOpportunity = dependencies.getOpportunity ?? defaultOpportunity;
  const readCoverageOutcome =
    dependencies.readCoverageOutcome ?? readRecordedRequirementCoverageOutcome;
  const readPriorBridge =
    dependencies.readPriorSourceJobBridge ?? readPriorSourceJobBridge;
  const withLock =
    dependencies.withLifecycleLock ?? withOpportunityLifecycleLock;
  const startRun =
    dependencies.startRun ?? startOpportunityIntelligenceAgentRun;
  const finishRun =
    dependencies.finishRun ?? finishOpportunityIntelligenceAgentRun;
  const recordRun =
    dependencies.recordSourcePreparationRun ?? recordSourcePreparationRun;
  const runAsRevalidated =
    dependencies.runAsRevalidated ?? runAsRevalidatedJobWorkspaceSubject;
  const prepareSource = dependencies.prepareSource ?? processOpportunityWithLlm;
  const readPartialEvidence =
    dependencies.readPartialEvidence ??
    readPartialOpportunityRequirementEvidence;
  const readCompleted =
    dependencies.readCompletedExtraction ?? readCompletedSourceExtraction;
  const assertNotAttempted =
    dependencies.assertNotAttempted ??
    assertOpportunitySourceExtractionNotAttempted;
  const auditEvidence =
    dependencies.auditEvidence ?? evaluateRequirementEvidenceAudit;
  const preflightEvidence =
    dependencies.preflightEvidence ?? preflightSourceEvidence;
  const prepareScreen =
    dependencies.prepareScreen ?? prepareCurrentOpportunityAssessmentScreen;
  const readScreen =
    dependencies.readScreen ?? readCurrentOpportunityAssessmentScreen;
  const evaluateScreen =
    dependencies.evaluateScreen ?? evaluateOpportunityAssessmentScreen;
  const assertScreenNotAttempted =
    dependencies.assertScreenNotAttempted ??
    assertOpportunityAssessmentScreenNotAttempted;
  let requiredScreen: CurrentOpportunityAssessmentScreen | undefined;
  const preparation: {
    message: string;
    ready: boolean;
    sourceStatus?: OpportunityAssessmentSourceStatus;
  } = await withLock(
    opportunityId,
    async () =>
      await runAsRevalidated(
        subject,
        'assessment.execute',
        async (_subject, run) => {
          await run.assertOperation('opportunities', 'read');
          if (pilot)
            await assertOpportunityAssessmentPilotJobRouting(
              opportunityId,
              args,
              context,
              subject,
            );
          const isCurrent = (
            current: OpportunityRecord | null,
          ): current is OpportunityRecord =>
            sourceIdentityMatches(current, expected) &&
            requirementCoverageSourceDependencyFingerprint(current) ===
              expected.sourceDependencyFingerprint;
          const current = await getOpportunity(opportunityId);
          if (!isCurrent(current))
            return {
              message: 'Skipped stale opportunity source.',
              ready: false as const,
            };
          const sourceBridge = await readPriorBridge(
            context,
            subject,
            expected,
            opportunityId,
          );
          const initialCoverage = await readCoverageOutcome(
            opportunityId,
            current,
            sourceBridge,
          );
          if (initialCoverage.status === 'ready')
            return {
              message: 'Reused verified source coverage.',
              ready: true as const,
            };
          const initialPartial = await readPartialEvidence(current);
          if (initialPartial)
            return initialPartial.acceptedRequirements.length
              ? {
                  message: 'Reused recorded partial source evidence.',
                  ready: true as const,
                  sourceStatus: 'partial' as const,
                }
              : {
                  message:
                    'Current source evidence has no verified applicant excerpts; operator review is required.',
                  ready: false as const,
                  sourceStatus: 'audit_blocked' as const,
                };
          if (
            initialCoverage.status === 'blocked' &&
            initialCoverage.reason !== 'confidence' &&
            initialCoverage.reason !== 'structural'
          )
            return {
              message: blockedCoverageMessage(initialCoverage.reason),
              ready: false as const,
              sourceStatus: 'audit_blocked' as const,
            };

          let activeScreen: CurrentOpportunityAssessmentScreen | undefined;
          let screeningChanged = false;
          const fresh = async <T>(work: () => Promise<T>) =>
            await runAsRevalidated(
              subject,
              'assessment.execute',
              async (_fresh, principal) => {
                await principal.assertOperation('opportunities', 'read');
                if (pilot)
                  await assertOpportunityAssessmentPilotJobRouting(
                    opportunityId,
                    args,
                    context,
                    subject,
                  );
                if (!isCurrent(await getOpportunity(opportunityId))) {
                  screeningChanged = Boolean(activeScreen);
                  throw new Error('Source preparation is no longer current.');
                }
                if (activeScreen) {
                  let currentScreen:
                    | CurrentOpportunityAssessmentScreen
                    | undefined;
                  try {
                    currentScreen = await readScreen({
                      opportunityId,
                      subject,
                      requestId: activeScreen.requestId,
                    });
                  } catch {
                    screeningChanged = true;
                    throw new Error(
                      'The source or active screening profile changed.',
                    );
                  }
                  if (
                    !currentScreen ||
                    currentScreen.inputFingerprint !==
                      activeScreen.inputFingerprint ||
                    currentScreen.agentRunId !== activeScreen.agentRunId ||
                    currentScreen.outcome !== activeScreen.outcome
                  ) {
                    screeningChanged = true;
                    throw new Error(
                      'The source or active screening profile changed.',
                    );
                  }
                }
                return await work();
              },
            );
          const assertCurrentAuthority = async () =>
            await fresh(async () => undefined);
          const persist: FencedOpportunityUpdate = async (
            id,
            fingerprint,
            updates,
          ) =>
            await fresh(async () => {
              if (id !== opportunityId || fingerprint !== expected.fingerprint)
                throw new Error(
                  'Source preparation publication identity is invalid.',
                );
              return await runOpportunityLifecycleTransaction(
                async (database) =>
                  await defaultFencedOpportunityUpdate(
                    id,
                    fingerprint,
                    updates,
                    expected.version,
                    database,
                  ),
              );
            });
          let actual: AttestedCompletedSourceExtraction | undefined;
          try {
            actual = await readCompleted(current);
          } catch {
            return {
              message:
                'The current source lifecycle requires operator review before assessment can resume.',
              ready: false as const,
              sourceStatus: 'operator_required' as const,
            };
          }
          if (actual && !sameSubject(actual.workspaceSubject, subject))
            return {
              message:
                'Source evidence preparation belongs to another workspace subject; its operator must complete it.',
              ready: false as const,
              sourceStatus: 'operator_required' as const,
            };
          if (!actual && pilot && !freshSource)
            return {
              message:
                'Assessment pilot requires a current paid extraction; new extraction is not permitted.',
              ready: false as const,
              sourceStatus: 'operator_required' as const,
            };
          if (!actual && initialCoverage.status === 'blocked')
            return {
              message: blockedCoverageMessage(initialCoverage.reason),
              ready: false as const,
              sourceStatus: 'audit_blocked' as const,
            };
          let agentRunId = actual?.agentRunId ?? '';
          if (!actual) {
            try {
              await assertNotAttempted(current);
            } catch {
              return {
                message:
                  'The exact source identity was already attempted; operator review is required.',
                ready: false as const,
                sourceStatus: 'operator_required' as const,
              };
            }
            let preparedScreen: Awaited<ReturnType<typeof prepareScreen>>;
            let screen: Awaited<ReturnType<typeof readScreen>>;
            try {
              preparedScreen = await prepareScreen(opportunityId, subject);
              if (
                preparedScreen.sourceIdentity.sourceContentFingerprint !==
                  expected.fingerprint ||
                preparedScreen.sourceIdentity.sourceContentVersion !==
                  expected.version
              )
                throw new Error('Screening source is no longer current.');
              if (!preparedScreen.profile.targetRoles.length)
                return {
                  message:
                    'Screening is on hold: add your target role preferences before assessing this posting.',
                  ready: false as const,
                  sourceStatus: 'screening_hold' as const,
                };
              screen = await readScreen({ opportunityId, subject });
              if (!screen)
                await assertScreenNotAttempted(preparedScreen, {
                  opportunityId,
                  workspaceSubject: subject,
                });
            } catch {
              return {
                message:
                  'Screening is on hold: verify the current posting and active profile, or review the prior attempt.',
                ready: false as const,
                sourceStatus: 'screening_hold' as const,
              };
            }
            let runRecorded = false;
            let startedScreenRun = false;
            if (screen) {
              agentRunId = screen.agentRunId;
            } else {
              await assertCurrentAuthority();
              agentRunId = await startRun({
                opportunityId,
                sourceId: text(current.sourceId),
                userId: subject.userId,
                workspaceSubject: subject,
              });
              startedScreenRun = true;
              try {
                await recordRun(
                  context,
                  subject,
                  expected,
                  opportunityId,
                  agentRunId,
                );
                runRecorded = true;
                const screened = await evaluateScreen(preparedScreen, {
                  agentRunId,
                  opportunityId,
                  contentFingerprint: expected.fingerprint,
                  workspaceSubject: subject,
                  signal: AbortSignal.timeout(
                    OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS,
                  ),
                });
                screen = await readScreen({
                  opportunityId,
                  subject,
                  requestId: screened.requestId,
                });
                if (
                  !screen ||
                  screen.agentRunId !== agentRunId ||
                  screen.inputFingerprint !== screened.inputFingerprint
                )
                  throw new Error('Screening receipt is no longer current.');
              } catch (error) {
                await finishRun(
                  agentRunId,
                  'failed',
                  error instanceof Error ? error.message : String(error),
                  subject,
                );
                return {
                  message:
                    'Screening is on hold: its current actual receipt requires review.',
                  ready: false as const,
                  sourceStatus: 'screening_hold' as const,
                };
              }
            }
            activeScreen = screen;
            try {
              await assertCurrentAuthority();
            } catch {
              return {
                message:
                  'Screening is on hold: the posting or active profile changed.',
                ready: false as const,
                sourceStatus: 'screening_hold' as const,
              };
            }
            if (screen.screen.holdReasons.length) {
              if (startedScreenRun)
                await finishRun(agentRunId, 'succeeded', '', subject);
              return {
                message:
                  'Screening is on hold: complete your target role preferences or clarify the posting before deeper matching.',
                ready: false as const,
                sourceStatus: 'screening_hold' as const,
              };
            }
            if (screen.outcome === 'clear_mismatch') {
              const evidence = screen.screen.evidence.filter((item) =>
                screen.screen.mismatches.includes(item.dimension),
              );
              const citations = evidence
                .map((item) => `“${item.witness.text}”`)
                .join('; ');
              if (startedScreenRun)
                await finishRun(agentRunId, 'succeeded', '', subject);
              if (!citations)
                return {
                  message:
                    'Screening is on hold: its mismatch has no current source citation.',
                  ready: false as const,
                  sourceStatus: 'screening_hold' as const,
                };
              return {
                message: `Screening found an explicit mismatch with your current profile: ${citations}`,
                ready: false as const,
                sourceStatus: 'screening_excluded' as const,
              };
            }
            if (
              (screen.outcome !== 'potentially_relevant' &&
                screen.outcome !== 'uncertain') ||
              !screen.screen.plausiblyRelevant
            ) {
              if (startedScreenRun)
                await finishRun(agentRunId, 'succeeded', '', subject);
              return {
                message:
                  'Screening is on hold: clarify role relevance before deeper matching.',
                ready: false as const,
                sourceStatus: 'screening_hold' as const,
              };
            }
            requiredScreen = screen;
            const sourceJob = {
              sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
              sourcePreparationAgentRunId: agentRunId,
            };
            try {
              if (!runRecorded)
                await recordRun(
                  context,
                  subject,
                  expected,
                  opportunityId,
                  agentRunId,
                );
              await assertCurrentAuthority();
              const extracted = await prepareSource(opportunityId, {
                agentRunId,
                sourceExtractionStage: 'extract-only',
                assertCurrentAuthority,
                expectedSourceContentFingerprint: expected.fingerprint,
                fencedOpportunityUpdate: persist,
                signal: AbortSignal.timeout(
                  OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS,
                ),
                sourceContentVersion: expected.version,
              });
              await finishRun(
                agentRunId,
                extracted.status === 'processed' ? 'succeeded' : 'failed',
                extracted.status === 'processed' ? '' : extracted.message,
                subject,
              );
              if (extracted.status !== 'processed') {
                if (extracted.status === 'error')
                  throw new Error(extracted.message);
                return { message: extracted.message, ready: false as const };
              }
              const refreshed = await getOpportunity(opportunityId);
              if (!isCurrent(refreshed))
                return {
                  message: 'Skipped stale opportunity source.',
                  ready: false as const,
                };
              // A concurrent existing verified receipt remains the full-path authority.
              if (
                (await readCoverageOutcome(opportunityId, refreshed, sourceJob))
                  .status === 'ready'
              )
                return {
                  message: 'Prepared verified source coverage.',
                  ready: true as const,
                };
              actual = await readCompleted(refreshed);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              await finishRun(agentRunId, 'failed', message, subject);
              if (screeningChanged)
                return {
                  message:
                    'Screening is on hold: the posting or active profile changed.',
                  ready: false as const,
                  sourceStatus: 'screening_hold' as const,
                };
              const failedCurrent = await getOpportunity(opportunityId);
              if (isCurrent(failedCurrent)) {
                const failed = await readCoverageOutcome(
                  opportunityId,
                  failedCurrent,
                  sourceJob,
                );
                if (failed.status === 'blocked')
                  return {
                    message: blockedCoverageMessage(failed.reason),
                    ready: false as const,
                    sourceStatus: 'operator_required' as const,
                  };
              }
              throw error;
            }
          }
          if (
            !actual ||
            actual.agentRunId !== agentRunId ||
            !sameSubject(actual.workspaceSubject, subject)
          )
            return {
              message:
                'The completed source checkpoint requires native receipt review.',
              ready: false as const,
              sourceStatus: 'operator_required' as const,
            };
          await recordRun(
            context,
            subject,
            expected,
            opportunityId,
            agentRunId,
          );
          await assertCurrentAuthority();
          const completedExtraction = actual;
          const canonicalPrepared =
            prepareCapturedSourceCompositeRequirementEvidenceAudit(
              completedExtraction.context,
              completedExtraction.ledger,
              {
                sourceContentJson: completedExtraction.sourceContentJson,
                extractionRequestId: completedExtraction.requestId,
              },
            );
          const publishEvidence = async (
            evidence: Awaited<ReturnType<typeof auditEvidence>>,
          ) => {
            await assertCurrentAuthority();
            const refreshed = await getOpportunity(opportunityId);
            if (!isCurrent(refreshed))
              return {
                message: 'Skipped stale opportunity source.',
                ready: false as const,
              };
            const confirmed = await readCompleted(refreshed);
            if (
              !confirmed ||
              confirmed.requestId !== completedExtraction.requestId ||
              confirmed.agentRunId !== completedExtraction.agentRunId ||
              !sameSubject(confirmed.workspaceSubject, subject) ||
              confirmed.ledgerFingerprint !==
                completedExtraction.ledgerFingerprint ||
              JSON.stringify(confirmed.context) !==
                JSON.stringify(completedExtraction.context) ||
              confirmed.sourceContentJson !==
                completedExtraction.sourceContentJson
            )
              throw new Error(
                'Source lifecycle changed before evidence publication.',
              );
            const refreshedCache = JSON.parse(
              String(refreshed.preparedPostingJson || '{}'),
            );
            if (
              !refreshedCache ||
              typeof refreshedCache !== 'object' ||
              Array.isArray(refreshedCache)
            )
              throw new Error('Invalid current source preparation cache.');
            const preparedPostingJson = JSON.stringify({
              ...refreshedCache,
              requirementCoverage: completedExtraction.ledger,
              requirementCoverageEvidenceAudit: evidence,
            });
            const exactEvidence = (
              value: Awaited<ReturnType<typeof readPartialEvidence>>,
            ) =>
              Boolean(
                value &&
                  value.audit.version === canonicalPrepared.version &&
                  value.audit.requestId === evidence.requestId &&
                  value.audit.fingerprint === evidence.fingerprint &&
                  value.audit.inputFingerprint ===
                    canonicalPrepared.inputFingerprint &&
                  value.audit.ledgerFingerprint ===
                    completedExtraction.ledgerFingerprint &&
                  value.context.sourceFingerprint ===
                    completedExtraction.context.sourceFingerprint &&
                  value.context.sourceVersion ===
                    completedExtraction.context.sourceVersion &&
                  value.context.sourceText ===
                    completedExtraction.context.sourceText &&
                  value.capturedSource?.extractionRequestId ===
                    completedExtraction.requestId &&
                  value.capturedSource.sourceContentJson ===
                    completedExtraction.sourceContentJson,
              );
            // This leaf selects a native receipt; it never establishes authority.
            const replay = await readPartialEvidence({
              ...refreshed,
              preparedPostingJson,
            });
            if (!exactEvidence(replay))
              throw new Error(
                'Completed source evidence lacks its exact native GLOBAL actual receipt.',
              );
            if (
              !(await persist(opportunityId, expected.fingerprint, {
                preparedPostingJson,
                preparedPostingFingerprint:
                  completedExtraction.posting.fingerprint,
                preparedPostingVersion: completedExtraction.posting.version,
                updated_at: new Date(),
              }))
            )
              return {
                message: 'Discarded stale source evidence audit result.',
                ready: false as const,
              };
            await assertCurrentAuthority();
            const published = await getOpportunity(opportunityId);
            if (!isCurrent(published))
              throw new Error(
                'Source evidence publication is no longer current.',
              );
            const partial = await readPartialEvidence(published);
            if (!exactEvidence(partial))
              throw new Error(
                'Published source evidence lacks its exact current native GLOBAL receipt.',
              );
            return partial?.acceptedRequirements.length
              ? {
                  message: 'Prepared recorded partial source evidence.',
                  ready: true as const,
                  sourceStatus: 'partial' as const,
                }
              : {
                  message:
                    'Source audit recorded no verified applicant excerpts; overall match remains uncertain.',
                  ready: false as const,
                  sourceStatus: 'audit_blocked' as const,
                };
          };
          // A completed native audit is sunk work. Replay it before reserving a
          // hypothetical additional call, including when the run is now full.
          await assertCurrentAuthority();
          const recordedSource = await getOpportunity(opportunityId);
          if (!isCurrent(recordedSource))
            throw new Error(
              'Source evidence publication is no longer current.',
            );
          const recordedCache = JSON.parse(
            String(recordedSource.preparedPostingJson || '{}'),
          );
          if (
            !recordedCache ||
            typeof recordedCache !== 'object' ||
            Array.isArray(recordedCache)
          )
            throw new Error('Invalid current source preparation cache.');
          const recorded = await readPartialEvidence({
            ...recordedSource,
            preparedPostingJson: JSON.stringify({
              ...recordedCache,
              requirementCoverage: completedExtraction.ledger,
              requirementCoverageEvidenceAudit: {
                capturedSource: {
                  extractionRequestId: completedExtraction.requestId,
                },
              },
            }),
          });
          if (recorded?.audit.version === canonicalPrepared.version)
            return await publishEvidence(recorded.audit);
          let plan: Awaited<ReturnType<typeof preflightEvidence>>;
          try {
            plan = await preflightEvidence(actual);
          } catch {
            return {
              message:
                'Source checkpoint retained: configure approved evidence audit pricing and limits before resuming.',
              ready: false as const,
              sourceStatus: 'audit_blocked' as const,
            };
          }
          if (!plan.admitted)
            return {
              message:
                'Source checkpoint retained: exact evidence audit and historical reservations exceed the lifecycle ceiling.',
              ready: false as const,
              sourceStatus: 'audit_blocked' as const,
            };
          await assertCurrentAuthority();
          const beforeAudit = await getOpportunity(opportunityId);
          if (!isCurrent(beforeAudit))
            return {
              message: 'Skipped stale opportunity source.',
              ready: false as const,
            };
          let reattested: AttestedCompletedSourceExtraction | undefined;
          try {
            reattested = await readCompleted(beforeAudit);
          } catch {
            return {
              message:
                'The source lifecycle requires operator review before evidence admission.',
              ready: false as const,
              sourceStatus: 'operator_required' as const,
            };
          }
          if (
            !reattested ||
            reattested.requestId !== actual.requestId ||
            reattested.agentRunId !== actual.agentRunId ||
            !sameSubject(reattested.workspaceSubject, subject) ||
            reattested.ledgerFingerprint !== actual.ledgerFingerprint ||
            reattested.context.extractionFingerprint !==
              actual.context.extractionFingerprint ||
            JSON.stringify(reattested.reservation) !==
              JSON.stringify(actual.reservation)
          )
            return {
              message:
                'The source lifecycle changed before evidence admission.',
              ready: false as const,
              sourceStatus: 'operator_required' as const,
            };
          let existing: Record<string, unknown>;
          try {
            existing = JSON.parse(
              String(beforeAudit.preparedPostingJson || '{}'),
            );
            if (
              !existing ||
              typeof existing !== 'object' ||
              Array.isArray(existing)
            )
              throw new Error('Invalid source preparation cache.');
          } catch {
            return {
              message: 'Source preparation history requires operator review.',
              ready: false as const,
              sourceStatus: 'operator_required' as const,
            };
          }
          if (
            !existing.requirementCoverage ||
            requirementCoverageLedgerFingerprint(
              existing.requirementCoverage as typeof actual.ledger,
            ) !== actual.ledgerFingerprint
          ) {
            if (
              !(await persist(opportunityId, expected.fingerprint, {
                preparedPostingJson: JSON.stringify({
                  ...existing,
                  requirementCoverage: actual.ledger,
                }),
                preparedPostingFingerprint: actual.posting.fingerprint,
                preparedPostingVersion: actual.posting.version,
                updated_at: new Date(),
              }))
            )
              return {
                message: 'Discarded stale source checkpoint.',
                ready: false as const,
              };
          }
          let evidence: Awaited<ReturnType<typeof auditEvidence>>;
          try {
            await assertCurrentAuthority();
            const expectedExtraction = actual;
            evidence = await auditEvidence(plan.preparedAudit, {
              agentRunId,
              opportunityId,
              contentFingerprint: actual.context.sourceFingerprint,
              historicalReservation: actual.reservation,
              resolveCompletedExtraction: async () => {
                await assertCurrentAuthority();
                const currentSource = await getOpportunity(opportunityId);
                if (!isCurrent(currentSource))
                  throw new Error('Source preparation is no longer current.');
                const confirmed = await readCompleted(currentSource);
                if (
                  !confirmed ||
                  confirmed.requestId !== expectedExtraction.requestId ||
                  confirmed.agentRunId !== expectedExtraction.agentRunId ||
                  !sameSubject(confirmed.workspaceSubject, subject) ||
                  confirmed.ledgerFingerprint !==
                    expectedExtraction.ledgerFingerprint ||
                  JSON.stringify(confirmed.context) !==
                    JSON.stringify(expectedExtraction.context) ||
                  JSON.stringify(confirmed.reservation) !==
                    JSON.stringify(expectedExtraction.reservation) ||
                  typeof confirmed.sourceContentJson !== 'string' ||
                  confirmed.sourceContentJson !==
                    expectedExtraction.sourceContentJson
                )
                  throw new Error(
                    'The source lifecycle changed before evidence transport.',
                  );
                return confirmed;
              },
              signal: AbortSignal.timeout(
                OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS,
              ),
            });
            await finishRun(agentRunId, 'succeeded', '', subject);
          } catch (error) {
            await finishRun(
              agentRunId,
              'failed',
              error instanceof Error ? error.message : String(error),
              subject,
            );
            return {
              message:
                'Source evidence auditing failed; the checkpoint is retained for operator review.',
              ready: false as const,
              sourceStatus: 'operator_required' as const,
            };
          }
          return await publishEvidence(evidence);
        },
      ),
  );

  if (!preparation.ready)
    return {
      message: preparation.message,
      status: 'skipped',
      ...(preparation.sourceStatus
        ? { sourceStatus: preparation.sourceStatus }
        : {}),
    };

  const enqueueAssessment =
    dependencies.enqueueAssessment ??
    (async (id: string) => {
      // The main intelligence queue now imports this prerequisite helper, so
      // keep the continuation edge dynamic instead of making a module cycle.
      const {
        enqueueWorkspaceOpportunityIntelligenceWithStatus,
        enqueueWorkspaceOpportunityAssessmentPilotWithStatus,
      } = await import('./opportunity-intelligence-job.js');
      return pilot
        ? await enqueueWorkspaceOpportunityAssessmentPilotWithStatus(id)
        : await enqueueWorkspaceOpportunityIntelligenceWithStatus(id, {
            modes: 'assessment',
          });
    });
  return await runAsRevalidated(
    subject,
    'assessment.execute',
    async (_currentSubject, run) => {
      await run.assertOperation('opportunities', 'read');
      if (pilot)
        await assertOpportunityAssessmentPilotJobRouting(
          opportunityId,
          args,
          context,
          subject,
        );
      const current = await getOpportunity(opportunityId);
      if (
        !sourceIdentityMatches(current, expected) ||
        requirementCoverageSourceDependencyFingerprint(current) !==
          expected.sourceDependencyFingerprint ||
        ((
          await readCoverageOutcome(
            opportunityId,
            current,
            await readPriorBridge(context, subject, expected, opportunityId),
          )
        ).status !== 'ready' &&
          !(await readPartialEvidence(current))?.acceptedRequirements.length)
      ) {
        return {
          message: 'Skipped stale opportunity source.',
          status: 'skipped' as const,
        };
      }
      if (requiredScreen) {
        let screened: CurrentOpportunityAssessmentScreen | undefined;
        try {
          screened = await readScreen({
            opportunityId,
            subject,
            requestId: requiredScreen.requestId,
          });
        } catch {
          return {
            message:
              'Screening is on hold: verify the current posting and active profile before assessment.',
            status: 'skipped' as const,
            sourceStatus: 'screening_hold' as const,
          };
        }
        if (
          !screened ||
          screened.inputFingerprint !== requiredScreen.inputFingerprint ||
          screened.agentRunId !== requiredScreen.agentRunId ||
          screened.outcome !== requiredScreen.outcome ||
          screened.screen.holdReasons.length ||
          !screened.screen.plausiblyRelevant
        )
          return {
            message:
              'Screening is on hold: the posting or active profile changed before assessment.',
            status: 'skipped' as const,
            sourceStatus: 'screening_hold' as const,
          };
      }
      await enqueueAssessment(opportunityId);
      return {
        message: 'Queued private opportunity assessment.',
        status: 'prepared' as const,
        ...(preparation.sourceStatus
          ? { sourceStatus: preparation.sourceStatus }
          : {}),
      };
    },
  );
}
