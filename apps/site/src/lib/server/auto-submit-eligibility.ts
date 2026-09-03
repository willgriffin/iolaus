// `canAutoSubmit` — the conservative eligibility predicate for ATS auto-submit.
//
// All six conditions from docs/auto-submit-design.md must hold. When unsure we
// fall back (return ineligible) rather than guess. The returned `code` lets the
// caller route the outcome (missing answers -> collect CTA; everything else ->
// pending/manual). This module performs no submission and never fabricates
// answers.

import {
  applicationHasMaterialWriteLock,
  hasFinalApplicationApproval,
} from '../objects/application-approval-scope.js';
import { applicationResumePdfExists } from './application-resume-file.js';
import {
  getAtsSubmitter,
  isAtsFileQuestion,
  parseAtsFormSchema,
} from './ats/index.js';
import type { AtsFormQuestion, AtsFormSchema } from './ats/types.js';
import {
  type AutoSubmitConfig,
  autoSubmitFeatureActive,
  resolveAutoSubmitConfig,
} from './auto-submit-config.js';

const ACCOUNT_OK_STATUSES = new Set(['none_needed', 'active', 'logged_in']);
const ALREADY_SUBMITTED_STATUSES = new Set([
  'submitted',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
  'archived',
]);

/**
 * True once an application has been submitted (or moved past submission). Used
 * to gate both auto-submit eligibility and answer collection — answers must not
 * be mutated after the application has already gone out.
 */
export function isApplicationPastSubmission(
  application: Record<string, unknown>,
): boolean {
  const status =
    typeof application.status === 'string' ? application.status.trim() : '';
  return (
    ALREADY_SUBMITTED_STATUSES.has(status) || Boolean(application.submittedAt)
  );
}

export type AutoSubmitEligibilityCode =
  | 'eligible'
  | 'feature_off'
  | 'already_submitted'
  | 'not_approved'
  | 'approval_materials_changed'
  | 'unsupported_ats'
  | 'account_required'
  | 'resume_missing'
  | 'schema_missing'
  | 'missing_answers';

export interface AutoSubmitEligibility {
  eligible: boolean;
  code: AutoSubmitEligibilityCode;
  reason: string;
  detectionType: string;
  missingQuestions: AtsFormQuestion[];
}

export interface CanAutoSubmitOptions {
  config?: AutoSubmitConfig;
  /** Injected ATS detection; defaults to `detectJobBoard`. */
  detect?: (url: string) => Promise<{ type?: unknown } | null>;
  /** Injected application-resume presence check; defaults to its selected PDF. */
  resumeExists?: (application: Record<string, unknown>) => Promise<boolean>;
  /**
   * Verifies that the current material fingerprints still equal the snapshot
   * taken by final approval. The production default loads the application
   * review materials; tests may supply a deterministic substitute.
   */
  approvalMaterialsCurrent?: (
    application: Record<string, unknown>,
  ) => Promise<boolean>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The apply URL auto-submit should act on. Prefers `resolvedApplyUrl` (the
 * canonical ATS URL resolved from an aggregator like Indeed during packet
 * generation), then the application's own `applicationUrl`, then the
 * opportunity-derived `applyUrl`.
 */
export function effectiveApplyUrl(
  application: Record<string, unknown>,
): string {
  return (
    stringValue(application.resolvedApplyUrl) ||
    stringValue(application.applicationUrl) ||
    stringValue(application.applyUrl)
  );
}

export function parseRequiredAnswers(value: unknown): Record<string, string> {
  const raw = stringValue(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry === 'string') result[key] = entry.trim();
      else if (typeof entry === 'number' || typeof entry === 'boolean') {
        result[key] = String(entry);
      } else result[key] = '';
    }
    return result;
  } catch {
    return {};
  }
}

export interface AutoSubmitReviewSummary {
  /** ATS name from the persisted schema, '' when none fetched. */
  ats: string;
  hasSchema: boolean;
  requiredQuestions: { id: string; label: string; answered: boolean }[];
  missingRequiredAnswers: AtsFormQuestion[];
}

/**
 * Pure summary of the persisted ATS form schema vs. the stored answers, for
 * surfacing required questions and any gaps during review (before approval) —
 * no network, no submission.
 */
export function summarizeApplicationFormAnswers(
  application: Record<string, unknown>,
): AutoSubmitReviewSummary {
  const schema = parseAtsFormSchema(application.requiredQuestionsJson);
  if (!schema) {
    return {
      ats: '',
      hasSchema: false,
      requiredQuestions: [],
      missingRequiredAnswers: [],
    };
  }
  const answers = parseRequiredAnswers(application.requiredAnswersJson);
  const requiredQuestions = schema.questions
    .filter(
      (question) =>
        question.required && !isAtsFileQuestion(schema.ats, question.type),
    )
    .map((question) => ({
      id: question.id,
      label: question.label,
      answered: Boolean(stringValue(answers[question.id])),
    }));
  return {
    ats: stringValue(schema.ats),
    hasSchema: true,
    requiredQuestions,
    missingRequiredAnswers: findMissingRequiredAnswers(schema, answers),
  };
}

/**
 * Required scalar questions with no answer. File questions (e.g. the resume)
 * are excluded — those are satisfied by the resume-artifact check, not by a
 * typed answer.
 */
export function findMissingRequiredAnswers(
  schema: AtsFormSchema,
  answers: Record<string, string>,
): AtsFormQuestion[] {
  return schema.questions.filter(
    (question) =>
      question.required &&
      !isAtsFileQuestion(schema.ats, question.type) &&
      !stringValue(answers[question.id]),
  );
}

async function defaultDetect(url: string): Promise<{ type?: unknown } | null> {
  const { detectJobBoard } = await import('./opportunity-source-crawler.js');
  return await detectJobBoard(url);
}

async function defaultApprovalMaterialsCurrent(
  application: Record<string, unknown>,
): Promise<boolean> {
  const applicationId = stringValue(application.id);
  if (!applicationId) return false;
  try {
    const { finalApplicationApprovalMaterialsAreCurrent } = await import(
      './application-review.js'
    );
    return await finalApplicationApprovalMaterialsAreCurrent(applicationId);
  } catch {
    return false;
  }
}

function ineligible(
  code: AutoSubmitEligibilityCode,
  reason: string,
  detectionType = '',
  missingQuestions: AtsFormQuestion[] = [],
): AutoSubmitEligibility {
  return { eligible: false, code, reason, detectionType, missingQuestions };
}

export async function canAutoSubmit(
  application: Record<string, unknown>,
  options: CanAutoSubmitOptions = {},
): Promise<AutoSubmitEligibility> {
  const config = options.config ?? resolveAutoSubmitConfig();
  if (!autoSubmitFeatureActive(config)) {
    return ineligible('feature_off', 'Auto-submit feature flag is off.');
  }

  if (isApplicationPastSubmission(application)) {
    return ineligible(
      'already_submitted',
      'Application is already submitted or past submission.',
    );
  }

  if (applicationHasMaterialWriteLock(application)) {
    return ineligible(
      'approval_materials_changed',
      'Application materials are being updated and require review before submission.',
    );
  }

  // Auto-submit changes who executes, never whether the application was
  // authorized. Human-readable scope text and material reviews are never
  // sufficient: only an explicit final application approval can pass here.
  if (!hasFinalApplicationApproval(application)) {
    return ineligible(
      'not_approved',
      'Application has no final submission approval.',
    );
  }

  const approvalMaterialsCurrent =
    options.approvalMaterialsCurrent ?? defaultApprovalMaterialsCurrent;
  if (!(await approvalMaterialsCurrent(application))) {
    return ineligible(
      'approval_materials_changed',
      'Application materials changed or could not be verified after final approval.',
    );
  }

  const applyUrl = effectiveApplyUrl(application);
  const detect = options.detect ?? defaultDetect;
  const detection = applyUrl ? await detect(applyUrl).catch(() => null) : null;
  const detectionType = stringValue(detection?.type);
  const submitter = getAtsSubmitter(detectionType);
  if (!submitter) {
    return ineligible(
      'unsupported_ats',
      detectionType
        ? `ATS "${detectionType}" is not supported for auto-submit.`
        : 'No supported ATS detected for the application URL.',
      detectionType,
    );
  }

  const accountStatus = stringValue(application.accountStatus) || 'unknown';
  if (!ACCOUNT_OK_STATUSES.has(accountStatus)) {
    return ineligible(
      'account_required',
      `Account status "${accountStatus}" requires manual handling.`,
      detectionType,
    );
  }

  const resumeExists = options.resumeExists ?? applicationResumePdfExists;
  if (!(await resumeExists(application))) {
    return ineligible(
      'resume_missing',
      'No resume artifact is available to attach.',
      detectionType,
    );
  }

  const schema = parseAtsFormSchema(application.requiredQuestionsJson);
  if (!schema) {
    return ineligible(
      'schema_missing',
      'No application form schema has been fetched yet.',
      detectionType,
    );
  }
  // Guard against a stale schema left over from a previous ATS/URL: the persisted
  // schema must belong to the currently-detected ATS, else re-fetch is required.
  if (!submitter.supports(stringValue(schema.ats))) {
    return ineligible(
      'schema_missing',
      `Persisted form schema ("${stringValue(
        schema.ats,
      )}") does not match the detected ATS ("${detectionType}").`,
      detectionType,
    );
  }
  // …and it must belong to the same job as the current apply URL (board/job id),
  // so a URL change without a schema re-fetch can never build a payload for the
  // wrong job.
  if (!submitter.matchesUrl(schema, applyUrl)) {
    return ineligible(
      'schema_missing',
      'Persisted form schema does not match the current application URL.',
      detectionType,
    );
  }

  const answers = parseRequiredAnswers(application.requiredAnswersJson);
  const missingQuestions = findMissingRequiredAnswers(schema, answers);
  if (missingQuestions.length > 0) {
    return ineligible(
      'missing_answers',
      `Missing ${missingQuestions.length} required answer(s).`,
      detectionType,
      missingQuestions,
    );
  }

  return {
    eligible: true,
    code: 'eligible',
    reason: '',
    detectionType,
    missingQuestions: [],
  };
}
