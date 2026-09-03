import { error } from '@sveltejs/kit';
import {
  applicationMaterialsAreLockedOrLeased,
  hasFinalApplicationApproval,
} from '$lib/objects/application-approval-scope';
import {
  applicationStatusDefinitions,
  normalizeApplicationStatus,
} from '$lib/objects/lifecycle';
import { isActiveTaskStatus } from '$lib/objects/workflow';
import { loadApplicationReviewSnapshot } from './application-review.js';
import { isAtsFileQuestion, parseAtsFormSchema } from './ats/index.js';
import {
  parseRequiredAnswers,
  summarizeApplicationFormAnswers,
} from './auto-submit-eligibility.js';
import { getCollection } from './smrt.js';

/**
 * Bounded, read-only application inspection for the WebMCP job-seeker
 * surface (#414).
 *
 * In scope: the material inventory with per-material review state, unresolved
 * review comments, the answers already committed to this application's
 * packet, blocking items with human-readable reasons, approval scope and
 * timestamps, and submission evidence.
 *
 * Deliberately excluded: `CandidateProfile` contact facts, the reusable
 * `CandidateAnswer` library (answers are read from the application record
 * only), employer-account login identity/notes, Warden references, free-form
 * application notes, and material bodies other than the answers rendering.
 */

type Collection = {
  get: (id: string) => Promise<Record<string, unknown> | null>;
  list: (options?: Record<string, unknown>) => Promise<unknown[]>;
};

const MAX_ANSWERS = 60;
const MAX_ANSWER_LENGTH = 1_000;
const MAX_COMMENTS = 25;
const MAX_COMMENT_LENGTH = 1_000;
const MAX_TASKS = 20;
const MAX_BLOCKERS = 40;
const EMPLOYER_ACCOUNT_BLOCKER_STATUSES = new Set([
  'needs_login',
  'needs_signup',
  'needs_2fa',
  'blocked',
]);

export type ApplicationBlockerCode =
  | 'blocked_task'
  | 'employer_account'
  | 'material_needs_attention'
  | 'material_not_reviewed'
  | 'missing_required_answer'
  | 'open_review_comment'
  | 'owner_approval_required';

export interface ApplicationBlocker {
  code: ApplicationBlockerCode;
  message: string;
  materialType?: string;
  questionId?: string;
  taskId?: string;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function limitedText(value: unknown, maximum: number): string {
  const text = stringValue(value);
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function isoTime(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredString(value: unknown, label: string, maxLength: number) {
  const text = stringValue(value);
  if (!text) error(400, `${label} is required.`);
  if (text.length > maxLength) {
    error(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function applicationAdminUrl(id: string): string {
  return `/admin/applications/${encodeURIComponent(id)}/`;
}

function opportunityAdminUrl(id: string): string {
  return `/admin/opportunities/${encodeURIComponent(id)}/`;
}

function statusDescription(status: string): string {
  return (
    applicationStatusDefinitions.find(
      (definition) => definition.value === status,
    )?.description ?? ''
  );
}

function jsonArrayLength(value: unknown): number {
  const raw = stringValue(value);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Per-question answers committed to this application's packet only. */
export function committedApplicationAnswers(
  application: Record<string, unknown>,
) {
  const schema = parseAtsFormSchema(application.requiredQuestionsJson);
  if (!schema) {
    return { ats: '', hasSchema: false, questions: [], truncated: false };
  }
  const answers = parseRequiredAnswers(application.requiredAnswersJson);
  const scalar = schema.questions.filter(
    (question) => !isAtsFileQuestion(schema.ats, question.type),
  );
  return {
    ats: stringValue(schema.ats),
    hasSchema: true,
    questions: scalar.slice(0, MAX_ANSWERS).map((question) => {
      const answer = stringValue(answers[question.id]);
      return {
        id: stringValue(question.id),
        label: limitedText(question.label, 300),
        required: Boolean(question.required),
        answered: Boolean(answer),
        answer: limitedText(answer, MAX_ANSWER_LENGTH),
      };
    }),
    truncated: scalar.length > MAX_ANSWERS,
  };
}

export function applicationBlockers(options: {
  application: Record<string, unknown>;
  comments: Record<string, unknown>[];
  materials: Array<{
    availability: string;
    label: string;
    materialType: string;
    notice: string;
    reviewStatus: string;
  }>;
  tasks: Record<string, unknown>[];
}): ApplicationBlocker[] {
  const { application, comments, materials, tasks } = options;
  const status = normalizeApplicationStatus(application.status);
  const blockers: ApplicationBlocker[] = [];

  for (const question of summarizeApplicationFormAnswers(application)
    .missingRequiredAnswers) {
    blockers.push({
      code: 'missing_required_answer',
      message: `Required application question "${limitedText(question.label, 200)}" has no committed answer.`,
      questionId: stringValue(question.id),
    });
  }

  for (const material of materials) {
    if (material.availability === 'needs_attention') {
      blockers.push({
        code: 'material_needs_attention',
        materialType: material.materialType,
        message:
          material.notice ||
          `${material.label} has no reviewable artifact selected.`,
      });
    }
  }

  for (const comment of comments) {
    if (stringValue(comment.status) !== 'open' || comment.resolvedAt) continue;
    const body = limitedText(comment.body, 200);
    blockers.push({
      code: 'open_review_comment',
      materialType: stringValue(comment.materialType),
      message: body
        ? `Revision requested on ${stringValue(comment.materialType) || 'a material'}: ${body}`
        : `Revision requested on ${stringValue(comment.materialType) || 'a material'}.`,
    });
  }

  for (const task of tasks) {
    if (stringValue(task.status) !== 'blocked') continue;
    const reason = limitedText(task.blockerReason, 500);
    blockers.push({
      code: 'blocked_task',
      message: reason
        ? `Task "${limitedText(task.title, 120)}" is blocked: ${reason}`
        : `Task "${limitedText(task.title, 120)}" is blocked.`,
      taskId: stringValue(task.id),
    });
  }

  const accountStatus = stringValue(application.accountStatus);
  if (EMPLOYER_ACCOUNT_BLOCKER_STATUSES.has(accountStatus)) {
    blockers.push({
      code: 'employer_account',
      message: `The employer account status is "${accountStatus}"; the owner must resolve it in the admin UI before submission.`,
    });
  }

  if (status === 'awaiting_user') {
    for (const material of materials) {
      if (
        material.availability === 'ready' &&
        material.reviewStatus !== 'reviewed'
      ) {
        blockers.push({
          code: 'material_not_reviewed',
          materialType: material.materialType,
          message: `${material.label} has not been marked reviewed at its current version.`,
        });
      }
    }
    if (!hasFinalApplicationApproval(application)) {
      blockers.push({
        code: 'owner_approval_required',
        message:
          'The owner has not recorded final approval for external submission. Approval is granted only in the admin review UI, never through this tool.',
      });
    }
  }

  return blockers.slice(0, MAX_BLOCKERS);
}

function awaitingSummary(
  status: string,
  blockers: readonly ApplicationBlocker[],
): string {
  if (status !== 'awaiting_user') return '';
  if (blockers.length === 0) {
    return 'The application is awaiting the owner, but no specific blocking item is recorded; open the admin review UI.';
  }
  return blockers.map((blocker) => blocker.message).join(' ');
}

export async function inspectJobApplication(input: Record<string, unknown>) {
  const applicationId = requiredString(
    input.applicationId,
    'Application id',
    128,
  );
  const snapshot = await loadApplicationReviewSnapshot(applicationId);
  if (!snapshot) error(404, 'Application not found.');
  const { application, comments, materials } = snapshot;
  const status = normalizeApplicationStatus(application.status);
  const opportunityId = stringValue(application.opportunityId);

  const [opportunity, taskRecords] = await Promise.all([
    opportunityId
      ? ((await getCollection('Opportunity')) as unknown as Collection).get(
          opportunityId,
        )
      : Promise.resolve(null),
    ((await getCollection('Task')) as unknown as Collection).list({
      limit: 100,
      orderBy: 'updated_at DESC',
      where: { applicationId },
    }),
  ]);
  const tasks = (taskRecords as Record<string, unknown>[])
    .map((task) => JSON.parse(JSON.stringify(task)) as Record<string, unknown>)
    .filter((task) => isActiveTaskStatus(task.status));
  const openComments = comments.filter(
    (comment) => stringValue(comment.status) === 'open' && !comment.resolvedAt,
  );
  const blockers = applicationBlockers({
    application,
    comments,
    materials,
    tasks,
  });
  const submittedAt = isoTime(application.submittedAt);

  return {
    application: {
      id: applicationId,
      opportunityId,
      status,
      statusDescription: statusDescription(status),
      applyMethod: stringValue(application.applyMethod),
      applicationUrl: stringValue(application.applicationUrl),
      resolvedApplyUrl: stringValue(application.resolvedApplyUrl),
      resumeMode: stringValue(application.resumeMode),
      coverLetterMode: stringValue(application.coverLetterMode),
      dueAt: isoTime(application.dueAt),
      instructions: limitedText(application.applicationInstructions, 2000),
      requiredAnswersSummary: limitedText(application.requiredAnswers, 4000),
      materialsLocked: applicationMaterialsAreLockedOrLeased(
        status,
        application,
      ),
      adminUrl: applicationAdminUrl(applicationId),
      reviewUrl: `${applicationAdminUrl(applicationId)}review`,
    },
    opportunity: opportunity
      ? {
          id: stringValue(opportunity.id),
          title: limitedText(opportunity.title, 300),
          status: stringValue(opportunity.status),
          adminUrl: opportunityAdminUrl(stringValue(opportunity.id)),
        }
      : null,
    materials: materials.map((material) => ({
      type: material.materialType,
      label: material.label,
      title: limitedText(material.title, 300),
      availability: material.availability,
      reviewStatus: material.reviewStatus,
      notice: material.notice,
      recordType: material.materialRecordType,
      recordId: material.materialRecordId,
      pdfAvailable: Boolean(material.pdfPath),
      openCommentCount: openComments.filter(
        (comment) =>
          stringValue(comment.materialType) === material.materialType,
      ).length,
      adminUrl: material.href,
    })),
    answers: committedApplicationAnswers(application),
    comments: {
      unresolved: openComments.slice(0, MAX_COMMENTS).map((comment) => ({
        id: stringValue(comment.id),
        materialType: stringValue(comment.materialType),
        body: limitedText(comment.body, MAX_COMMENT_LENGTH),
        updatedAt: isoTime(comment.updated_at ?? comment.updatedAt),
      })),
      unresolvedTotal: openComments.length,
    },
    tasks: tasks.slice(0, MAX_TASKS).map((task) => ({
      id: stringValue(task.id),
      taskType: stringValue(task.taskType),
      status: stringValue(task.status),
      title: limitedText(task.title, 200),
      assigneeRole: stringValue(task.assigneeRole),
      blockerReason: limitedText(task.blockerReason, 500),
      dueAt: isoTime(task.dueAt),
    })),
    blockers,
    awaiting: awaitingSummary(status, blockers),
    approval: {
      recorded: Boolean(
        isoTime(application.approvedAt) ||
          stringValue(application.approvalScope),
      ),
      scope: limitedText(application.approvalScope, 2000),
      notes: limitedText(application.approvalNotes, 2000),
      approvedAt: isoTime(application.approvedAt),
      final: {
        recorded: hasFinalApplicationApproval(application),
        kind: stringValue(application.finalApprovalKind),
        approvedAt: isoTime(application.finalApprovalAt),
        materialCount: jsonArrayLength(application.finalApprovalMaterialsJson),
        materialsCurrent: snapshot.finalApprovalMaterialsCurrent,
      },
    },
    submission: submittedAt
      ? {
          submittedAt,
          method: stringValue(application.submissionMethod),
          byRole: stringValue(application.submittedByRole),
          evidenceUrl: stringValue(application.submissionEvidenceUrl),
          notes: limitedText(application.submissionNotes, 2000),
        }
      : null,
    excluded: [
      'candidateProfile',
      'candidateAnswerLibrary',
      'accountLoginIdentity',
      'accountNotes',
      'wardenReference',
      'notes',
      'materialBodies',
    ],
  };
}
