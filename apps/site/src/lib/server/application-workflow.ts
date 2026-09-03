import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase, type User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import {
  applicationApprovalScopeChanged,
  applicationApprovalShouldInvalidate,
  applicationMaterialsAreLockedOrLeased,
  clearApplicationApprovalFields,
  hasFinalApplicationApproval,
} from '../objects/application-approval-scope.js';
import {
  normalizeApplicationStatus,
  toApplicationStatus,
  validateApplicationStatusTransition,
} from '../objects/lifecycle.js';
import {
  accountStatuses,
  activeTaskStatuses,
  isActiveTaskStatus,
  recommendationDecisions,
  submissionMethods,
  submittedByRoles,
} from '../objects/workflow.js';
import { commitApplicationIfCurrent } from './application-concurrency.js';
import { isAtsFileQuestion, parseAtsFormSchema } from './ats/index.js';
import {
  isApplicationPastSubmission,
  parseRequiredAnswers,
  summarizeApplicationFormAnswers,
} from './auto-submit-eligibility.js';
import {
  normalizeAnswerLabel,
  resolveLibraryProfileKey,
  reusableAnswerLabelKey,
} from './candidate-answers.js';
import { bumpTaskChangeFeed } from './change-feed.js';
import { getDbConfig } from './db.js';
import { getCollection } from './smrt.js';
import {
  KeyedLockTimeoutError,
  withSqliteOperationLock,
} from './sqlite-operation-lock.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};
type Collection = {
  create: (payload: Record<string, unknown>) => Promise<MutableRecord>;
  get: (id: string) => Promise<MutableRecord | null>;
  list: (options?: Record<string, unknown>) => Promise<MutableRecord[]>;
};
type ResolvedDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type OpportunityLifecycleSession = Awaited<
  ReturnType<NonNullable<ResolvedDatabase['acquireSession']>>
>;

const lifecycleDatabase = new AsyncLocalStorage<ResolvedDatabase>();
const lifecycleLock = new AsyncLocalStorage<OpportunityLifecycleSession>();
const lifecycleDatabaseProxy = new Proxy({} as ResolvedDatabase, {
  get(_target, property) {
    const database = lifecycleDatabase.getStore();
    if (!database) {
      throw new Error('Lifecycle database accessed outside its transaction.');
    }
    const value = Reflect.get(database, property, database);
    return typeof value === 'function' ? value.bind(database) : value;
  },
  getOwnPropertyDescriptor(_target, property) {
    const database = lifecycleDatabase.getStore();
    if (!database) return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(database, property);
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
  has(_target, property) {
    const database = lifecycleDatabase.getStore();
    return database ? Reflect.has(database, property) : false;
  },
  ownKeys() {
    return Reflect.ownKeys(lifecycleDatabase.getStore() ?? {});
  },
});

const accountBlockerStatuses = new Set([
  'needs_login',
  'needs_signup',
  'needs_2fa',
  'blocked',
]);
const ownerOwnedAccountStatuses = new Set([
  'needs_signup',
  'needs_2fa',
  'blocked',
]);
const postSubmissionFollowUpDays = 7;
const portalCheckDays = 3;
const terminalApplicationStatuses = new Set([
  'archived',
  'rejected',
  'withdrawn',
]);
// A verified-closed posting ends work that has not reached a recorded
// submission. Preserve submitted, interview, and offer history; those are no
// longer application-preparation work and must retain their external evidence.
const postingClosureArchiveableApplicationStatuses = new Set([
  'application_drafting',
  'approved',
  'awaiting_user',
  'draft',
  'manual_submission',
  'submitting',
]);
const managedApplicationTaskTypes = new Set([
  'approve_application',
  'check_status',
  'collect_application_answers',
  'follow_up',
  'interview_prep',
  'prepare_application_packet',
  'submit_application',
]);
const applicationTaskStage: Record<string, number> = {
  approve_application: 2,
  check_status: 4,
  collect_application_answers: 2,
  follow_up: 4,
  interview_prep: 5,
  prepare_application_packet: 1,
  submit_application: 3,
};
const applicationStatusStage: Record<string, number> = {
  application_drafting: 1,
  approved: 3,
  archived: 0,
  awaiting_user: 2,
  draft: 1,
  interviewing: 5,
  manual_submission: 3,
  offer: 6,
  rejected: 0,
  submitted: 4,
  submitting: 3,
  withdrawn: 0,
};
const activeApplicationTaskTypesByStatus: Record<string, readonly string[]> = {
  application_drafting: ['prepare_application_packet'],
  approved: ['submit_application'],
  awaiting_user: ['approve_application', 'collect_application_answers'],
  draft: ['prepare_application_packet'],
  interviewing: ['interview_prep'],
  manual_submission: ['submit_application'],
  submitted: ['follow_up', 'check_status'],
  submitting: ['submit_application'],
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function assertOpportunityIsOpenForApplicationWork(
  opportunity: Record<string, unknown>,
): void {
  if (stringValue(opportunity.status) === 'archived') {
    error(
      409,
      'This posting is closed and has been archived. Application work cannot continue.',
    );
  }
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function requireKnownValue(
  value: string,
  allowed: readonly string[],
  message: string,
): string {
  if (!allowed.includes(value)) {
    error(400, message);
  }
  return value;
}

export function normalizeAccountStatus(value: unknown): string {
  return requireKnownValue(
    stringValue(value) || 'unknown',
    accountStatuses,
    'Invalid account status.',
  );
}

function titleForOpportunity(opportunity: Record<string, unknown>): string {
  return (
    stringValue(opportunity.title) ||
    stringValue(opportunity.id) ||
    'Untitled opportunity'
  );
}

function activeTask(records: MutableRecord[]): MutableRecord | null {
  return records.find((record) => isActiveTaskStatus(record.status)) ?? null;
}

function payloadValue(
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: string,
): unknown {
  return Object.hasOwn(payload, key) ? payload[key] : current[key];
}

async function collection(className: string): Promise<Collection> {
  return (await getCollection(className, {
    db: lifecycleDatabase.getStore() ? lifecycleDatabaseProxy : undefined,
  })) as unknown as Collection;
}

async function findTaskByExternalId(externalTaskId: string, activeOnly = true) {
  const tasks = await collection('Task');
  const records = await tasks.list({
    limit: 25,
    orderBy: 'updated_at DESC',
    where: { externalTaskId },
  });
  return activeOnly ? activeTask(records) : (records[0] ?? null);
}

async function createTaskIfMissing(
  externalTaskId: string,
  payload: Record<string, unknown>,
): Promise<{ created: boolean; task: MutableRecord }> {
  const existing = await findTaskByExternalId(externalTaskId);
  if (existing) {
    return { created: false, task: existing };
  }

  const tasks = await collection('Task');
  const task = await tasks.create({
    assigneeRole: 'owner',
    createdBy: 'automation',
    externalTaskId,
    kanbanColumn: 'inbox',
    status: 'open',
    taskType: 'other',
    ...payload,
  });
  await task.save();
  return { created: true, task };
}

async function hasActiveApplicationTaskOfType(
  applicationId: string,
  taskType: string,
): Promise<boolean> {
  const tasks = await collection('Task');
  const records = await tasks.list({
    limit: 200,
    orderBy: 'updated_at DESC',
    where: { applicationId },
  });
  return records.some(
    (task) =>
      stringValue(task.taskType) === taskType &&
      isActiveTaskStatus(task.status),
  );
}

/**
 * Route an application back to the user to collect missing required ATS answers
 * (the answer-collection CTA). Used by the auto-submit flow when a required
 * question has no answer — this is a collection loop, not a dead end, so it does
 * NOT clear approval or move to manual_submission. See
 * docs/auto-submit-design.md.
 */
export async function routeApplicationToAnswerCollection(options: {
  application: Record<string, unknown>;
  questions: { id: string; label: string }[];
}): Promise<{ created: boolean }> {
  const application = options.application;
  const applicationId = stringValue(application.id);
  if (!applicationId) return { created: false };
  const opportunityId = stringValue(application.opportunityId);

  // This can be called by a queued auto-submit job. Do not let a stale job
  // overwrite a concurrent material invalidation, final approval, or manual
  // submission while routing answers back to the owner.
  if (
    !(await commitApplicationIfCurrent(application, {
      status: 'awaiting_user',
    }))
  ) {
    return { created: false };
  }

  const questionLines = options.questions
    .map((question) => `- ${question.label || question.id} (${question.id})`)
    .join('\n');
  const result = await createTaskIfMissing(
    `collect-application-answers:${applicationId}`,
    {
      applicationId,
      assigneeRole: 'owner',
      createdBy: 'automation',
      description: [
        'Provide the missing required application answers so submission can proceed.',
        'Do not invent answers — supply real values only.',
        questionLines ? `Unanswered questions:\n${questionLines}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      kanbanColumn: 'ready_for_user_review',
      opportunityId,
      taskType: 'collect_application_answers',
      title: `Collect application answers: ${applicationId}`,
    },
  );

  await syncApplicationWorkflowTasks(application);
  return { created: result.created };
}

/**
 * Close the answer-collection loop: persist user-supplied answers to the ATS
 * form questions and, once every required question is answered, mark the
 * `collect_application_answers` CTA done. Safety: only accepts answers for
 * questions in the persisted schema and never synthesizes a value. The review
 * editor prefills each field with the stored answer, so a submitted blank is
 * a deliberate clearing of that answer (absent fields are ignored) — clearing
 * is a material change and re-triggers approval like any other edit. The form
 * field convention is `answer:<questionId>`; an optional
 * `reuse:<questionId>` checkbox additionally saves that answer to the private
 * reusable candidate answer library so future compatible applications can be
 * seeded with it (never retroactively — existing applications keep their own
 * answer copies), and `unreuse:<questionId>` withdraws that label's reusable
 * copy so reuse consent stays revocable. When both are ticked for one
 * question, the explicit reuse save wins.
 */
export async function recordApplicationFormAnswers(
  applicationId: string,
  request: Request,
): Promise<{
  saved: number;
  complete: boolean;
  savedForReuse: number;
  revokedForReuse: number;
}> {
  const form = await request.formData();
  const applications = await collection('Application');
  const application = await applications.get(applicationId);
  if (!application) {
    error(404, 'Application not found.');
  }

  // Answers feed the outgoing submission; once the application has gone out
  // there is nothing left to collect and mutating stored answers would only
  // desync the record from what was actually sent.
  if (isApplicationPastSubmission(application)) {
    error(409, 'This application has already been submitted.');
  }
  if (applicationMaterialsAreLockedOrLeased(application.status, application)) {
    error(
      409,
      'Application materials are locked while submission is in progress.',
    );
  }

  const schema = parseAtsFormSchema(application.requiredQuestionsJson);
  if (!schema) {
    error(400, 'This application has no fetched form questions to answer.');
  }
  // File questions (e.g. the resume upload) are satisfied by the resume
  // artifact, never by a typed answer — exclude them so a stray text value
  // can't be written against a file field. Mirrors findMissingRequiredAnswers.
  const schemaQuestions = schema.questions.filter(
    (q) => !isAtsFileQuestion(schema.ats, q.type),
  );
  const knownQuestionIds = new Set(schemaQuestions.map((q) => q.id));

  const answers = parseRequiredAnswers(application.requiredAnswersJson);
  const submittedValues = new Map<string, string>();
  let saved = 0;
  for (const [field, raw] of form.entries()) {
    if (!field.startsWith('answer:')) continue;
    const questionId = field.slice('answer:'.length);
    if (!knownQuestionIds.has(questionId)) continue;
    const value = stringValue(raw);
    submittedValues.set(questionId, value);
    // The review editor prefills every field with the stored answer, so a
    // blank submission is a deliberate clearing of that answer — never a
    // silent keep. That matters most for seeded contact data: clearing a
    // phone number must actually remove it (and re-trigger approval).
    if (!value) {
      if (questionId in answers) {
        delete answers[questionId];
        saved += 1;
      }
      continue;
    }
    if (answers[questionId] !== value) {
      answers[questionId] = value;
      saved += 1;
    }
  }

  // Reuse only applies to questions that end up with a known, non-empty
  // answer (newly submitted or already stored) — never a blank value.
  const reuseQuestionIds = new Set<string>();
  for (const [field] of form.entries()) {
    if (!field.startsWith('reuse:')) continue;
    const questionId = field.slice('reuse:'.length);
    if (
      knownQuestionIds.has(questionId) &&
      stringValue(submittedValues.get(questionId) || answers[questionId])
    ) {
      reuseQuestionIds.add(questionId);
    }
  }

  // Revocation: an `unreuse:<questionId>` field withdraws that question's
  // reusable copy from the library, so reuse consent stays revocable even
  // though the library has no generic CRUD surface.
  const unreuseQuestionIds = new Set<string>();
  for (const [field] of form.entries()) {
    if (!field.startsWith('unreuse:')) continue;
    const questionId = field.slice('unreuse:'.length);
    if (knownQuestionIds.has(questionId)) unreuseQuestionIds.add(questionId);
  }

  if (saved > 0) {
    const updates: Record<string, unknown> = {
      requiredAnswersJson: JSON.stringify(answers),
    };
    if (applicationApprovalShouldInvalidate(application.status)) {
      updates.status = 'awaiting_user';
      clearApplicationApprovalFields(updates);
    }
    if (!(await commitApplicationIfCurrent(application, updates))) {
      error(
        409,
        'Application changed before answers could be saved. Reload and review the current application.',
      );
    }
  }

  // Sequential on purpose: a question ticked for both save-and-revoke is
  // ambiguous, so the explicit reuse save wins and the revoke is skipped.
  const savedForReuse = await saveReusableCandidateAnswers({
    answers,
    questionsById: schemaQuestions,
    reuseQuestionIds,
  });
  const revokedForReuse = await revokeReusableCandidateAnswers({
    questionsById: schemaQuestions,
    unreuseQuestionIds: new Set(
      [...unreuseQuestionIds].filter((id) => !reuseQuestionIds.has(id)),
    ),
  });

  const summary = summarizeApplicationFormAnswers(jsonRecord(application));
  const complete = summary.missingRequiredAnswers.length === 0;
  if (complete) {
    const task = await findTaskByExternalId(
      `collect-application-answers:${applicationId}`,
    );
    if (task) await markTaskDone(task, new Date());
  }
  await syncApplicationWorkflowTasks(application);
  return { complete, saved, savedForReuse, revokedForReuse };
}

/**
 * Upsert the reuse-marked answers into the private CandidateAnswer library
 * keyed by normalized question label. This is a profile-library write only:
 * it never touches any application record, so other applications keep their
 * own immutable answer copies. Duplicate rows (from concurrent saves) are
 * healed on the next save of the same label: the newest copy stays active and
 * older duplicates are deactivated.
 */
async function saveReusableCandidateAnswers(options: {
  answers: Record<string, string>;
  questionsById: { id: string; label: string }[];
  reuseQuestionIds: Set<string>;
}): Promise<number> {
  if (options.reuseQuestionIds.size === 0) return 0;
  const labelById = new Map(
    options.questionsById.map((question) => [question.id, question.label]),
  );
  const library = await collection('CandidateAnswer');
  // Library rows scope to the same profile whose facts seed applications, so
  // identity facts and reusable answers can never come from two profiles.
  const profileKey = await resolveLibraryProfileKey();
  let savedForReuse = 0;
  for (const questionId of options.reuseQuestionIds) {
    const value = stringValue(options.answers[questionId]);
    if (!value) continue;
    const label = stringValue(labelById.get(questionId)) || questionId;
    const labelKey = normalizeAnswerLabel(label);
    if (!labelKey) continue;
    const existing = await library.list({
      limit: 500,
      orderBy: 'updated_at DESC',
      where: { profileKey },
    });
    const matching = existing.filter(
      (record) => reusableAnswerLabelKey(record) === labelKey,
    );
    if (matching[0]) {
      if (
        stringValue(matching[0].value) !== value ||
        stringValue(matching[0].label) !== label ||
        stringValue(matching[0].labelKey) !== labelKey ||
        matching[0].active === false
      ) {
        matching[0].active = true;
        matching[0].label = label;
        matching[0].labelKey = labelKey;
        matching[0].value = value;
        await matching[0].save();
      }
    } else {
      const record = await library.create({
        active: true,
        label,
        labelKey,
        profileKey,
        value,
      });
      await record.save();
      matching.unshift(record);
    }
    // Self-heal concurrent-save duplicates: only the canonical (newest) row
    // stays active for this label.
    for (const duplicate of matching.slice(1)) {
      if (duplicate.active === false) continue;
      duplicate.active = false;
      await duplicate.save();
    }
    savedForReuse += 1;
  }
  return savedForReuse;
}

/**
 * Deactivate the reusable library copies for the unreuse-marked questions so
 * they stop seeding future applications. History is retained (soft revoke).
 */
async function revokeReusableCandidateAnswers(options: {
  questionsById: { id: string; label: string }[];
  unreuseQuestionIds: Set<string>;
}): Promise<number> {
  if (options.unreuseQuestionIds.size === 0) return 0;
  const labelById = new Map(
    options.questionsById.map((question) => [question.id, question.label]),
  );
  const library = await collection('CandidateAnswer');
  const profileKey = await resolveLibraryProfileKey();
  let revoked = 0;
  for (const questionId of options.unreuseQuestionIds) {
    const label = stringValue(labelById.get(questionId)) || questionId;
    const labelKey = normalizeAnswerLabel(label);
    if (!labelKey) continue;
    revoked += await deactivateReusableRows(library, { profileKey, labelKey });
  }
  return revoked;
}

async function deactivateReusableRows(
  library: Collection,
  key: { profileKey: string; labelKey: string },
): Promise<number> {
  const existing = await library.list({
    limit: 500,
    orderBy: 'updated_at DESC',
    where: { profileKey: key.profileKey },
  });
  let revoked = 0;
  for (const record of existing) {
    if (reusableAnswerLabelKey(record) !== key.labelKey) continue;
    if (record.active === false) continue;
    record.active = false;
    await record.save();
    revoked += 1;
  }
  return revoked;
}

/**
 * Standalone, application-independent revocation for the reusable answer
 * library. Unlike answer recording, this deliberately has no application
 * status gate: withdrawing reuse consent is a profile-library decision and
 * must stay possible even when every matching application is submitted or
 * locked. The caller (an authenticated admin route) supplies the application
 * only for context; no application field is read or written.
 */
export async function revokeReusableAnswerByLabelKey(
  labelKey: string,
): Promise<number> {
  const normalized = stringValue(labelKey);
  if (!normalized) error(400, 'A reusable answer label key is required.');
  const library = await collection('CandidateAnswer');
  const profileKey = await resolveLibraryProfileKey();
  return await deactivateReusableRows(library, {
    labelKey: normalized,
    profileKey,
  });
}

async function markTaskDone(
  task: MutableRecord,
  now: Date,
  extra: Record<string, unknown> = {},
) {
  Object.assign(task, {
    blockerOwnerRole: '',
    blockerReason: '',
    completedAt: now,
    kanbanColumn: extra.kanbanColumn ?? task.kanbanColumn ?? 'submitted',
    status: 'done',
    ...extra,
  });
  await task.save();
}

async function markTaskCanceled(
  task: MutableRecord,
  now: Date,
  extra: Record<string, unknown> = {},
) {
  Object.assign(task, {
    blockerOwnerRole: '',
    blockerReason: '',
    completedAt: now,
    kanbanColumn:
      extra.kanbanColumn ?? task.kanbanColumn ?? 'rejected_archived',
    status: 'canceled',
    ...extra,
  });
  await task.save();
}

async function markTaskBlocked(
  task: MutableRecord,
  extra: {
    blockerOwnerRole?: string;
    blockerReason: string;
    description?: string;
  },
) {
  Object.assign(task, {
    blockerOwnerRole: stringValue(extra.blockerOwnerRole) || 'owner',
    blockerReason: stringValue(extra.blockerReason),
    completedAt: null,
    description: extra.description ?? task.description,
    kanbanColumn: 'blocked',
    status: 'blocked',
  });
  await task.save();
}

function recommendationTaskDescription(
  opportunity: Record<string, unknown>,
): string {
  const lines = [
    `Opportunity: ${titleForOpportunity(opportunity)}`,
    stringValue(opportunity.postingUrl)
      ? `Posting: ${stringValue(opportunity.postingUrl)}`
      : '',
    stringValue(opportunity.descriptionSummary)
      ? `Summary: ${stringValue(opportunity.descriptionSummary)}`
      : '',
    stringValue(opportunity.humanReviewNotes)
      ? `Existing notes: ${stringValue(opportunity.humanReviewNotes)}`
      : '',
    typeof opportunity.humanRating === 'number'
      ? `User rating: ${opportunity.humanRating}/10`
      : '',
    '',
    'Decision options: accept to apply, reject, defer, request more research, or revise score.',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function syncRecommendedOpportunityDecisionTasks(limit = 250) {
  const opportunities = await collection('Opportunity');
  const recommended = await opportunities.list({
    limit,
    orderBy: 'updated_at DESC',
    where: { status: 'recommended' },
  });

  let created = 0;
  let existing = 0;
  const closed = await closeStaleRecommendationTasks(opportunities);
  for (const opportunity of recommended) {
    const opportunityId = stringValue(opportunity.id);
    if (!opportunityId) continue;
    const result = await createTaskIfMissing(
      `review-recommendation:${opportunityId}`,
      {
        assigneeRole: 'owner',
        createdBy: 'automation',
        description: recommendationTaskDescription(opportunity),
        dueAt: opportunity.expiresAt ?? null,
        kanbanColumn: 'needs_user_decision',
        opportunityId,
        organizationProfileId: stringValue(opportunity.organizationProfileId),
        sourceId: stringValue(opportunity.sourceId),
        taskType: 'review_recommendation',
        title: `Review recommendation: ${titleForOpportunity(opportunity)}`,
      },
    );
    if (result.created) created += 1;
    else existing += 1;
  }

  return {
    closed,
    created,
    existing,
    scanned: recommended.length,
  };
}

function opportunityIntelligenceTaskProvenance(
  task: Record<string, unknown>,
): { contentFingerprint: string; contentVersion: number } | null {
  try {
    const refs = JSON.parse(stringValue(task.artifactRefsJson) || '{}') as {
      opportunityIntelligence?: {
        contentFingerprint?: unknown;
        contentVersion?: unknown;
      };
    };
    const contentFingerprint = stringValue(
      refs.opportunityIntelligence?.contentFingerprint,
    );
    const contentVersion = refs.opportunityIntelligence?.contentVersion;
    if (
      !contentFingerprint ||
      typeof contentVersion !== 'number' ||
      !Number.isInteger(contentVersion) ||
      contentVersion < 1
    ) {
      return null;
    }
    return { contentFingerprint, contentVersion };
  } catch {
    return null;
  }
}

function opportunityIntelligenceTaskExternalId(
  opportunityId: string,
  taskType: string,
  contentFingerprint: string,
): string {
  const prefix =
    taskType === 'research_company' ? 'company-research' : 'revise-score';
  return `${prefix}:${opportunityId}:${contentFingerprint}`;
}

export async function cancelStaleOpportunityIntelligenceTasks(
  opportunityId: string,
  currentContentFingerprint: string,
  currentContentVersion: number,
): Promise<number> {
  if (
    !opportunityId ||
    !currentContentFingerprint ||
    !Number.isInteger(currentContentVersion) ||
    currentContentVersion < 1
  ) {
    return 0;
  }
  const tasks = await collection('Task');
  const candidates = await tasks.list({
    limit: 100,
    orderBy: 'updated_at DESC',
    where: { opportunityId },
  });
  let canceled = 0;
  const now = new Date();
  const database = await resolveDatabase(getDbConfig());
  for (const task of candidates) {
    const taskType = stringValue(task.taskType);
    const status = stringValue(task.status);
    const provenance = opportunityIntelligenceTaskProvenance(task);
    const artifactRefsJson = stringValue(task.artifactRefsJson);
    const expectedUpdatedAt = task.updated_at;
    if (
      !['research_company', 'score_opportunity'].includes(taskType) ||
      !isActiveTaskStatus(status) ||
      stringValue(task.createdBy) !== 'automation' ||
      !provenance ||
      provenance.contentVersion >= currentContentVersion ||
      provenance.contentFingerprint === currentContentFingerprint ||
      stringValue(task.externalTaskId) !==
        opportunityIntelligenceTaskExternalId(
          opportunityId,
          taskType,
          provenance.contentFingerprint,
        ) ||
      !expectedUpdatedAt
    ) {
      continue;
    }
    const result = await database.update(
      'tasks',
      {
        artifact_refs_json: artifactRefsJson,
        created_by: 'automation',
        external_task_id: stringValue(task.externalTaskId),
        id: stringValue(task.id),
        opportunity_id: opportunityId,
        status,
        task_type: taskType,
        updated_at: expectedUpdatedAt,
      },
      {
        completed_at: now,
        kanban_column: 'rejected_archived',
        status: 'canceled',
        updated_at: now,
      },
    );
    if (result.affected > 0) canceled += 1;
  }
  return canceled;
}

async function closeStaleRecommendationTasks(
  opportunities: Collection,
): Promise<number> {
  const tasks = await collection('Task');
  const reviewTasks = await tasks.list({
    limit: 500,
    orderBy: 'updated_at DESC',
    where: { taskType: 'review_recommendation' },
  });
  let closed = 0;
  const now = new Date();

  for (const task of reviewTasks) {
    if (!isActiveTaskStatus(task.status)) continue;

    const opportunityId = stringValue(task.opportunityId);
    const opportunity = opportunityId
      ? await opportunities.get(opportunityId)
      : null;
    if (opportunity && stringValue(opportunity.status) === 'recommended')
      continue;

    await markTaskCanceled(task, now, {
      kanbanColumn: 'rejected_archived',
    });
    closed += 1;
  }

  return closed;
}

/**
 * A posting preflight closes work immediately, rather than waiting for the
 * next board reconciliation. Recommendation tasks have no Application yet,
 * so they are not covered by application cleanup below.
 */
async function cancelActiveRecommendationTasksForClosedPosting(
  opportunityId: string,
): Promise<number> {
  const tasks = await collection('Task');
  const reviewTasks = await tasks.list({
    limit: 200,
    orderBy: 'updated_at DESC',
    where: { opportunityId, taskType: 'review_recommendation' },
  });
  const now = new Date();
  let canceled = 0;

  for (const task of reviewTasks) {
    if (!isActiveTaskStatus(task.status)) continue;
    await markTaskCanceled(task, now, { kanbanColumn: 'rejected_archived' });
    canceled += 1;
  }

  return canceled;
}

/** Kanban column every automated recommendation-task closure lands in. */
export const AUTO_ARCHIVE_TASK_COLUMN = 'rejected_archived';

type BatchedTaskDatabase = {
  query: (sql: string, ...vars: unknown[]) => Promise<unknown>;
};

/**
 * Close every open `review_recommendation` task for a batch of postings that
 * an automated archive just retired (issue #434).
 *
 * The board reconciler (`not_listed`) and the inactive-source sweep
 * (`source_inactive`) archive without touching tasks, so an open review task
 * kept pointing at a dead posting until the next
 * {@link syncRecommendedOpportunityDecisionTasks} pass swept it up — visible
 * in the meantime as stale work in the owner's task list. Closing it in the
 * same transition removes that window.
 *
 * This is one batched statement rather than a `save()` per task because the
 * archive it accompanies is itself batched and can retire thousands of rows.
 * The closure is exactly {@link markTaskCanceled}'s field set, plus a line
 * appended to the description naming the reason, so a canceled task explains
 * itself. Only active tasks of that one type for those exact opportunities
 * match: an unrelated task, a task of another type, and an already-closed
 * task are all left untouched.
 */
export async function closeReviewTasksForArchivedOpportunities(options: {
  archiveReason: string;
  database: BatchedTaskDatabase;
  now?: Date;
  opportunityIds: readonly string[];
}): Promise<number> {
  const opportunityIds = [
    ...new Set(
      options.opportunityIds
        .map((id) => stringValue(id))
        .filter((id) => id.length > 0),
    ),
  ];
  if (opportunityIds.length === 0) return 0;
  const reason = stringValue(options.archiveReason) || 'archived';
  const result = (await options.database.query(
    `UPDATE tasks
        SET status = 'canceled',
            kanban_column = $1,
            completed_at = $2,
            blocker_owner_role = '',
            blocker_reason = '',
            description = btrim(
              coalesce(description, '') ||
              E'\n\nClosed automatically: the opportunity was archived (' ||
              $3 || ').'
            ),
            updated_at = now()
      WHERE task_type = 'review_recommendation'
        AND status = ANY($4::text[])
        AND opportunity_id = ANY($5::text[])
      RETURNING id`,
    AUTO_ARCHIVE_TASK_COLUMN,
    options.now ?? new Date(),
    reason,
    [...activeTaskStatuses],
    opportunityIds,
  )) as { rows?: unknown[] } | unknown[] | undefined;
  const rows = Array.isArray(result) ? result : (result?.rows ?? []);
  // Issue #459: this is a raw statement, so nothing feeds SMRT's change feed
  // for it. `tasks` is live-subscribed, so without this a mounted task list
  // keeps showing review work against a posting auto-archive already closed,
  // until it is reloaded. Bump inside the caller's transaction with the ids
  // the statement actually returned, exactly as the opportunity writers do.
  await bumpTaskChangeFeed(
    options.database,
    rows.map((row) => stringValue((row as { id?: unknown })?.id)),
  );
  return rows.length;
}

async function getOrCreateApplicationForOpportunity(
  opportunity: MutableRecord,
  decision: MutableRecord,
  now: Date,
) {
  const opportunityId = stringValue(opportunity.id);
  const applications = await collection('Application');
  const existing = await applications.list({
    limit: 1,
    orderBy: 'updated_at DESC',
    where: { opportunityId },
  });
  const existingApplication = existing[0];
  const application = existingApplication ?? (await applications.create({}));
  const applicationBeforeInitialization = { ...application };
  if (
    existingApplication &&
    applicationMaterialsAreLockedOrLeased(application.status, application)
  ) {
    error(
      409,
      'Submitted, closed, or in-progress applications cannot be changed while accepting an opportunity.',
    );
  }
  const detectedApplyMethod = stringValue(opportunity.applyMethod);
  const updates: Record<string, unknown> = {
    applicationUrl:
      stringValue(application.applicationUrl) ||
      stringValue(opportunity.applyUrl) ||
      stringValue(opportunity.postingUrl),
    applyMethod:
      detectedApplyMethod && detectedApplyMethod !== 'unknown'
        ? detectedApplyMethod
        : stringValue(application.applyMethod) || 'company_site',
    decisionId: stringValue(decision.id),
    opportunityId,
    sourceCrawlId:
      stringValue(application.sourceCrawlId) ||
      stringValue(opportunity.sourceCrawlId),
    sourceCrawlItemId:
      stringValue(application.sourceCrawlItemId) ||
      stringValue(opportunity.sourceCrawlItemId),
    status:
      normalizeApplicationStatus(application.status) === 'draft'
        ? 'application_drafting'
        : normalizeApplicationStatus(application.status),
  };
  const scopeChanged = applicationApprovalScopeChanged({
    currentRecord: applicationBeforeInitialization,
    payload: updates,
  });
  if (applicationApprovalShouldInvalidate(application.status) && scopeChanged) {
    updates.status = 'awaiting_user';
    clearApplicationApprovalFields(updates);
  }
  if (existingApplication) {
    if (
      !(await commitApplicationIfCurrent(
        application,
        updates,
        lifecycleDatabase.getStore(),
      ))
    ) {
      error(
        409,
        'Application changed while the opportunity was accepted. Reload and review the current application.',
      );
    }
  } else {
    Object.assign(application, updates);
    await application.save();
  }

  await createTaskIfMissing(
    `application-packet:${stringValue(application.id)}`,
    {
      applicationId: stringValue(application.id),
      assigneeRole: 'hermes',
      createdBy: 'automation',
      description: [
        'Create the reviewable application packet for the user.',
        'Include opportunity summary, company notes, fit rationale, concerns, positioning, requested materials, open questions, and source URLs.',
      ].join('\n'),
      kanbanColumn: 'materials_drafting',
      opportunityId,
      organizationProfileId: stringValue(opportunity.organizationProfileId),
      sourceId: stringValue(opportunity.sourceId),
      status: 'open',
      taskType: 'prepare_application_packet',
      title: `Prepare application packet: ${titleForOpportunity(opportunity)}`,
    },
  );

  await createTaskIfMissing(
    applicationAccountCheckExternalTaskId(stringValue(application.id)),
    {
      applicationId: stringValue(application.id),
      assigneeRole: 'automation',
      createdBy: 'automation',
      description:
        'Confirm whether this application needs an account, signup, 2FA, CAPTCHA, or Warden handoff. Do not store credentials in this app.',
      dueAt: now,
      kanbanColumn: 'needs_account_credentials',
      opportunityId,
      status: 'open',
      taskType: 'account_setup',
      title: `Check account requirements: ${titleForOpportunity(opportunity)}`,
    },
  );

  return application;
}

// Record a discovered company careers page as a fail-closed Source candidate
// (idempotent by URL). Automated research is not an authoritative root-source
// classification decision; an operator must reconcile and explicitly enable it.
async function ensureCompanyCareersSource(
  company: MutableRecord,
): Promise<{ id: string; created: boolean }> {
  const careersUrl = stringValue(company.careersUrl);
  if (!careersUrl) return { created: false, id: '' };

  const sources = await collection('Source');
  const existing = await sources.list({ limit: 1, where: { url: careersUrl } });
  if (existing[0]) return { created: false, id: stringValue(existing[0].id) };

  // Classify the careers URL through the job-board adapter engine and record the
  // detected platform (greenhouse/ashby/lever) in accountNotes for visibility. The
  // crawler dispatches by detecting from the URL at crawl time, so Source.type
  // stays the constrained enum value.
  const { detectJobBoard } = await import('./opportunity-source-crawler.js');
  const detection = await detectJobBoard(careersUrl, {
    includeGeneric: true,
  }).catch(() => null);

  const companyName = stringValue(company.name);
  const source = await sources.create({
    accountNotes: [
      `Auto-added from ${companyName || 'company'} research.`,
      detection ? `Detected platform: ${detection.platformName}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    accountStatus: 'none_needed',
    isActive: false,
    name: companyName ? `${companyName} careers` : 'Company careers',
    parentSourceId: null,
    provider: detection?.type ?? 'unknown',
    refreshCadence: 'weekly',
    sourceRole: 'unknown',
    // Keep the constrained Source.type enum value; the crawler dispatches by
    // detecting the platform from the URL at crawl time, and the detected
    // platform is recorded in accountNotes above for visibility.
    type: 'company_careers',
    url: careersUrl,
  });
  await source.save();
  return { created: true, id: stringValue(source.id) };
}

// Ensure the company behind an application is researched and its careers page is
// captured as a source. Triggered on application start and from the manual
// "Research" action on the company view.
export async function ensureCompanyResearch(options: {
  companyId: string;
  opportunityId?: string;
  organizationProfileId?: string;
  sourceId?: string;
  createdBy?: string;
  reason?: string;
}): Promise<{
  companyId: string;
  researchTaskId: string;
  careersSourceId: string;
  careersSourceCreated: boolean;
}> {
  const companyId = stringValue(options.companyId);
  const empty = {
    careersSourceCreated: false,
    careersSourceId: '',
    companyId,
    researchTaskId: '',
  };
  if (!companyId) return empty;

  const companies = await collection('Company');
  const company = (await companies.get(companyId)) as MutableRecord | null;
  if (!company) return empty;

  const status = stringValue(company.researchStatus);
  if (status !== 'done' && status !== 'in_progress') {
    company.researchStatus = 'in_progress';
    await company.save();
  }

  const companyName = stringValue(company.name) || companyId;
  const reason = stringValue(options.reason);
  const { task } = await createTaskIfMissing(
    `company-research:company:${companyId}`,
    {
      assigneeRole: 'hermes',
      createdBy: options.createdBy || 'automation',
      description: [
        reason || `Research ${companyName} for the active application(s).`,
        'Capture product, stage/funding, why-interesting, concerns, remote policy, and compensation norms.',
        'Find the official careers/jobs page and add it as a Source so we can crawl direct postings (and the real apply URL).',
      ].join('\n'),
      kanbanColumn: 'researching',
      opportunityId: stringValue(options.opportunityId),
      organizationProfileId: stringValue(options.organizationProfileId),
      sourceId: stringValue(options.sourceId),
      taskType: 'research_company',
      title: `Research company: ${companyName}`,
    },
  );

  const careersSource = await ensureCompanyCareersSource(company);
  return {
    careersSourceCreated: careersSource.created,
    careersSourceId: careersSource.id,
    companyId,
    researchTaskId: stringValue(task.id),
  };
}

// Accept an opportunity straight from the opportunities list (no task in hand).
// When a live "review recommendation" task exists we route through the normal
// task flow so the board stays consistent; otherwise we create the application
// directly with the same accept_to_apply semantics.
async function assertNoApplicationForNonApplyDecision(
  opportunityId: string,
): Promise<void> {
  const applications = await collection('Application');
  const [existingApplication] = await applications.list({
    limit: 1,
    orderBy: 'updated_at DESC',
    where: { opportunityId },
  });
  if (
    existingApplication &&
    !terminalApplicationStatuses.has(stringValue(existingApplication.status))
  ) {
    error(
      409,
      'A non-apply decision cannot replace the lifecycle of an existing application. Update the application instead.',
    );
  }
}

const opportunityLifecycleLockTimeoutMs = 15_000;
const opportunityLifecycleLockRetryMs = 100;

function pauseForLifecycleLock(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assertOpportunityLifecycleLockIsActive(): void {
  const session = lifecycleLock.getStore();
  if (!session || session.isActive()) return;
  error(
    409,
    'The posting check connection was lost. Please try again before making application changes.',
  );
}

/**
 * Runs a bounded local mutation group on one database transaction while an
 * opportunity lifecycle session lock is already held. External work must stay
 * outside this helper so it cannot hold a transaction connection.
 */
export async function runOpportunityLifecycleTransaction<T>(
  action: (database: ResolvedDatabase) => Promise<T>,
): Promise<T> {
  assertOpportunityLifecycleLockIsActive();
  const activeDatabase = lifecycleDatabase.getStore();
  if (activeDatabase) {
    const result = await action(activeDatabase);
    assertOpportunityLifecycleLockIsActive();
    return result;
  }

  const database =
    getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
  if (!database.transaction) {
    throw new Error(
      'Opportunity lifecycle mutations require transactional database support.',
    );
  }
  assertOpportunityLifecycleLockIsActive();
  return await database.transaction(async (transaction) => {
    assertOpportunityLifecycleLockIsActive();
    return await lifecycleDatabase.run(transaction, async () => {
      assertOpportunityLifecycleLockIsActive();
      const result = await action(transaction);
      // The advisory lock belongs to a different pinned session. If that
      // session drops during local work, return an error here so this
      // short transaction rolls back instead of committing without the
      // lifecycle serialization guarantee.
      assertOpportunityLifecycleLockIsActive();
      return result;
    });
  });
}

async function withOpportunityLifecycleLock<T>(
  opportunityId: string,
  action: () => Promise<T>,
): Promise<T> {
  const database =
    getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
  if (getDbConfig().type === 'sqlite') {
    let active = true;
    const localSession = {
      isActive: () => active,
    } as OpportunityLifecycleSession;
    try {
      return await withSqliteOperationLock(
        `opportunity-lifecycle:${opportunityId}`,
        async () => await lifecycleLock.run(localSession, action),
      );
    } catch (cause) {
      if (cause instanceof KeyedLockTimeoutError) error(409, cause.message);
      throw cause;
    } finally {
      active = false;
    }
  }
  if (!database.acquireSession) {
    throw new Error(
      'Opportunity lifecycle changes require PostgreSQL session-lock support.',
    );
  }

  const lockKey = `opportunity-lifecycle:${opportunityId}`;
  const deadline = Date.now() + opportunityLifecycleLockTimeoutMs;
  let session: Awaited<
    ReturnType<NonNullable<typeof database.acquireSession>>
  > | null = null;

  while (!session) {
    const candidate = await database.acquireSession();
    let acquired = false;
    try {
      const result = await candidate.query(
        'SELECT pg_try_advisory_lock(hashtext(?)) AS acquired',
        [lockKey],
      );
      acquired = result.rows[0]?.acquired === true;
      if (acquired) {
        session = candidate;
        break;
      }
    } finally {
      if (!acquired) await candidate.release();
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      error(
        409,
        'Another posting check is already in progress. Please try again shortly.',
      );
    }
    await pauseForLifecycleLock(
      Math.min(opportunityLifecycleLockRetryMs, remaining),
    );
  }

  try {
    return await lifecycleLock.run(session, async () => {
      assertOpportunityLifecycleLockIsActive();
      return await action();
    });
  } finally {
    // A completed transaction must stay a success even if best-effort unlock
    // cleanup observes a dropped connection. Releasing the pinned session is
    // sufficient for PostgreSQL to release any remaining advisory lock.
    try {
      if (session.isActive()) {
        await session.query('SELECT pg_advisory_unlock(hashtext(?))', [
          lockKey,
        ]);
      }
    } catch {
      // The session may already be gone; never mask a lifecycle result.
    }
    try {
      await session.release();
    } catch {
      // Session cleanup is best-effort after the lifecycle result is known.
    }
  }
}

/**
 * Serializes the fresh-posting gate with local lifecycle work while allowing a
 * closed or unverified result to persist its audit/cleanup before the caller
 * receives a failure. The session-scoped advisory lock deliberately does not
 * wrap external AI or filesystem work in a database transaction.
 */
export async function runWithFreshPostingPreflight<T>(options: {
  action: 'accept_opportunity' | 'create_application_draft' | 'generate_packet';
  onClosed?: () => Promise<void>;
  opportunity: Record<string, unknown> & { id?: string };
  overrideReason?: string;
  run: (opportunity: MutableRecord) => Promise<T>;
  user?: Pick<User, 'id'> | null;
}): Promise<T> {
  const opportunityId = stringValue(options.opportunity.id);
  if (!opportunityId) error(400, 'Opportunity id is required.');

  const outcome = await withOpportunityLifecycleLock(
    opportunityId,
    async () => {
      const opportunities = await collection('Opportunity');
      const opportunity = await opportunities.get(opportunityId);
      if (!opportunity) error(404, 'Opportunity not found.');
      assertOpportunityIsOpenForApplicationWork(opportunity);

      const {
        requireFreshPostingPreflight,
        routeClosedPostingToExistingState,
      } = await import('./posting-preflight.js');
      const preflight = await requireFreshPostingPreflight({
        action: options.action,
        deferFailure: true,
        onClosedAtomically: async () =>
          await runOpportunityLifecycleTransaction(async () => {
            const opportunityForClosure = await (
              await collection('Opportunity')
            ).get(opportunityId);
            if (!opportunityForClosure) error(404, 'Opportunity not found.');
            await routeClosedPostingToExistingState(opportunityForClosure);
            await options.onClosed?.();
            await cancelActiveRecommendationTasksForClosedPosting(
              opportunityId,
            );
          }),
        opportunity,
        overrideReason: options.overrideReason,
        user: options.user,
      });
      assertOpportunityLifecycleLockIsActive();
      if (
        preflight.outcome === 'closed' ||
        (preflight.outcome === 'inconclusive' && !preflight.overridden)
      ) {
        return { allowed: false as const, preflight };
      }
      assertOpportunityLifecycleLockIsActive();
      return { allowed: true as const, value: await options.run(opportunity) };
    },
  );

  if (!outcome.allowed) {
    if (outcome.preflight.outcome === 'closed') {
      error(
        409,
        'This posting is closed and has been archived. Application work cannot continue.',
      );
    }
    error(
      409,
      'The posting could not be verified as live. An authenticated owner must enter a reason to override this check.',
    );
  }
  return outcome.value;
}

async function planAcceptedOpportunity(options: {
  applicationId: string;
  opportunityId: string;
  user?: Pick<User, 'id'> | null;
}): Promise<void> {
  if (!options.applicationId) return;
  try {
    const { processOpportunityIntelligence } = await import(
      './opportunity-intelligence.js'
    );
    await processOpportunityIntelligence({
      applicationId: options.applicationId,
      modes: ['plan'],
      opportunityId: options.opportunityId,
      user: options.user,
    });
  } catch {
    // Acceptance should not be blocked by planning/audit work.
  }
}

async function kickOffAcceptedOpportunityResearch(
  opportunityId: string,
): Promise<void> {
  try {
    const opportunities = await collection('Opportunity');
    const opportunity = await opportunities.get(opportunityId);
    if (!opportunity) return;
    await ensureCompanyResearch({
      companyId: stringValue(opportunity.companyId),
      createdBy: 'automation',
      opportunityId,
      organizationProfileId: stringValue(opportunity.organizationProfileId),
      sourceId: stringValue(opportunity.sourceId),
    });
  } catch {
    // Research kickoff is best-effort and runs after the lifecycle transaction
    // so a failed research write cannot poison the accepted application.
  }
}

type ExplicitOpportunityDecisionOptions = {
  deciderProfileId?: string;
  decision: 'apply' | 'maybe' | 'reject';
  opportunityId: string;
  preflightOverrideReason?: string;
  reason?: string;
  reuseExistingApplication?: boolean;
  user?: Pick<User, 'id'> | null;
};

export async function recordExplicitOpportunityDecision(
  options: ExplicitOpportunityDecisionOptions,
) {
  const opportunityId = stringValue(options.opportunityId);
  if (!opportunityId) error(400, 'Opportunity id is required.');
  const result =
    options.decision === 'apply'
      ? await (async () => {
          const opportunities = await collection('Opportunity');
          const opportunity = await opportunities.get(opportunityId);
          if (!opportunity) error(404, 'Opportunity not found.');
          return await runWithFreshPostingPreflight({
            action: 'accept_opportunity',
            onClosed: async () => {
              await archiveApplicationsForClosedPosting(opportunityId);
            },
            opportunity,
            overrideReason: options.preflightOverrideReason,
            run: async () =>
              await runOpportunityLifecycleTransaction(
                async () =>
                  await recordExplicitOpportunityDecisionUnlocked(options),
              ),
            user: options.user,
          });
        })()
      : await withOpportunityLifecycleLock(
          opportunityId,
          async () =>
            await runOpportunityLifecycleTransaction(
              async () =>
                await recordExplicitOpportunityDecisionUnlocked(options),
            ),
        );
  if (result.syncRecommendationTasks) {
    try {
      await syncRecommendedOpportunityDecisionTasks();
    } catch {
      // The decision is already committed. Do not report it as failed merely
      // because the global task-board reconciliation needs a later retry.
    }
  }
  if (options.decision === 'apply' && !result.applicationReused) {
    await kickOffAcceptedOpportunityResearch(opportunityId);
    await planAcceptedOpportunity({
      applicationId: stringValue(result.applicationId),
      opportunityId,
      user: options.user,
    });
  }
  const { syncRecommendationTasks: _syncRecommendationTasks, ...publicResult } =
    result;
  return publicResult;
}

async function recordExplicitOpportunityDecisionUnlocked(
  options: ExplicitOpportunityDecisionOptions,
) {
  const opportunityId = stringValue(options.opportunityId);
  if (!opportunityId) {
    error(400, 'Opportunity id is required.');
  }

  const opportunities = await collection('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity) {
    error(404, 'Opportunity not found.');
  }

  if (options.decision === 'apply' && options.reuseExistingApplication) {
    const applications = await collection('Application');
    const [existingApplication] = await applications.list({
      limit: 1,
      orderBy: 'updated_at DESC',
      where: { opportunityId },
    });
    if (existingApplication) {
      return {
        applicationId: stringValue(existingApplication.id),
        applicationReused: true,
        decision: null,
        opportunityId,
        status: 'apply' as const,
        taskId: '',
      };
    }
  }

  if (options.decision !== 'apply') {
    await assertNoApplicationForNonApplyDecision(opportunityId);
  }

  const tasks = await collection('Task');
  const reviewTasks = await tasks.list({
    limit: 25,
    orderBy: 'updated_at DESC',
    where: { opportunityId, taskType: 'review_recommendation' },
  });
  const activeReviewTask = reviewTasks.find(
    (task) =>
      isActiveTaskStatus(task.status) && stringValue(task.status) !== 'blocked',
  );

  if (activeReviewTask && stringValue(opportunity.status) === 'recommended') {
    const result = await processRecommendationTaskUnlocked({
      decision:
        options.decision === 'apply'
          ? 'accept_to_apply'
          : options.decision === 'maybe'
            ? 'defer'
            : 'reject',
      deciderProfileId: options.deciderProfileId,
      preflightOverrideReason: options.preflightOverrideReason,
      reason: options.reason,
      taskId: stringValue(activeReviewTask.id),
      user: options.user,
    });
    return {
      applicationId: stringValue(result.task.applicationId),
      decision: result.decision,
      opportunityId,
      status: options.decision,
      taskId: stringValue(result.task.id),
    };
  }

  if (options.decision === 'apply') {
    const result = await acceptOpportunityForApplicationUnlocked({
      deciderProfileId: options.deciderProfileId,
      opportunityId,
      preflightOverrideReason: options.preflightOverrideReason,
      reason: options.reason,
      user: options.user,
    });
    const decisions = await collection('Decision');
    const [decision] = await decisions.list({
      limit: 1,
      orderBy: 'updated_at DESC',
      where: { opportunityId },
    });
    return {
      ...result,
      decision: decision ? jsonRecord(decision) : null,
      opportunityId,
      status: options.decision,
      taskId: '',
    };
  }

  const now = new Date();
  const previousStatus = stringValue(opportunity.status);
  // "Maybe" is a human-review disposition, not an opportunity lifecycle
  // status. Match the queued recommendation/defer path by preserving the
  // current lifecycle status while recording humanReviewStatus = "maybe".
  const nextStatus = options.decision === 'maybe' ? previousStatus : 'rejected';
  const decisions = await collection('Decision');
  const decision = await decisions.create({
    decision: options.decision === 'maybe' ? 'defer' : 'reject',
    decisionBy: 'owner',
    deciderProfileId: stringValue(options.deciderProfileId),
    deciderUserId: stringValue(options.user?.id),
    newStatus: nextStatus,
    opportunityId,
    previousStatus,
    reason: stringValue(options.reason),
  });
  await decision.save();

  Object.assign(opportunity, {
    humanReviewStatus: options.decision,
    reviewedAt: now,
    reviewedByProfileId: stringValue(options.deciderProfileId),
    reviewedByUserId: stringValue(options.user?.id),
    status: nextStatus,
  });
  await opportunity.save();

  return {
    applicationId: '',
    decision: jsonRecord(decision),
    opportunityId,
    status: options.decision,
    syncRecommendationTasks: true,
    taskId: '',
  };
}

type AcceptOpportunityOptions = {
  deciderProfileId?: string;
  opportunityId: string;
  preflightOverrideReason?: string;
  reason?: string;
  user?: Pick<User, 'id'> | null;
};

export async function acceptOpportunityForApplication(
  options: AcceptOpportunityOptions,
) {
  const opportunityId = stringValue(options.opportunityId);
  if (!opportunityId) error(400, 'Opportunity id is required.');
  const opportunities = await collection('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity) error(404, 'Opportunity not found.');
  const result = await runWithFreshPostingPreflight({
    action: 'accept_opportunity',
    onClosed: async () => {
      await archiveApplicationsForClosedPosting(opportunityId);
    },
    opportunity,
    overrideReason: options.preflightOverrideReason,
    run: async () =>
      await runOpportunityLifecycleTransaction(
        async () => await acceptOpportunityForApplicationUnlocked(options),
      ),
    user: options.user,
  });
  await kickOffAcceptedOpportunityResearch(opportunityId);
  await planAcceptedOpportunity({
    applicationId:
      'applicationId' in result
        ? stringValue(result.applicationId)
        : stringValue(result.task.applicationId),
    opportunityId,
    user: options.user,
  });
  return result;
}

async function acceptOpportunityForApplicationUnlocked(
  options: AcceptOpportunityOptions,
) {
  const opportunityId = stringValue(options.opportunityId);
  if (!opportunityId) {
    error(400, 'Opportunity id is required.');
  }

  const opportunities = await collection('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity) {
    error(404, 'Opportunity not found.');
  }
  assertOpportunityIsOpenForApplicationWork(opportunity);

  const tasks = await collection('Task');
  const reviewTasks = await tasks.list({
    limit: 25,
    orderBy: 'updated_at DESC',
    where: { opportunityId, taskType: 'review_recommendation' },
  });
  const activeReviewTask = reviewTasks.find(
    (task) =>
      isActiveTaskStatus(task.status) && stringValue(task.status) !== 'blocked',
  );

  if (activeReviewTask && stringValue(opportunity.status) === 'recommended') {
    return await processRecommendationTaskUnlocked({
      decision: 'accept_to_apply',
      deciderProfileId: options.deciderProfileId,
      preflightOverrideReason: options.preflightOverrideReason,
      reason: options.reason ?? 'Accepted from opportunities list.',
      taskId: stringValue(activeReviewTask.id),
      user: options.user,
    });
  }

  const now = new Date();
  const previousStatus = stringValue(opportunity.status);
  const decisions = await collection('Decision');
  const decision = await decisions.create({
    decision: 'accept_to_apply',
    decisionBy: 'owner',
    deciderProfileId: stringValue(options.deciderProfileId),
    deciderUserId: stringValue(options.user?.id),
    newStatus: 'apply',
    opportunityId,
    previousStatus,
    reason: stringValue(options.reason) || 'Accepted from opportunities list.',
  });
  await decision.save();

  Object.assign(opportunity, {
    humanReviewStatus: 'apply',
    reviewedAt: now,
    reviewedByProfileId: stringValue(options.deciderProfileId),
    reviewedByUserId: stringValue(options.user?.id),
    status: 'apply',
  });
  await opportunity.save();

  const application = await getOrCreateApplicationForOpportunity(
    opportunity,
    decision,
    now,
  );
  decision.applicationId = stringValue(application.id);
  await decision.save();

  return {
    applicationId: stringValue(application.id),
    status: 'accepted',
  };
}

type RecommendationTaskOptions = {
  decision: string;
  deciderProfileId?: string;
  preflightOverrideReason?: string;
  reason?: string;
  taskId: string;
  user?: Pick<User, 'id'> | null;
};

export async function processRecommendationTask(
  options: RecommendationTaskOptions,
) {
  const tasks = await collection('Task');
  const task = await tasks.get(stringValue(options.taskId));
  if (!task) error(404, 'Task not found.');
  const opportunityId = stringValue(task.opportunityId);
  if (!opportunityId)
    error(400, 'Recommendation task is missing an opportunity.');
  const result =
    stringValue(options.decision) === 'accept_to_apply'
      ? await (async () => {
          const opportunities = await collection('Opportunity');
          const opportunity = await opportunities.get(opportunityId);
          if (!opportunity) error(404, 'Opportunity not found.');
          return await runWithFreshPostingPreflight({
            action: 'accept_opportunity',
            onClosed: async () => {
              await archiveApplicationsForClosedPosting(opportunityId);
            },
            opportunity,
            overrideReason: options.preflightOverrideReason,
            run: async () =>
              await runOpportunityLifecycleTransaction(
                async () => await processRecommendationTaskUnlocked(options),
              ),
            user: options.user,
          });
        })()
      : await withOpportunityLifecycleLock(
          opportunityId,
          async () =>
            await runOpportunityLifecycleTransaction(
              async () => await processRecommendationTaskUnlocked(options),
            ),
        );
  if (options.decision === 'accept_to_apply') {
    await kickOffAcceptedOpportunityResearch(opportunityId);
    await planAcceptedOpportunity({
      applicationId: stringValue(result.task.applicationId),
      opportunityId,
      user: options.user,
    });
  }
  return result;
}

async function processRecommendationTaskUnlocked(
  options: RecommendationTaskOptions,
) {
  const decisionValue = requireKnownValue(
    stringValue(options.decision),
    recommendationDecisions,
    'Invalid recommendation decision.',
  );
  const tasks = await collection('Task');
  const task = await tasks.get(stringValue(options.taskId));
  if (!task) {
    error(404, 'Task not found.');
  }

  if (
    stringValue(task.taskType) &&
    stringValue(task.taskType) !== 'review_recommendation'
  ) {
    error(400, 'Task is not a recommendation review task.');
  }

  const taskStatus = stringValue(task.status) || 'open';
  if (taskStatus === 'blocked') {
    error(400, 'Recommendation task is blocked pending requested work.');
  }

  if (!isActiveTaskStatus(taskStatus)) {
    error(400, 'Recommendation task has already been processed.');
  }

  const opportunityId = stringValue(task.opportunityId);
  if (!opportunityId) {
    error(400, 'Recommendation task is missing an opportunity.');
  }

  const opportunities = await collection('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity) {
    error(404, 'Opportunity not found.');
  }
  assertOpportunityIsOpenForApplicationWork(opportunity);
  if (stringValue(opportunity.status) !== 'recommended') {
    error(400, 'Opportunity is no longer recommended for review.');
  }
  if (['reject', 'archive', 'defer'].includes(decisionValue)) {
    await assertNoApplicationForNonApplyDecision(opportunityId);
  }
  const now = new Date();
  const previousStatus = stringValue(opportunity.status);
  const newStatus =
    decisionValue === 'accept_to_apply'
      ? 'apply'
      : decisionValue === 'reject'
        ? 'rejected'
        : decisionValue === 'archive'
          ? 'archived'
          : previousStatus;

  const decisions = await collection('Decision');
  const decision = await decisions.create({
    decision: decisionValue,
    decisionBy: 'owner',
    deciderProfileId: stringValue(options.deciderProfileId),
    deciderUserId: stringValue(options.user?.id),
    newStatus,
    opportunityId,
    previousStatus,
    reason: stringValue(options.reason),
    taskId: stringValue(task.id),
  });
  await decision.save();

  task.decisionId = stringValue(decision.id);

  if (decisionValue === 'accept_to_apply') {
    Object.assign(opportunity, {
      humanReviewStatus: 'apply',
      reviewedAt: now,
      reviewedByProfileId: stringValue(options.deciderProfileId),
      reviewedByUserId: stringValue(options.user?.id),
      status: 'apply',
    });
    await opportunity.save();
    const application = await getOrCreateApplicationForOpportunity(
      opportunity,
      decision,
      now,
    );
    decision.applicationId = stringValue(application.id);
    await decision.save();
    task.applicationId = stringValue(application.id);
    await markTaskDone(task, now, { kanbanColumn: 'accepted_apply' });
  } else if (decisionValue === 'reject' || decisionValue === 'archive') {
    Object.assign(opportunity, {
      humanReviewStatus: decisionValue === 'reject' ? 'reject' : 'archived',
      reviewedAt: now,
      reviewedByProfileId: stringValue(options.deciderProfileId),
      reviewedByUserId: stringValue(options.user?.id),
      status: newStatus,
    });
    await opportunity.save();
    await markTaskDone(task, now, { kanbanColumn: 'rejected_archived' });
  } else if (decisionValue === 'defer') {
    Object.assign(opportunity, {
      humanReviewStatus: 'maybe',
      reviewedAt: now,
      reviewedByProfileId: stringValue(options.deciderProfileId),
      reviewedByUserId: stringValue(options.user?.id),
    });
    Object.assign(task, {
      assigneeRole: 'owner',
      blockerReason:
        stringValue(options.reason) || 'Deferred for later user review.',
      dueAt: addDays(now, postSubmissionFollowUpDays),
      kanbanColumn: 'follow_up',
      status: 'open',
    });
    await Promise.all([opportunity.save(), task.save()]);
  } else if (decisionValue === 'request_more_research') {
    Object.assign(task, {
      blockerOwnerRole: 'hermes',
      blockerReason:
        stringValue(options.reason) || 'Waiting on requested Hermes research.',
      kanbanColumn: 'blocked',
      status: 'blocked',
    });
    await task.save();
    await createTaskIfMissing(`company-research:${opportunityId}`, {
      assigneeRole: 'hermes',
      createdBy: 'owner',
      description:
        stringValue(options.reason) ||
        'Research the company, role fit, risks, compensation, location, and application path before the user decides.',
      kanbanColumn: 'researching',
      opportunityId,
      organizationProfileId: stringValue(opportunity.organizationProfileId),
      sourceId: stringValue(opportunity.sourceId),
      taskType: 'research_company',
      title: `Research before decision: ${titleForOpportunity(opportunity)}`,
    });
  } else if (decisionValue === 'revise_score') {
    Object.assign(task, {
      blockerOwnerRole: 'automation',
      blockerReason:
        stringValue(options.reason) || 'Waiting on revised opportunity score.',
      kanbanColumn: 'blocked',
      status: 'blocked',
    });
    await task.save();
    await createTaskIfMissing(`revise-score:${opportunityId}`, {
      assigneeRole: 'automation',
      createdBy: 'owner',
      description:
        stringValue(options.reason) ||
        'Re-run or revise scoring signals, then summarize the changed recommendation.',
      kanbanColumn: 'researching',
      opportunityId,
      organizationProfileId: stringValue(opportunity.organizationProfileId),
      sourceId: stringValue(opportunity.sourceId),
      taskType: 'score_opportunity',
      title: `Revise opportunity score: ${titleForOpportunity(opportunity)}`,
    });
  }

  return {
    decision: jsonRecord(decision),
    task: jsonRecord(task),
  };
}

function shouldCreateAccountTask(status: unknown): boolean {
  return accountBlockerStatuses.has(stringValue(status));
}

function accountOwnerRole(status: unknown): 'owner' | 'hermes' {
  return ownerOwnedAccountStatuses.has(stringValue(status))
    ? 'owner'
    : 'hermes';
}

function applicationAccountCheckExternalTaskId(applicationId: string): string {
  return `application-account:${applicationId}:check`;
}

async function closeStaleAccountTasks(
  owner: { applicationId?: string; sourceId?: string },
  nextStatus: string,
): Promise<number> {
  const sourceId = stringValue(owner.sourceId);
  const applicationId = stringValue(owner.applicationId);
  const prefix = sourceId
    ? `source-account:${sourceId}:`
    : applicationId
      ? `application-account:${applicationId}:`
      : '';
  if (!prefix) return 0;

  const tasks = await collection('Task');
  const records = await tasks.list({
    limit: 100,
    orderBy: 'updated_at DESC',
    where: sourceId
      ? { sourceId, taskType: 'account_setup' }
      : { applicationId, taskType: 'account_setup' },
  });
  const currentExternalTaskIds = new Set<string>();
  if (shouldCreateAccountTask(nextStatus)) {
    currentExternalTaskIds.add(`${prefix}${nextStatus}`);
  } else if (applicationId && nextStatus === 'unknown') {
    currentExternalTaskIds.add(
      applicationAccountCheckExternalTaskId(applicationId),
    );
    currentExternalTaskIds.add(`account-check:${applicationId}`);
  }
  let closed = 0;
  const now = new Date();

  for (const task of records) {
    const externalTaskId = stringValue(task.externalTaskId);
    const isLegacyApplicationCheck =
      applicationId && externalTaskId === `account-check:${applicationId}`;
    if (
      !isActiveTaskStatus(task.status) ||
      (!externalTaskId.startsWith(prefix) && !isLegacyApplicationCheck) ||
      currentExternalTaskIds.has(externalTaskId)
    ) {
      continue;
    }

    await markTaskDone(task, now, {
      kanbanColumn:
        stringValue(task.kanbanColumn) || 'needs_account_credentials',
    });
    closed += 1;
  }

  return closed;
}

function accountTaskDescription(
  entity: Record<string, unknown>,
  status: string,
): string {
  const wardenReference = stringValue(entity.wardenReference);
  return [
    `Account status: ${status || 'unknown'}.`,
    stringValue(entity.accountLoginIdentity) ||
    stringValue(entity.loginIdentity)
      ? `Login identity: ${stringValue(entity.accountLoginIdentity) || stringValue(entity.loginIdentity)}`
      : '',
    wardenReference
      ? `Warden reference: ${wardenReference}`
      : 'Credentials must stay in Warden.',
    stringValue(entity.accountNotes)
      ? `Notes: ${stringValue(entity.accountNotes)}`
      : '',
    'Do not store passwords, tokens, cookies, recovery codes, or decrypted secret values in Iolaus.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function syncSourceAccountTasks(source: Record<string, unknown>) {
  const sourceId = stringValue(source.id);
  const status = normalizeAccountStatus(source.accountStatus);
  if (!sourceId) {
    return { closed: 0, created: 0, existing: 0 };
  }

  const closed = await closeStaleAccountTasks({ sourceId }, status);
  if (!shouldCreateAccountTask(status)) {
    return { closed, created: 0, existing: 0 };
  }

  const result = await createTaskIfMissing(
    `source-account:${sourceId}:${status}`,
    {
      assigneeRole: accountOwnerRole(status),
      blockerReason:
        status === 'needs_2fa'
          ? 'The user must complete 2FA or verification.'
          : '',
      createdBy: 'automation',
      description: accountTaskDescription(source, status),
      kanbanColumn: 'needs_account_credentials',
      sourceId,
      taskType: 'account_setup',
      title: `Resolve source account: ${stringValue(source.name) || sourceId}`,
    },
  );
  return {
    closed,
    created: result.created ? 1 : 0,
    existing: result.created ? 0 : 1,
  };
}

async function syncApplicationAccountTask(
  application: Record<string, unknown>,
) {
  const applicationId = stringValue(application.id);
  const status = normalizeAccountStatus(application.accountStatus);
  if (!applicationId) {
    return { closed: 0, created: 0, existing: 0 };
  }

  const closed = await closeStaleAccountTasks({ applicationId }, status);
  if (!shouldCreateAccountTask(status)) {
    return { closed, created: 0, existing: 0 };
  }

  const result = await createTaskIfMissing(
    `application-account:${applicationId}:${status}`,
    {
      applicationId,
      assigneeRole: accountOwnerRole(status),
      blockerReason:
        status === 'needs_2fa'
          ? 'The user must complete 2FA or verification.'
          : '',
      createdBy: 'automation',
      description: accountTaskDescription(application, status),
      kanbanColumn: 'needs_account_credentials',
      opportunityId: stringValue(application.opportunityId),
      taskType: 'account_setup',
      title: `Resolve application account: ${applicationId}`,
    },
  );
  return {
    closed,
    created: result.created ? 1 : 0,
    existing: result.created ? 0 : 1,
  };
}

function applicationKanbanColumn(status: string): string {
  if (status === 'application_drafting' || status === 'draft')
    return 'materials_drafting';
  if (status === 'awaiting_user') return 'ready_for_user_review';
  if (status === 'approved') return 'approved_to_submit';
  if (status === 'submitting') return 'submitting';
  if (status === 'manual_submission') return 'manual_submission';
  if (status === 'submitted') return 'submitted';
  if (status === 'interviewing') return 'interviewing';
  if (status === 'offer') return 'offer_negotiation';
  return 'rejected_archived';
}

async function closeStaleApplicationWorkflowTasks(
  application: Record<string, unknown>,
  status: string,
): Promise<number> {
  const applicationId = stringValue(application.id);
  if (!applicationId) return 0;

  const tasks = await collection('Task');
  const records = await tasks.list({
    limit: 200,
    orderBy: 'updated_at DESC',
    where: { applicationId },
  });
  const activeTaskTypes = new Set(
    activeApplicationTaskTypesByStatus[status] ?? [],
  );
  const statusStage = applicationStatusStage[status] ?? 0;
  const now = new Date();
  let closed = 0;

  for (const task of records) {
    const taskType = stringValue(task.taskType);
    if (
      !managedApplicationTaskTypes.has(taskType) ||
      !isActiveTaskStatus(task.status) ||
      activeTaskTypes.has(taskType)
    ) {
      continue;
    }

    const taskStage = applicationTaskStage[taskType] ?? 0;
    if (
      stringValue(task.status) === 'blocked' &&
      stringValue(task.blockerReason) &&
      !terminalApplicationStatuses.has(status) &&
      statusStage < taskStage
    ) {
      continue;
    }

    const kanbanColumn = applicationKanbanColumn(status);
    if (terminalApplicationStatuses.has(status) || statusStage < taskStage) {
      await markTaskCanceled(task, now, { kanbanColumn });
    } else {
      await markTaskDone(task, now, { kanbanColumn });
    }
    closed += 1;
  }

  return closed;
}

async function cancelActiveApplicationTasksForClosedPosting(
  application: Record<string, unknown>,
): Promise<number> {
  const applicationId = stringValue(application.id);
  if (!applicationId) return 0;

  const tasks = await collection('Task');
  const records = await tasks.list({
    limit: 200,
    orderBy: 'updated_at DESC',
    where: { applicationId },
  });
  const now = new Date();
  let canceled = 0;

  for (const task of records) {
    if (!isActiveTaskStatus(task.status)) continue;
    await markTaskCanceled(task, now, { kanbanColumn: 'rejected_archived' });
    canceled += 1;
  }

  return canceled;
}

export async function syncApplicationWorkflowTasks(
  application: Record<string, unknown>,
) {
  const applicationId = stringValue(application.id);
  if (!applicationId) return { closed: 0, created: 0 };

  let created = 0;
  const status = normalizeApplicationStatus(application.status);
  const opportunityId = stringValue(application.opportunityId);

  const accountResult = await syncApplicationAccountTask(application);
  created += accountResult.created;
  const closed = await closeStaleApplicationWorkflowTasks(application, status);

  if (status === 'draft' || status === 'application_drafting') {
    const result = await createTaskIfMissing(
      `application-packet:${applicationId}`,
      {
        applicationId,
        assigneeRole: 'hermes',
        createdBy: 'automation',
        description:
          'Generate or refresh the application packet. Include facts, inferred positioning, source URLs, generated material links, and questions for the user.',
        kanbanColumn: 'materials_drafting',
        opportunityId,
        taskType: 'prepare_application_packet',
        title: `Prepare application packet: ${applicationId}`,
      },
    );
    if (result.created) created += 1;
  }

  // When auto-submit routes an application back for a missing answer, suppress
  // the approval task until the answer collection is complete. A changed answer
  // clears final approval, so the normal approval task returns once the user
  // has supplied every required answer.
  const collectingAnswers =
    status === 'awaiting_user' &&
    summarizeApplicationFormAnswers(application).missingRequiredAnswers.length >
      0 &&
    (await hasActiveApplicationTaskOfType(
      applicationId,
      'collect_application_answers',
    ));

  if (status === 'awaiting_user' && !collectingAnswers) {
    const result = await createTaskIfMissing(
      `approve-application:${applicationId}`,
      {
        applicationId,
        assigneeRole: 'owner',
        createdBy: 'automation',
        description: [
          'Review the packet, resume, cover letter, answers, submission scope, and any open questions before approving external submission.',
          stringValue(application.packetAssetId)
            ? `Packet asset: ${stringValue(application.packetAssetId)}`
            : '',
          stringValue(application.resumeVariantId)
            ? `Resume variant: ${stringValue(application.resumeVariantId)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        kanbanColumn: 'ready_for_user_review',
        opportunityId,
        taskType: 'approve_application',
        title: `Review application packet: ${applicationId}`,
      },
    );
    if (result.created) created += 1;
  }

  if (
    status === 'approved' ||
    status === 'submitting' ||
    status === 'manual_submission'
  ) {
    const result = await createTaskIfMissing(
      `submit-application:${applicationId}`,
      {
        applicationId,
        // Manual submission means automated/Hermes routes are exhausted — the
        // task is the owner's to finish.
        assigneeRole: status === 'manual_submission' ? 'owner' : 'hermes',
        createdBy: 'automation',
        description: [
          'Open and fill the application where feasible.',
          'Stop before final external submission unless approval is recorded on the Application.',
          'Block for the user on CAPTCHA, 2FA, missing personal answer, credential issue, or judgment call.',
          stringValue(application.applicationUrl)
            ? `Application URL: ${stringValue(application.applicationUrl)}`
            : '',
          stringValue(application.packetAssetId)
            ? `Approved packet asset: ${stringValue(application.packetAssetId)}`
            : '',
          stringValue(application.resumeVariantId)
            ? `Approved resume variant: ${stringValue(application.resumeVariantId)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        kanbanColumn: applicationKanbanColumn(status),
        opportunityId,
        taskType: 'submit_application',
        title: `Submit approved application: ${applicationId}`,
      },
    );
    if (result.created) created += 1;
  }

  if (status === 'submitted') {
    await syncSubmittedOpportunityStatus(application);
    created += await syncPostSubmissionTasks(application);
  }

  if (status === 'interviewing') {
    const result = await createTaskIfMissing(
      `interview-prep:${applicationId}`,
      {
        applicationId,
        assigneeRole: 'owner',
        createdBy: 'automation',
        description:
          'Prepare interview notes from company research, role requirements, submitted materials, likely questions, compensation/location constraints, and questions to ask.',
        kanbanColumn: 'interviewing',
        opportunityId,
        taskType: 'interview_prep',
        title: `Prepare interview: ${applicationId}`,
      },
    );
    if (result.created) created += 1;
  }

  return { closed, created };
}

/**
 * A closed posting must remove any locally actionable application state before
 * it can be re-used. Submission history is intentionally not changed: it is
 * evidence of an action that already happened outside this workflow.
 */
export async function archiveApplicationForClosedPosting(
  application: Record<string, unknown>,
): Promise<void> {
  const status = normalizeApplicationStatus(application.status);
  if (!postingClosureArchiveableApplicationStatuses.has(status)) return;

  if (
    !(await commitApplicationIfCurrent(
      application,
      { status: 'archived' },
      lifecycleDatabase.getStore(),
    ))
  ) {
    error(
      409,
      'Application changed while its closed posting was being archived. Reload and review the current application.',
    );
  }
  await cancelActiveApplicationTasksForClosedPosting(application);
}

export async function archiveApplicationsForClosedPosting(
  opportunityId: string,
): Promise<void> {
  const applications = await collection('Application');
  const records = await applications.list({
    limit: 200,
    orderBy: 'updated_at DESC',
    where: { opportunityId },
  });
  for (const application of records) {
    await archiveApplicationForClosedPosting(application);
  }
}

async function syncSubmittedOpportunityStatus(
  application: Record<string, unknown>,
) {
  const opportunityId = stringValue(application.opportunityId);
  if (!opportunityId) return;

  const opportunities = await collection('Opportunity');
  const opportunity = await opportunities.get(opportunityId);
  if (!opportunity) return;

  const currentStatus = stringValue(opportunity.status);
  if (
    ['applied', 'archived', 'interviewing', 'offer', 'rejected'].includes(
      currentStatus,
    )
  ) {
    return;
  }

  opportunity.status = 'applied';
  await opportunity.save();
}

async function syncPostSubmissionTasks(
  application: Record<string, unknown>,
): Promise<number> {
  const applicationId = stringValue(application.id);
  const submittedAt = dateValue(application.submittedAt) ?? new Date();
  let created = 0;

  const followUp = await createTaskIfMissing(`follow-up:${applicationId}`, {
    applicationId,
    assigneeRole: 'owner',
    createdBy: 'automation',
    description:
      'Follow up on this submitted application. Review any portal, recruiter reply, or company contact before sending external messages.',
    dueAt: addDays(submittedAt, postSubmissionFollowUpDays),
    kanbanColumn: 'follow_up',
    opportunityId: stringValue(application.opportunityId),
    status: 'open',
    taskType: 'follow_up',
    title: `Follow up on submitted application: ${applicationId}`,
  });
  if (followUp.created) created += 1;

  const checkStatus = await createTaskIfMissing(
    `check-status:${applicationId}`,
    {
      applicationId,
      assigneeRole: 'automation',
      createdBy: 'automation',
      description:
        'Check portal/status if available. Do not send messages or submit additional information without approval.',
      dueAt: addDays(submittedAt, portalCheckDays),
      kanbanColumn: 'submitted',
      opportunityId: stringValue(application.opportunityId),
      status: 'open',
      taskType: 'check_status',
      title: `Check application status: ${applicationId}`,
    },
  );
  if (checkStatus.created) created += 1;

  return created;
}

function submissionActor(
  application: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  return stringValue(payloadValue(application, payload, 'submittedByRole'));
}

function submissionMethod(
  application: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  return stringValue(payloadValue(application, payload, 'submissionMethod'));
}

function submissionEvidence(
  application: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  return stringValue(
    payloadValue(application, payload, 'submissionEvidenceUrl'),
  );
}

export function validateSubmittedApplicationPayload(options: {
  currentRecord?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  user?: Pick<User, 'id'> | null;
}): string | null {
  const current = options.currentRecord ?? {};
  const nextStatus = toApplicationStatus(
    payloadValue(current, options.payload, 'status'),
  );
  if (nextStatus !== 'submitted') return null;

  const method = submissionMethod(current, options.payload);
  if (!method) {
    return 'Submitted applications require a submission method.';
  }

  if (
    !submissionMethods.includes(method as (typeof submissionMethods)[number])
  ) {
    return `Invalid submission method: ${method}.`;
  }

  if (!dateValue(payloadValue(current, options.payload, 'submittedAt'))) {
    return 'Submitted applications require a submitted timestamp.';
  }

  if (!submissionEvidence(current, options.payload)) {
    return 'Submitted applications require submission evidence.';
  }

  const actor = submissionActor(current, options.payload);
  if (!actor) {
    return 'Submitted applications require a submission actor.';
  }

  if (!submittedByRoles.includes(actor as (typeof submittedByRoles)[number])) {
    return `Invalid submission actor: ${actor}.`;
  }

  const approvalRecord = {
    finalApprovalAt: payloadValue(current, options.payload, 'finalApprovalAt'),
    finalApprovalKind: payloadValue(
      current,
      options.payload,
      'finalApprovalKind',
    ),
    finalApprovedByUserId: payloadValue(
      current,
      options.payload,
      'finalApprovedByUserId',
    ),
  };
  if (!hasFinalApplicationApproval(approvalRecord)) {
    return 'Submitted applications require final application approval.';
  }

  const submittedByUserId = stringValue(
    payloadValue(current, options.payload, 'submittedByUserId'),
  );
  if (actor === 'owner' && !submittedByUserId && !options.user?.id) {
    return 'User-submitted applications require an authenticated user.';
  }

  return null;
}

async function validatedSubmissionTask(taskId: string, applicationId: string) {
  const normalizedTaskId = stringValue(taskId);
  if (!normalizedTaskId) return null;

  const task = await (await collection('Task')).get(normalizedTaskId);
  if (!task) {
    error(404, 'Submission task not found.');
  }
  if (stringValue(task.taskType) !== 'submit_application') {
    error(400, 'Task is not a submission task.');
  }
  if (stringValue(task.applicationId) !== applicationId) {
    error(400, 'Submission task does not belong to this application.');
  }
  if (!isActiveTaskStatus(task.status)) {
    error(400, 'Submission task has already been processed.');
  }

  return task;
}

async function getOrCreateSubmissionTask(
  application: Record<string, unknown>,
  taskId = '',
): Promise<MutableRecord> {
  const applicationId = stringValue(application.id);
  const explicitTask = await validatedSubmissionTask(taskId, applicationId);
  if (explicitTask) return explicitTask;

  const existingTask = await findTaskByExternalId(
    `submit-application:${applicationId}`,
  );
  if (existingTask) return existingTask;

  const applicationStatus = normalizeApplicationStatus(application.status);
  if (
    applicationStatus !== 'approved' &&
    applicationStatus !== 'submitting' &&
    applicationStatus !== 'manual_submission'
  ) {
    error(
      400,
      'Submission blocker requires an active submission task or an approved application.',
    );
  }

  const result = await createTaskIfMissing(
    `submit-application:${applicationId}`,
    {
      applicationId,
      assigneeRole: 'hermes',
      createdBy: 'automation',
      description: [
        'Open and fill the application where feasible.',
        'Stop before final external submission unless approval is recorded on the Application.',
        'Block for the user on CAPTCHA, 2FA, missing personal answer, credential issue, or judgment call.',
        stringValue(application.applicationUrl)
          ? `Application URL: ${stringValue(application.applicationUrl)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      kanbanColumn: applicationKanbanColumn(applicationStatus),
      opportunityId: stringValue(application.opportunityId),
      status: 'open',
      taskType: 'submit_application',
      title: `Submit approved application: ${applicationId}`,
    },
  );
  return result.task;
}

async function commitSubmittedApplication(
  application: MutableRecord,
  payload: Record<string, unknown>,
): Promise<boolean> {
  // The shared fence covers both the final-approval snapshot and every
  // material-scoped Application field. A scoped change cannot race the
  // completed-submission write back into place.
  return await commitApplicationIfCurrent(application, {
    status: 'submitted',
    submittedAt: payload.submittedAt,
    submittedByProfileId: payload.submittedByProfileId,
    submittedByRole: payload.submittedByRole,
    submittedByUserId: payload.submittedByUserId,
    submissionEvidenceUrl: payload.submissionEvidenceUrl,
    submissionMethod: payload.submissionMethod,
    submissionNotes: payload.submissionNotes,
  });
}

export async function recordApplicationSubmission(options: {
  approvalMaterialsCurrent?: (
    application: Record<string, unknown>,
  ) => Promise<boolean>;
  applicationId: string;
  evidenceUrl?: string;
  notes?: string;
  profileId?: string;
  submissionMethod: string;
  submittedByRole: string;
  taskId?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const method = requireKnownValue(
    stringValue(options.submissionMethod),
    submissionMethods,
    'Invalid submission method.',
  );
  const actor = requireKnownValue(
    stringValue(options.submittedByRole),
    submittedByRoles,
    'Invalid submission actor.',
  );
  const applications = await collection('Application');
  const application = await applications.get(
    stringValue(options.applicationId),
  );
  if (!application) {
    error(404, 'Application not found.');
  }

  const now = new Date();
  const submissionTask = await validatedSubmissionTask(
    stringValue(options.taskId),
    stringValue(application.id),
  );
  const payload: Record<string, unknown> = {
    // The approved destination is part of the final-approval snapshot. The
    // submission-recording action can attest to a completed submission, but
    // must never change that destination.
    applicationUrl: stringValue(application.applicationUrl),
    status: 'submitted',
    submittedAt: now,
    submittedByProfileId: stringValue(options.profileId),
    submittedByRole: actor,
    submittedByUserId: actor === 'owner' ? stringValue(options.user?.id) : '',
    submissionEvidenceUrl:
      stringValue(options.evidenceUrl) ||
      stringValue(application.submissionEvidenceUrl),
    submissionMethod: method,
    submissionNotes: stringValue(options.notes),
  };

  if (actor === 'owner') {
    if (!options.user?.id) {
      error(400, 'User-submitted applications require an authenticated user.');
    }
  }

  const transitionViolation = validateApplicationStatusTransition({
    approvedByUserId: payload.approvedByUserId ?? application.approvedByUserId,
    currentStatus: application.status,
    nextStatus: payload.status,
  });
  if (transitionViolation) {
    await recordAgentAudit({
      application,
      error: transitionViolation,
      input: {
        action: 'record_submission',
        submissionMethod: method,
        submittedByRole: actor,
        taskId: stringValue(options.taskId),
      },
      output: { outcome: 'blocked' },
      runType: 'application_submission_blocked',
      status: 'failed',
      taskId: stringValue(options.taskId),
      user: options.user,
    });
    error(400, transitionViolation);
  }

  const violation = validateSubmittedApplicationPayload({
    currentRecord: application,
    payload,
    user: options.user,
  });
  if (violation) {
    await recordAgentAudit({
      application,
      error: violation,
      input: {
        action: 'record_submission',
        submissionMethod: method,
        submittedByRole: actor,
        taskId: stringValue(options.taskId),
      },
      output: { outcome: 'blocked' },
      runType: 'application_submission_blocked',
      status: 'failed',
      taskId: stringValue(options.taskId),
      user: options.user,
    });
    error(400, violation);
  }

  const approvalMaterialsCurrent =
    options.approvalMaterialsCurrent ??
    (async (currentApplication: Record<string, unknown>) => {
      const applicationId = stringValue(currentApplication.id);
      if (!applicationId) return false;
      try {
        const { finalApplicationApprovalMaterialsAreCurrent } = await import(
          './application-review.js'
        );
        return await finalApplicationApprovalMaterialsAreCurrent(applicationId);
      } catch {
        return false;
      }
    });
  // Reload and verify immediately before recording the external evidence and
  // issuing the guarded compare-and-swap below. The original object may have
  // become stale while an approver or material editor was working.
  const currentApplication = await applications.get(
    stringValue(application.id),
  );
  if (!currentApplication) {
    error(404, 'Application not found.');
  }
  if (!(await approvalMaterialsCurrent(currentApplication))) {
    const message =
      'Application materials changed or could not be verified after final approval.';
    await recordAgentAudit({
      application: currentApplication,
      error: message,
      input: {
        action: 'record_submission',
        submissionMethod: method,
        submittedByRole: actor,
        taskId: stringValue(options.taskId),
      },
      output: { outcome: 'blocked' },
      runType: 'application_submission_blocked',
      status: 'failed',
      taskId: stringValue(options.taskId),
      user: options.user,
    });
    error(400, message);
  }

  // Persist the immutable evidence before changing local workflow state. If
  // that audit cannot be recorded, fail closed and leave the application
  // eligible for the owner to retry the recording action.
  await recordAgentAudit({
    application: currentApplication,
    input: {
      submissionMethod: method,
      submittedByRole: actor,
      taskId: stringValue(options.taskId),
    },
    output: {
      evidenceUrl: stringValue(options.evidenceUrl),
      submittedAt: now.toISOString(),
    },
    runType: 'application_submission',
    status: 'succeeded',
    taskId: stringValue(options.taskId),
    user: options.user,
  });

  if (!(await commitSubmittedApplication(currentApplication, payload))) {
    const message =
      'Application changed after final approval; submission state was not recorded.';
    await recordAgentAudit({
      application: currentApplication,
      error: message,
      input: {
        action: 'record_submission',
        submissionMethod: method,
        submittedByRole: actor,
        taskId: stringValue(options.taskId),
      },
      output: { outcome: 'blocked' },
      runType: 'application_submission_blocked',
      status: 'failed',
      taskId: stringValue(options.taskId),
      user: options.user,
    });
    error(409, message);
  }
  Object.assign(currentApplication, payload);

  await syncSubmittedOpportunityStatus(currentApplication);

  if (submissionTask) {
    await markTaskDone(submissionTask, now, { kanbanColumn: 'submitted' });
  }

  await syncApplicationWorkflowTasks(currentApplication);
  return jsonRecord(currentApplication);
}

export async function recordApplicationSubmissionBlocker(options: {
  applicationId: string;
  blockerOwnerRole?: string;
  blockerReason: string;
  blockerType?: string;
  notes?: string;
  taskId?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const applicationId = stringValue(options.applicationId);
  const blockerReason = stringValue(options.blockerReason);
  if (!applicationId) {
    error(400, 'Application submission blocker requires an application id.');
  }
  if (!blockerReason) {
    error(400, 'Blocked submission tasks require a blocker reason.');
  }

  const applications = await collection('Application');
  const application = await applications.get(applicationId);
  if (!application) {
    error(404, 'Application not found.');
  }

  // Reject invalid requests before recording a blocker audit. These checks are
  // read-only; the audit below therefore remains the first durable mutation.
  const requestedTaskId = stringValue(options.taskId);
  const currentStatus = normalizeApplicationStatus(application.status);
  if (requestedTaskId) {
    await validatedSubmissionTask(requestedTaskId, applicationId);
  } else if (
    currentStatus !== 'approved' &&
    currentStatus !== 'submitting' &&
    currentStatus !== 'manual_submission'
  ) {
    error(
      400,
      'Submission blocker requires an active submission task or an approved application.',
    );
  }

  // Persist the refusal before it can alter workflow state. If audit storage
  // fails, nothing is rerouted or marked blocked.
  const agentRun = await recordAgentAudit({
    application,
    error: blockerReason,
    input: {
      action: 'record_submission_blocker',
      blockerType: stringValue(options.blockerType),
      hasNotes: Boolean(stringValue(options.notes)),
      taskId: requestedTaskId,
    },
    output: { outcome: 'blocked' },
    runType: 'application_submission_blocked',
    status: 'failed',
    taskId: requestedTaskId,
    user: options.user,
  });

  const opportunities = await collection('Opportunity');
  const opportunity = stringValue(application.opportunityId)
    ? await opportunities.get(stringValue(application.opportunityId))
    : null;
  const nextStatus =
    currentStatus === 'approved' ||
    currentStatus === 'submitting' ||
    currentStatus === 'manual_submission'
      ? 'awaiting_user'
      : currentStatus;

  if (nextStatus !== currentStatus) {
    const violation = validateApplicationStatusTransition({
      approvedByUserId: application.approvedByUserId,
      currentStatus,
      nextStatus,
    });
    if (violation) {
      error(400, violation);
    }
  }
  if (
    !(await commitApplicationIfCurrent(application, { status: nextStatus }))
  ) {
    error(
      409,
      'Application changed before its submission blocker could be recorded. Reload and review the current application.',
    );
  }

  const task = await getOrCreateSubmissionTask(application, requestedTaskId);

  const opportunityTitle = opportunity ? titleForOpportunity(opportunity) : '';
  const title =
    opportunityTitle ||
    stringValue(application.applicationUrl) ||
    applicationId;
  const description = [
    `Submission blocker: ${title}`,
    `Blocker type: ${stringValue(options.blockerType) || 'unspecified'}`,
    `Reason: ${blockerReason}`,
    stringValue(options.notes) ? `Notes: ${stringValue(options.notes)}` : '',
    `Application: ${applicationId}`,
    stringValue(application.opportunityId)
      ? `Opportunity: ${stringValue(application.opportunityId)}`
      : '',
    stringValue(application.applicationUrl)
      ? `Application URL: ${stringValue(application.applicationUrl)}`
      : '',
    `Packet asset: ${stringValue(application.packetAssetId) || 'not generated'}`,
    `Resume asset: ${stringValue(application.resumeAssetId) || 'not selected'}`,
    `Resume variant: ${stringValue(application.resumeVariantId) || 'not selected'}`,
    `Cover letter asset: ${stringValue(application.coverLetterAssetId) || 'not selected'}`,
    'Do not bypass CAPTCHA, 2FA, browser security interstitials, or credential gates. Resolve the blocker with the user before continuing.',
  ]
    .filter(Boolean)
    .join('\n');

  Object.assign(task, {
    applicationId,
    assigneeRole: stringValue(options.blockerOwnerRole) || 'owner',
    createdBy: 'hermes',
    description,
    dueAt: application.dueAt ?? null,
    opportunityId: stringValue(application.opportunityId),
    taskType: 'submit_application',
    title: `Resolve submission blocker: ${title}`,
  });
  await markTaskBlocked(task, {
    blockerOwnerRole: stringValue(options.blockerOwnerRole) || 'owner',
    blockerReason,
    description,
  });

  return {
    agentRun,
    application: jsonRecord(application),
    task: jsonRecord(task),
  };
}

export async function recordAgentAudit(options: {
  application?: Record<string, unknown>;
  database?: ResolvedDatabase;
  error?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  opportunity?: Record<string, unknown>;
  runType: string;
  sourceId?: string;
  status: string;
  taskId?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const agentRuns = options.database
    ? ((await getCollection('AgentRun', {
        db: options.database,
      })) as unknown as Collection)
    : await collection('AgentRun');
  const application = options.application ?? {};
  const opportunity = options.opportunity ?? {};
  const run = await agentRuns.create({
    applicationId: stringValue(application.id),
    approvalSnapshotJson: JSON.stringify({
      approvedAt: application.approvedAt ?? null,
      approvedByUserId: application.approvedByUserId ?? '',
      approvalScope: application.approvalScope ?? '',
      finalApprovalAt: application.finalApprovalAt ?? null,
      finalApprovalKind: application.finalApprovalKind ?? '',
      finalApprovedByUserId: application.finalApprovedByUserId ?? '',
      finalApprovalMaterialsJson:
        application.finalApprovalMaterialsJson ?? '[]',
    }),
    error: stringValue(options.error),
    externalActionType: options.runType.startsWith('application_submission')
      ? 'submit_application'
      : '',
    finishedAt: new Date(),
    initiatedByUserId: stringValue(options.user?.id),
    inputJson: JSON.stringify(options.input ?? {}),
    organizationProfileId:
      stringValue(application.organizationProfileId) ||
      stringValue(opportunity.organizationProfileId),
    opportunityId:
      stringValue(application.opportunityId) || stringValue(opportunity.id),
    outputJson: JSON.stringify(options.output ?? {}),
    runType: options.runType,
    sourceId:
      stringValue(options.sourceId) ||
      stringValue(application.sourceId) ||
      stringValue(opportunity.sourceId),
    startedAt: new Date(),
    status: options.status,
    taskId: stringValue(options.taskId),
  });
  await run.save();
  return jsonRecord(run);
}
