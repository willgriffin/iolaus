import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  applicationApprovalScopeKeys,
  finalApplicationApprovalKeys,
} from '../objects/application-approval-scope.js';
import { getDbConfig } from './db.js';

type ApplicationRecord = Record<string, unknown>;

const applicationColumnByField = {
  accountLoginIdentity: 'account_login_identity',
  accountNotes: 'account_notes',
  accountStatus: 'account_status',
  applicationInstructions: 'application_instructions',
  applicationUrl: 'application_url',
  applyMethod: 'apply_method',
  approvalNotes: 'approval_notes',
  approvalScope: 'approval_scope',
  approvedAt: 'approved_at',
  approvedByProfileId: 'approved_by_profile_id',
  approvedByUserId: 'approved_by_user_id',
  coverLetterAssetId: 'cover_letter_asset_id',
  coverLetterMode: 'cover_letter_mode',
  decisionId: 'decision_id',
  dueAt: 'due_at',
  evaluationScoreId: 'evaluation_score_id',
  finalApprovalAt: 'final_approval_at',
  finalApprovalKind: 'final_approval_kind',
  finalApprovalMaterialsJson: 'final_approval_materials_json',
  finalApprovedByUserId: 'final_approved_by_user_id',
  materialWriteLock: 'material_write_lock',
  notes: 'notes',
  opportunityId: 'opportunity_id',
  packetAssetId: 'packet_asset_id',
  requiredAnswers: 'required_answers',
  requiredAnswersJson: 'required_answers_json',
  requiredQuestionsJson: 'required_questions_json',
  resolvedApplyUrl: 'resolved_apply_url',
  resumeAssetId: 'resume_asset_id',
  resumeMode: 'resume_mode',
  resumeVariantId: 'resume_variant_id',
  status: 'status',
  sourceCrawlId: 'source_crawl_id',
  sourceCrawlItemId: 'source_crawl_item_id',
  submittedAt: 'submitted_at',
  submittedByProfileId: 'submitted_by_profile_id',
  submittedByRole: 'submitted_by_role',
  submittedByUserId: 'submitted_by_user_id',
  submissionEvidenceUrl: 'submission_evidence_url',
  submissionMethod: 'submission_method',
  submissionNotes: 'submission_notes',
  wardenReference: 'warden_reference',
} as const;

type ApplicationField = keyof typeof applicationColumnByField;

const applicationSystemFields = new Set<ApplicationField>([
  'materialWriteLock',
]);

export function applicationUpdatesFromPayload(
  payload: Record<string, unknown>,
): Partial<Pick<ApplicationRecord, ApplicationField>> {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([field]) =>
        field in applicationColumnByField &&
        !applicationSystemFields.has(field as ApplicationField),
    ),
  ) as Partial<Pick<ApplicationRecord, ApplicationField>>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fenceValue(field: ApplicationField, value: unknown): unknown {
  return field === 'approvedAt' ||
    field === 'dueAt' ||
    field === 'finalApprovalAt'
    ? dateValue(value)
    : value === null || value === undefined
      ? null
      : stringValue(value);
}

const approvalFenceFields = [
  'approvalNotes',
  'approvalScope',
  'approvedAt',
  'approvedByProfileId',
  'approvedByUserId',
  ...finalApplicationApprovalKeys,
] as const satisfies readonly ApplicationField[];

const applicationFenceFields = [
  ...applicationApprovalScopeKeys,
  ...approvalFenceFields,
  'materialWriteLock',
  'status',
] as const satisfies readonly ApplicationField[];

/**
 * Builds the optimistic-concurrency fence shared by final approval, submission
 * recording, and background status changes. Material and final-approval
 * fields are deliberately included: a stale worker must never overwrite a
 * concurrent material invalidation or newly recorded approval.
 */
export function applicationConcurrencyFence(
  application: ApplicationRecord,
): Record<string, unknown> | null {
  const id = stringValue(application.id);
  if (!id) return null;
  return Object.fromEntries([
    ['id', id],
    ...applicationFenceFields.map((field) => [
      applicationColumnByField[field],
      fenceValue(field, application[field]),
    ]),
  ]);
}

export async function commitApplicationIfCurrent(
  application: ApplicationRecord,
  updates: Partial<Pick<ApplicationRecord, ApplicationField>>,
  databaseOverride?: Awaited<ReturnType<typeof resolveDatabase>>,
): Promise<boolean> {
  const where = applicationConcurrencyFence(application);
  if (!where) return false;

  const databaseUpdates = Object.fromEntries(
    Object.entries(updates)
      .filter(([field]) => field in applicationColumnByField)
      .map(([field, value]) => [
        applicationColumnByField[field as ApplicationField],
        value,
      ]),
  );
  if (Object.keys(databaseUpdates).length === 0) return false;

  const database = databaseOverride ?? (await resolveDatabase(getDbConfig()));
  const result = await database.update('applications', where, {
    ...databaseUpdates,
    ...Object.fromEntries([['updated_at', new Date()]]),
  });
  if (result.affected === 0) return false;

  Object.assign(application, updates);
  return true;
}
