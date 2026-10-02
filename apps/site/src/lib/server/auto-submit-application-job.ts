import { createHash, randomUUID } from 'node:crypto';
import type { SmrtObject } from '@happyvertical/smrt-core';
import {
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
  type SmrtJobData,
} from '@happyvertical/smrt-jobs';
import {
  finalApprovalResumePdfDigest,
  finalApprovalResumePdfFilename,
} from '../objects/application-approval-scope.js';
import { requireCurrentPrivateWorkspaceSubject } from './agent-audit-subject.js';
import { commitApplicationIfCurrent } from './application-concurrency.js';
import { applicationResumePdfFile } from './application-resume-file.js';
import {
  recordAgentAudit,
  routeApplicationToAnswerCollection,
  syncApplicationWorkflowTasks,
} from './application-workflow.js';
import { getAtsSubmitter, parseAtsFormSchema } from './ats/index.js';
import type { AtsFilePart } from './ats/types.js';
import {
  AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
  AUTO_SUBMIT_APPLICATION_METHOD,
  AUTO_SUBMIT_APPLICATION_QUEUE,
  AUTO_SUBMIT_APPLICATION_TIMEOUT_MS,
  ensureAutoSubmitApplicationJobDedupe,
  isAutoSubmitApplicationActiveJobConflict,
} from './auto-submit-application-job-schema.js';
import {
  type AutoSubmitConfig,
  autoSubmitFeatureActive,
  resolveAutoSubmitConfig,
} from './auto-submit-config.js';
import {
  type AutoSubmitEligibility,
  canAutoSubmit,
  parseRequiredAnswers,
} from './auto-submit-eligibility.js';
import { getSmrtOptions } from './db.js';
import {
  getJobPrivateResource,
  runtimeWorkspaceSubjectFromJobArgs,
  withRuntimeWorkspaceSubject,
} from './job-workspace-subject.js';
import {
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getResumeFilesystem } from './resume-files.js';

export {
  AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
  AUTO_SUBMIT_APPLICATION_METHOD,
  AUTO_SUBMIT_APPLICATION_QUEUE,
  AUTO_SUBMIT_APPLICATION_TIMEOUT_MS,
  ensureAutoSubmitApplicationJobDedupe,
} from './auto-submit-application-job-schema.js';

export interface AutoSubmitApplicationJobArgs extends Record<string, unknown> {
  reason?: string;
}

interface AutoSubmitApplicationJobCollection {
  create: (data: SmrtJobData) => Promise<SmrtJob>;
  list: (options?: {
    limit?: number;
    orderBy?: string | string[];
    where?: Record<string, unknown>;
  }) => Promise<SmrtJob[]>;
}

export interface EnqueueAutoSubmitApplicationOptions {
  applicationCollection?: {
    get: (id: string) => Promise<unknown | null | undefined>;
  };
  collection?: AutoSubmitApplicationJobCollection;
  now?: Date;
  reason?: string;
}

export type AutoSubmitOutcome =
  | 'dry_run'
  | 'submitted'
  | 'awaiting_user'
  | 'manual_submission'
  | 'noop';

export interface AutoSubmitJobResult {
  outcome: AutoSubmitOutcome;
  code: AutoSubmitEligibility['code'];
  reason: string;
}

export interface RunAutoSubmitApplicationJobDependencies {
  config?: AutoSubmitConfig;
  evaluate?: (
    application: Record<string, unknown>,
    options: { config: AutoSubmitConfig; subject: WorkspaceSubject },
  ) => Promise<AutoSubmitEligibility>;
  resolveResume?: (
    application: Record<string, unknown>,
    subject: WorkspaceSubject,
  ) => Promise<AtsFilePart>;
  recordAudit?: typeof recordAgentAudit;
  routeToAnswerCollection?: typeof routeApplicationToAnswerCollection;
  setApplicationStatus?: (
    application: Record<string, unknown>,
    status: string,
  ) => Promise<boolean | undefined>;
}

export class AutoSubmitApplicationEnqueueError extends Error {
  code: 'application_id_required' | 'application_not_found';

  constructor(
    code: 'application_id_required' | 'application_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'AutoSubmitApplicationEnqueueError';
    this.code = code;
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function resolveResumeFilePart(
  application: Record<string, unknown>,
  subject: WorkspaceSubject,
): Promise<AtsFilePart> {
  const base: AtsFilePart = {
    fieldName: 'resume',
    filename: 'resume.pdf',
    contentType: 'application/pdf',
    byteLength: 0,
    present: false,
  };
  try {
    const resumeFile = await applicationResumePdfFile(application, subject);
    if (!resumeFile) return base;
    const filesystem = await getResumeFilesystem();
    if (!(await filesystem.exists(resumeFile.pdfPath))) return base;
    const bytes = (await filesystem.read(resumeFile.pdfPath, {
      raw: true,
    })) as Uint8Array | null;
    const byteLength = bytes?.byteLength ?? bytes?.length ?? 0;
    if (!bytes || !byteLength) return base;
    return {
      ...base,
      byteLength,
      filename: resumeFile.filename,
      present: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return base;
  }
}

async function defaultSetApplicationStatus(
  application: Record<string, unknown>,
  status: string,
  subject: WorkspaceSubject,
): Promise<boolean> {
  // Jobs retain an object that may be older than a material edit, a final
  // approval, or a manual recording action. Patch only when the full material
  // and approval fence is still current; never save that stale object.
  if (!(await commitApplicationIfCurrent(application, { status }))) {
    return false;
  }
  await syncApplicationWorkflowTasks(application, subject);
  return true;
}

async function findActiveAutoSubmitJob(
  collection: AutoSubmitApplicationJobCollection,
  applicationId: string,
): Promise<SmrtJob | null> {
  const jobs = await collection.list({
    limit: 1,
    orderBy: ['priority DESC', 'run_at ASC'],
    where: {
      method: AUTO_SUBMIT_APPLICATION_METHOD,
      objectId: applicationId,
      objectType: AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
      queue: AUTO_SUBMIT_APPLICATION_QUEUE,
      status: ['pending', 'running'],
    },
  });
  return jobs[0] ?? null;
}

export async function enqueueAutoSubmitApplication(
  applicationId: string,
  args: AutoSubmitApplicationJobArgs = {},
  options: EnqueueAutoSubmitApplicationOptions = {},
): Promise<SmrtJob> {
  // Capture before every read/dedupe return so no unverified caller can learn
  // whether another owner's application already has a queued job.
  const jobArgs = withRuntimeWorkspaceSubject(args);
  const subject = runtimeWorkspaceSubjectFromJobArgs(jobArgs);
  const normalizedApplicationId = applicationId.trim();
  if (!normalizedApplicationId) {
    throw new AutoSubmitApplicationEnqueueError(
      'application_id_required',
      'Application id is required.',
    );
  }
  if (
    !(await getJobPrivateResource(
      'Application',
      normalizedApplicationId,
      subject,
    ))
  ) {
    throw new AutoSubmitApplicationEnqueueError(
      'application_not_found',
      'Application not found.',
    );
  }

  const collection = (options.collection ??
    (await SmrtJobCollection.create({
      ...getSmrtOptions(),
    }))) as AutoSubmitApplicationJobCollection;
  if (!options.collection) await ensureAutoSubmitApplicationJobDedupe();

  const existingJob = await findActiveAutoSubmitJob(
    collection,
    normalizedApplicationId,
  );
  if (existingJob) {
    const existingSubject = runtimeWorkspaceSubjectFromJobArgs(
      existingJob.args,
    );
    if (
      existingSubject.tenantId !== subject.tenantId ||
      existingSubject.userId !== subject.userId ||
      existingSubject.profileId !== subject.profileId
    ) {
      throw new AutoSubmitApplicationEnqueueError(
        'application_not_found',
        'Application not found.',
      );
    }
    return existingJob;
  }

  try {
    const job = await collection.create({
      args: {
        ...jobArgs,
        reason: options.reason ?? args.reason ?? 'manual',
      },
      // One-shot: a submission attempt must never silently re-run. Operators
      // requeue after inspecting the AgentRun.
      maxAttempts: 1,
      method: AUTO_SUBMIT_APPLICATION_METHOD,
      objectId: normalizedApplicationId,
      objectType: AUTO_SUBMIT_APPLICATION_JOB_OBJECT_TYPE,
      priority: 70,
      queue: AUTO_SUBMIT_APPLICATION_QUEUE,
      runAt: options.now ?? new Date(),
      timeout: AUTO_SUBMIT_APPLICATION_TIMEOUT_MS,
    });

    if (!('id' in job) || !job.id) {
      (job as SmrtObject).id = randomUUID();
    }

    await job.save();
    return job as SmrtJob;
  } catch (error) {
    if (isAutoSubmitApplicationActiveJobConflict(error)) {
      const activeJob = await findActiveAutoSubmitJob(
        collection,
        normalizedApplicationId,
      );
      if (activeJob) {
        const existingSubject = runtimeWorkspaceSubjectFromJobArgs(
          activeJob.args,
        );
        if (
          existingSubject.tenantId === subject.tenantId &&
          existingSubject.userId === subject.userId &&
          existingSubject.profileId === subject.profileId
        ) {
          return activeJob;
        }
      }
    }
    throw error;
  }
}

export interface MaybeEnqueueAutoSubmitResult {
  enqueued: boolean;
  code: AutoSubmitEligibility['code'];
}

/**
 * Called right after an application is approved. When auto-submit is active and
 * the application is eligible, transition it to "Pending submission"
 * (`submitting`) and enqueue the worker job. When the feature is off or the
 * application is ineligible this is a no-op, preserving the pre-feature flow
 * (the application stays `approved` with its submit task). Best-effort by
 * design — callers should not let an enqueue failure break approval.
 */
export async function maybeEnqueueAutoSubmitOnApproval(
  application: Record<string, unknown> & { id?: unknown },
  options: {
    subject: WorkspaceSubject;
    user?: { id?: unknown } | null;
  },
): Promise<MaybeEnqueueAutoSubmitResult> {
  const subject = requireWorkspaceSubject(options.subject);
  const config = resolveAutoSubmitConfig();
  if (!autoSubmitFeatureActive(config)) {
    return { enqueued: false, code: 'feature_off' };
  }

  const eligibility = await canAutoSubmit(application, { config, subject });
  // Approved but a required answer is missing: open the answer-collection CTA
  // (awaiting_user + collect task) rather than leaving it silently `approved`.
  if (eligibility.code === 'missing_answers') {
    await routeApplicationToAnswerCollection({
      application,
      questions: eligibility.missingQuestions,
      subject,
    });
    return { enqueued: false, code: eligibility.code };
  }
  if (!eligibility.eligible) {
    return { enqueued: false, code: eligibility.code };
  }

  // Enqueue BEFORE moving to "submitting": if enqueue fails, the application
  // stays `approved` (with its submit task) rather than getting stranded in
  // `submitting` with no job behind it. The job itself also sets `submitting`,
  // so the status write here is just for immediate UX.
  await enqueueAutoSubmitApplication(
    stringValue(application.id),
    { reason: 'approval' },
    {},
  );

  if (
    !(await defaultSetApplicationStatus(application, 'submitting', subject))
  ) {
    return { enqueued: true, code: 'eligible' };
  }

  return { enqueued: true, code: 'eligible' };
}

export async function runAutoSubmitApplicationJob(
  application: Record<string, unknown> & { id?: unknown },
  args: AutoSubmitApplicationJobArgs = {},
  context?: JobExecutionContext,
  dependencies: RunAutoSubmitApplicationJobDependencies = {},
): Promise<AutoSubmitJobResult> {
  const applicationId = stringValue(application.id);
  if (!applicationId) throw new Error('Application id is required.');
  const subject = requireCurrentPrivateWorkspaceSubject();

  const config = dependencies.config ?? resolveAutoSubmitConfig();
  const evaluate = dependencies.evaluate ?? canAutoSubmit;
  const resolveResume = dependencies.resolveResume ?? resolveResumeFilePart;
  const recordAudit = dependencies.recordAudit ?? recordAgentAudit;
  const routeToAnswerCollection =
    dependencies.routeToAnswerCollection ?? routeApplicationToAnswerCollection;
  const setApplicationStatus =
    dependencies.setApplicationStatus ??
    ((candidate: Record<string, unknown>, status: string) =>
      defaultSetApplicationStatus(candidate, status, subject));

  context?.logger?.info?.('Evaluating auto-submit eligibility.', {
    applicationId,
    dryRun: config.dryRun,
    enabled: config.enabled,
    reason: args.reason ?? 'manual',
  });

  const eligibility = await evaluate(application, { config, subject });

  // Missing answers are a collection loop, not a dead end.
  if (eligibility.code === 'missing_answers') {
    await recordAudit({
      application,
      input: { code: eligibility.code, reason: eligibility.reason },
      output: {
        missingQuestions: eligibility.missingQuestions.map((q) => q.id),
        route: 'awaiting_user',
      },
      runType: 'auto_submit_blocked',
      status: 'blocked',
    });
    await routeToAnswerCollection({
      application,
      questions: eligibility.missingQuestions,
      subject,
    });
    return {
      outcome: 'awaiting_user',
      code: eligibility.code,
      reason: eligibility.reason,
    };
  }

  // Idempotent / dormant / unapproved no-ops: never act, never mutate.
  if (
    eligibility.code === 'already_submitted' ||
    eligibility.code === 'feature_off' ||
    eligibility.code === 'not_approved'
  ) {
    return {
      outcome: 'noop',
      code: eligibility.code,
      reason: eligibility.reason,
    };
  }

  // Any other ineligibility falls back to a human (conservative).
  if (!eligibility.eligible) {
    await recordAudit({
      application,
      error: eligibility.reason,
      input: { code: eligibility.code },
      runType: 'auto_submit_blocked',
      status: 'blocked',
    });
    if (
      (await setApplicationStatus(application, 'manual_submission')) === false
    ) {
      return {
        outcome: 'noop',
        code: eligibility.code,
        reason:
          'Application changed before the fallback status could be recorded.',
      };
    }
    return {
      outcome: 'manual_submission',
      code: eligibility.code,
      reason: eligibility.reason,
    };
  }

  // Eligible: build the exact payload.
  const submitter = getAtsSubmitter(eligibility.detectionType);
  const schema = parseAtsFormSchema(application.requiredQuestionsJson);
  if (!submitter || !schema) {
    await recordAudit({
      application,
      error: 'Submitter or schema unavailable at submit time.',
      input: { code: 'unsupported_ats' },
      runType: 'auto_submit_blocked',
      status: 'blocked',
    });
    if (
      (await setApplicationStatus(application, 'manual_submission')) === false
    ) {
      return {
        outcome: 'noop',
        code: 'unsupported_ats',
        reason:
          'Application changed before the fallback status could be recorded.',
      };
    }
    return {
      outcome: 'manual_submission',
      code: 'unsupported_ats',
      reason: 'Submitter or schema unavailable at submit time.',
    };
  }

  const answers = parseRequiredAnswers(application.requiredAnswersJson);
  const resume = await resolveResume(application, subject);
  const approvedResumeDigest = finalApprovalResumePdfDigest(application);
  const approvedResumeFilename = finalApprovalResumePdfFilename(application);
  if (
    !resume.present ||
    !resume.sha256 ||
    !approvedResumeDigest ||
    resume.sha256 !== approvedResumeDigest ||
    !approvedResumeFilename ||
    resume.filename !== approvedResumeFilename
  ) {
    const reason =
      'The selected resume no longer matches the final-approved material snapshot.';
    await recordAudit({
      application,
      error: reason,
      input: { code: 'approval_materials_changed' },
      runType: 'auto_submit_blocked',
      status: 'blocked',
    });
    if (
      (await setApplicationStatus(application, 'manual_submission')) === false
    ) {
      return {
        outcome: 'noop',
        code: 'approval_materials_changed',
        reason:
          'Application changed before the fallback status could be recorded.',
      };
    }
    return {
      outcome: 'manual_submission',
      code: 'approval_materials_changed',
      reason,
    };
  }
  const payload = submitter.buildSubmissionPayload({ schema, answers, resume });

  if (!config.enabled || config.dryRun) {
    // DRY RUN: persist the exact payload for inspection. NEVER POST.
    await recordAudit({
      application,
      input: {
        code: eligibility.code,
        mode: config.enabled ? 'enabled_dry_run' : 'disabled_dry_run',
        // The payload resolves the application-owned resume asset and retains
        // its selected, user-facing filename for the ATS.
        resumeAssetId: stringValue(application.resumeAssetId),
        resumeVariantId: stringValue(application.resumeVariantId),
      },
      output: { payload },
      runType: 'auto_submit_dry_run',
      status: 'dry_run',
    });
    // The audit is the durable record of the exact dry-run payload. Do not
    // alter workflow state if that record could not be persisted.
    if ((await setApplicationStatus(application, 'submitting')) === false) {
      return {
        outcome: 'noop',
        code: eligibility.code,
        reason:
          'Application changed before the dry-run status could be recorded.',
      };
    }
    context?.logger?.info?.('Auto-submit dry-run recorded (no POST).', {
      applicationId,
      endpoint: payload.endpoint,
      fields: payload.fields.length,
    });
    return { outcome: 'dry_run', code: eligibility.code, reason: '' };
  }

  // LIVE: perform the submission. Currently a guarded stub that refuses; the
  // submitted-state recording is finalized when the POST path is certified.
  await recordAudit({
    application,
    input: { code: eligibility.code, mode: 'live_pending' },
    output: { payload },
    runType: 'auto_submit_pending',
    status: 'pending',
  });
  if ((await setApplicationStatus(application, 'submitting')) === false) {
    return {
      outcome: 'noop',
      code: eligibility.code,
      reason: 'Application changed before submission could begin.',
    };
  }
  const result = await submitter.submit(payload);
  await recordAudit({
    application,
    error: result.ok ? '' : result.reason,
    input: { code: eligibility.code, mode: 'live' },
    output: { payload },
    runType: 'auto_submit',
    status: result.ok ? 'completed' : 'failed',
  });
  if (
    (await setApplicationStatus(application, 'manual_submission')) === false
  ) {
    return {
      outcome: 'noop',
      code: eligibility.code,
      reason:
        'Application changed before the submission outcome could be recorded.',
    };
  }
  return {
    outcome: 'manual_submission',
    code: eligibility.code,
    reason: result.ok ? '' : result.reason,
  };
}
