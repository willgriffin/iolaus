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
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
import { requirementCoverageContextForOpportunity } from './opportunity-requirement-coverage.js';
import {
  evaluateRequirementEvidenceAudit,
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
import { opportunityWithSourceContent } from './opportunity-source-content.js';
import { getCollection } from './smrt.js';

/** A separate source-only prerequisite job on the existing intelligence queue. */
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD =
  'prepareAssessmentCoverage';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT =
  'opportunity-assessment-dependency/v1';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_TIMEOUT_MS = 3 * 60 * 1000;
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE =
  'opportunity-intelligence';
export const OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE =
  '@willgriffin/iolaus-site:Opportunity';

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
  | 'partial';

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
}): string {
  const { subject } = options;
  return `assessment-coverage-job/v1:${createHash('sha256')
    .update(
      JSON.stringify({
        contract: OPPORTUNITY_ASSESSMENT_DEPENDENCY_CONTRACT,
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
    job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
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
    job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
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
  const job = await jobs.get(durableJobId);
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
    runnerContext.job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
    runnerContext.job.objectType !==
      OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE ||
    runnerContext.job.method !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD
  ) {
    throw new Error('Source preparation job bridge is not authentic.');
  }
  const job = await loadCurrentSourceJob(context);
  if (
    job.status !== 'running' ||
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
    runnerContext.job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
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
    job.attempts !== runnerContext.job.attempt ||
    job.queue !== OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE ||
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
  const normalizedOpportunityId = text(opportunityId);
  if (!normalizedOpportunityId) {
    throw new OpportunityAssessmentDependencyEnqueueError(
      'opportunity_id_required',
      'Opportunity id is required.',
    );
  }
  const {
    sourcePreparationAgentRunId: _ignoredSourcePreparationAgentRunId,
    partialAssessmentEvidence: _ignoredPartialEvidence,
    sourceCoverageStage: _ignoredSourceStage,
    ...callerArgs
  } = args;
  const enveloped = withRuntimeWorkspaceSubject(callerArgs);
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
    const candidates = await collection.list({
      limit: 100,
      where: {
        method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
        objectId: normalizedOpportunityId,
        queue: OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
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
    let sourceStatus: OpportunityAssessmentSourceStatus = 'extraction_pending';
    if (
      coverageOutcome.status === 'missing' ||
      (coverageOutcome.status === 'blocked' &&
        coverageOutcome.reason === 'confidence')
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
    const active = candidates.find((job) =>
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
        assessmentCoverageDedupeKey: opportunityAssessmentCoverageDedupeKey({
          sourceDependencyFingerprint,
          subject,
        }),
        contentFingerprint: source.fingerprint,
        contentVersion: source.version,
        sourceDependencyFingerprint,
        reason:
          options.reason ??
          (text(enveloped.reason) || 'assessment_prerequisite'),
      },
      maxAttempts: 2,
      method: OPPORTUNITY_ASSESSMENT_DEPENDENCY_METHOD,
      objectId: normalizedOpportunityId,
      objectType: OPPORTUNITY_ASSESSMENT_DEPENDENCY_OBJECT_TYPE,
      priority: 80,
      queue: OPPORTUNITY_ASSESSMENT_DEPENDENCY_QUEUE,
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
 * Runs only source preparation under the lifecycle lock. The subsequent
 * candidate continuation gets a new principal fence and re-reads the source
 * receipt, so no private payload is available to the provider phase.
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
  const expected = requiredSourceArgs(args);
  const dedupeKey = opportunityAssessmentCoverageDedupeKey({
    sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
    subject,
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
            initialCoverage.reason !== 'confidence'
          )
            return {
              message: blockedCoverageMessage(initialCoverage.reason),
              ready: false as const,
              sourceStatus: 'audit_blocked' as const,
            };

          const fresh = async <T>(work: () => Promise<T>) =>
            await runAsRevalidated(
              subject,
              'assessment.execute',
              async (_fresh, principal) => {
                await principal.assertOperation('opportunities', 'read');
                if (!isCurrent(await getOpportunity(opportunityId)))
                  throw new Error('Source preparation is no longer current.');
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
            await assertCurrentAuthority();
            agentRunId = await startRun({
              opportunityId,
              sourceId: text(current.sourceId),
              userId: subject.userId,
              workspaceSubject: subject,
            });
            const sourceJob = {
              sourceDependencyFingerprint: expected.sourceDependencyFingerprint,
              sourcePreparationAgentRunId: agentRunId,
            };
            try {
              await recordRun(
                context,
                subject,
                expected,
                opportunityId,
                agentRunId,
              );
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
          try {
            await assertCurrentAuthority();
            await auditEvidence(plan.preparedAudit, {
              agentRunId,
              opportunityId,
              contentFingerprint: actual.context.sourceFingerprint,
              historicalReservation: actual.reservation,
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
          await assertCurrentAuthority();
          const refreshed = await getOpportunity(opportunityId);
          if (!isCurrent(refreshed))
            return {
              message: 'Skipped stale opportunity source.',
              ready: false as const,
            };
          const partial = await readPartialEvidence(refreshed);
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
      const { enqueueWorkspaceOpportunityIntelligenceWithStatus } =
        await import('./opportunity-intelligence-job.js');
      return await enqueueWorkspaceOpportunityIntelligenceWithStatus(id, {
        modes: 'assessment',
      });
    });
  return await runAsRevalidated(
    subject,
    'assessment.execute',
    async (_currentSubject, run) => {
      await run.assertOperation('opportunities', 'read');
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
