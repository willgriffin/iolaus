import type { SmrtObject } from '@happyvertical/smrt-core';
import type { User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import {
  type AdminResource,
  adminResources,
  type ComboFieldConfig,
  getAdminResource,
  type ReferenceFieldConfig,
  type ReferenceOption,
  type ReferenceOptionsByField,
  referenceForField,
} from '$lib/admin/resources';
import {
  AgentFieldContractError,
  normalizeAgentWritablePayload,
} from '$lib/objects/agent-field-contract';
import {
  applicationApprovalScopeChanged,
  applicationApprovalShouldInvalidate,
  applicationMaterialsAreLockedOrLeased,
  applicationSubmissionRequiresDedicatedAction,
  clearApplicationApprovalFields,
  hasFinalApplicationApprovalMutation,
} from '$lib/objects/application-approval-scope';
import {
  applicationStatusRequiresApproval,
  normalizeApplicationStatus,
  toApplicationStatus,
  validateApplicationStatusTransition,
} from '$lib/objects/lifecycle';
import {
  applicationUpdatesFromPayload,
  commitApplicationIfCurrent,
} from './application-concurrency.js';
import {
  normalizeAccountStatus,
  syncApplicationWorkflowTasks,
  syncRecommendedOpportunityDecisionTasks,
  syncSourceAccountTasks,
  validateSubmittedApplicationPayload,
} from './application-workflow.js';
import { invalidatePublishedResumeCache } from './resume-data.js';
import { queuePublishedCanonicalRefresh } from './resume-source-refresh.js';
import {
  releaseResumeVariantApplicationWrite,
  reserveResumeVariantApplicationWrite,
  resumeVariantDeleteViolation,
  syncResumeVariantApplicationApprovals,
} from './resume-variant-workflow.js';
import { getCollection } from './smrt.js';
import {
  deleteSourceSchedule,
  syncSourceSchedule,
} from './source-schedules.js';

export type AdminRecord = Record<string, unknown> & { id?: string };
export interface ComboOption {
  fieldKey: string;
  label: string;
  value: string;
}
export type ComboOptionsByField = Record<string, ComboOption[]>;
type AdminActor = Pick<User, 'id'> | null | undefined;
export const DEFAULT_ADMIN_RECORD_PAGE_SIZE = 250;
const RESUME_SOURCE_CLASS_NAMES = new Set([
  'Achievement',
  'AchievementAttachment',
  'AchievementTag',
  'Duty',
  'DutyTag',
  'Education',
  'EducationTag',
  'Experience',
  'ExperienceCompany',
  'ExperienceRole',
  'ExperienceTag',
  'Project',
  'ProjectAttachment',
  'ProjectTag',
  'ResumeSkill',
  'ResumeSkillCategory',
  'ResumeSkillGroup',
  'SkillCategory',
  'SkillCategoryMember',
  'SkillGroup',
  'SkillGroupMember',
]);
type ListAdminRecordsOptions = {
  includeApplicationDerivatives?: boolean;
  limit?: number;
  offset?: number;
  select?: readonly string[];
  where?: Record<string, unknown>;
};

export function requireAdminResource(slug: string): AdminResource {
  const resource = getAdminResource(slug);
  if (!resource) {
    error(404, `Unknown admin resource: ${slug}`);
  }
  return resource;
}

export async function getAdminCollection(resource: AdminResource) {
  return await getCollection<SmrtObject>(resource.className);
}

function queueResumeRefreshAfterSourceWrite(resource: AdminResource): void {
  if (!RESUME_SOURCE_CLASS_NAMES.has(resource.className)) return;
  invalidatePublishedResumeCache();
  queuePublishedCanonicalRefresh();
}

function assertAdminResourceIsWritable(resource: AdminResource): void {
  if (resource.className === 'AgentRun') {
    error(403, 'Agent run audit records are system-authored and immutable.');
  }
  if (
    resource.className === 'SourceCrawl' ||
    resource.className === 'SourceCrawlItem'
  ) {
    error(
      403,
      'Source crawl accounting records are system-authored and immutable.',
    );
  }
}

function assertAdminResumeAssetIsWritable(
  record: AdminRecord,
  payload: AdminRecord = {},
): void {
  if (
    stringRecordValue(record.applicationId) ||
    stringRecordValue(payload.applicationId)
  ) {
    error(
      403,
      'Application-owned materials are immutable through generic admin editing. Regenerate or revise them through the application workflow.',
    );
  }
}

export async function listAdminRecords(
  resource: AdminResource,
  options: ListAdminRecordsOptions = {},
): Promise<AdminRecord[]> {
  const collection = await getAdminCollection(resource);
  const listOptions: Record<string, unknown> = {
    orderBy: resource.orderBy,
    limit: options.limit ?? DEFAULT_ADMIN_RECORD_PAGE_SIZE,
  };
  if (options.offset && options.offset > 0) listOptions.offset = options.offset;
  if (options.select) listOptions.select = options.select;
  if (options.where) listOptions.where = options.where;

  const records = await collection.list(listOptions);
  const serialized = records.map(serializeRecord);
  if (options.includeApplicationDerivatives) return serialized;
  if (
    resource.className !== 'ResumeAsset' &&
    resource.className !== 'ResumeVariant'
  ) {
    return serialized;
  }
  return serialized.filter(
    (record) => !stringRecordValue(record.applicationId),
  );
}

export async function countAdminResourceRecords(
  resource: AdminResource,
  options: Pick<ListAdminRecordsOptions, 'where'> = {},
): Promise<number> {
  const collection = await getAdminCollection(resource);
  return await collection.count(options.where ? { where: options.where } : {});
}

export async function getAdminRecord(
  resource: AdminResource,
  id: string,
): Promise<AdminRecord | null> {
  const collection = await getAdminCollection(resource);
  const record = await collection.get(id);
  if (record) return serializeRecord(record);

  const records = await collection.list({
    orderBy: resource.orderBy,
    limit: 1000,
  });
  return (
    records
      .map(serializeRecord)
      .find((item) => stringRecordValue(item.id) === id) ?? null
  );
}

function stringRecordValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function referenceLabelCandidate(record: AdminRecord, key: string): string {
  const value = stringRecordValue(record[key]);
  if (!value) return '';
  if (key === 'id' || key.endsWith('Id')) return '';
  return value;
}

function referenceRecordLabel(
  reference: ReferenceFieldConfig,
  record: AdminRecord,
): string {
  const keys = [
    ...(reference.labelKeys ?? []),
    reference.labelKey ?? '',
    'title',
    'name',
    'label',
    'profileKey',
    'status',
    'assetType',
  ].filter(Boolean);
  for (const key of keys) {
    const value = referenceLabelCandidate(record, key);
    if (value) return value.length > 96 ? `${value.slice(0, 93)}...` : value;
  }
  return `Untitled ${reference.className ?? 'record'}`;
}

function referenceHref(
  reference: ReferenceFieldConfig,
  value: string,
): string | undefined {
  if (!reference.resourceSlug || !value) return undefined;
  return `/admin/${reference.resourceSlug}/${encodeURIComponent(value)}`;
}

export async function listReferenceOptions(
  resource: AdminResource,
): Promise<ReferenceOptionsByField> {
  const entries = await Promise.all(
    resource.fields
      .map((field) => [field, referenceForField(field)] as const)
      .filter(
        (
          entry,
        ): entry is readonly [
          (typeof resource.fields)[number],
          ReferenceFieldConfig,
        ] => Boolean(entry[1]?.className),
      )
      .map(async ([field, reference]) => {
        const collection = await getCollection(reference.className as string);
        const orderKey =
          reference.labelKey ?? reference.labelKeys?.[0] ?? 'updated_at';
        const records = (await collection.list({
          orderBy: `${orderKey} ASC`,
          limit: 1000,
        })) as SmrtObject[];
        return [
          field.key,
          records
            .map(serializeRecord)
            .map((record): ReferenceOption => {
              const value = stringRecordValue(record.id);
              return {
                href: referenceHref(reference, value),
                label: referenceRecordLabel(reference, record),
                value,
              };
            })
            .filter((option) => option.value),
        ] as const;
      }),
  );
  return Object.fromEntries(entries);
}

export async function listComboOptions(
  resource: AdminResource,
): Promise<ComboOptionsByField> {
  const entries = await Promise.all(
    resource.fields
      .filter((field) => field.kind === 'combo' && field.combo)
      .map(async (field) => {
        const combo = field.combo as ComboFieldConfig;
        const collection = await getCollection(combo.className);
        const records = await collection.list({
          orderBy: `${combo.labelKey} ASC`,
          limit: 1000,
        });
        return [
          field.key,
          records
            .map(serializeRecord)
            .map((record) => ({
              fieldKey: field.key,
              label: comboRecordLabel(combo, record),
              value: String(record[combo.valueKey ?? 'id'] ?? record.id ?? ''),
            }))
            .filter((option) => option.label && option.value),
        ] as const;
      }),
  );
  return Object.fromEntries(entries);
}

export async function countAdminRecords(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    adminResources.map(async (resource) => {
      const collection = await getAdminCollection(resource);
      return [resource.slug, await collection.count()] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function serializeRecord(record: unknown): AdminRecord {
  return JSON.parse(JSON.stringify(record)) as AdminRecord;
}

export function parseResourceForm(
  resource: AdminResource,
  formData: FormData,
): AdminRecord {
  const payload: AdminRecord = {};

  for (const field of resource.fields) {
    if (field.kind === 'checkbox') {
      payload[field.key] = formData.get(field.key) === 'on';
      continue;
    }

    const raw = formData.get(field.key);
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (field.kind === 'number') {
      payload[field.key] = value === '' ? null : Number(value);
      continue;
    }

    if (field.kind === 'datetime') {
      payload[field.key] = value === '' ? null : new Date(value);
      continue;
    }

    if (field.kind === 'date') {
      payload[field.key] =
        value === '' ? null : new Date(`${value}T00:00:00.000Z`);
      continue;
    }

    if (field.coerce === 'number') {
      payload[field.key] = value === '' ? null : Number(value);
      continue;
    }

    payload[field.key] = value;
  }

  return payload;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function comboRecordLabel(
  combo: ComboFieldConfig,
  record: AdminRecord,
): string {
  const keys = combo.displayKeys ?? [combo.labelKey];
  const values = keys
    .map((key) => String(record[key] ?? '').trim())
    .filter(Boolean);
  return values.join(' · ') || String(record.id ?? '');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function inlineComboPayload(
  combo: ComboFieldConfig,
  label: string,
): AdminRecord {
  const slug = slugify(label);
  if (combo.className === 'Company') {
    return {
      companyKey: slug,
      name: label,
    };
  }

  if (combo.className === 'EmploymentRole') {
    return {
      label,
      roleKey: slug,
      roleSlug: slug,
    };
  }

  if (combo.className === 'Experience') {
    return {
      experienceKey: slug,
      startPrecision: 'year',
      endPrecision: 'year',
    };
  }

  if (combo.className === 'SkillCategory') {
    return {
      categoryKey: slug,
      label,
    };
  }

  if (combo.className === 'SkillGroup') {
    return {
      groupKey: slug,
      label,
    };
  }

  return {
    [combo.createKey ?? combo.labelKey]: label,
  };
}

async function resolveComboValue(
  combo: ComboFieldConfig,
  rawValue: string,
): Promise<AdminRecord> {
  const collection = await getCollection(combo.className);
  const records = (await collection.list({ limit: 1000 })) as SmrtObject[];
  const serialized = records.map(serializeRecord);
  const normalizedRawValue = normalizeLabel(rawValue);
  const existing = serialized.find((record) => {
    const id = String(record.id ?? '');
    const value = String(record[combo.valueKey ?? 'id'] ?? id);
    const label = String(record[combo.labelKey] ?? '');
    const displayLabel = comboRecordLabel(combo, record);
    return (
      id === rawValue ||
      value === rawValue ||
      normalizeLabel(label) === normalizedRawValue ||
      normalizeLabel(displayLabel) === normalizedRawValue ||
      normalizeLabel(value) === normalizedRawValue
    );
  });

  if (existing?.id) return existing;

  if (combo.allowCreate === false) {
    error(400, `${combo.className} not found: ${rawValue}`);
  }

  const created = await collection.create(inlineComboPayload(combo, rawValue));
  await created.save();
  return serializeRecord(created);
}

async function resolveComboFields(
  resource: AdminResource,
  payload: AdminRecord,
): Promise<void> {
  for (const field of resource.fields) {
    if (field.kind !== 'combo' || !field.combo) continue;
    const raw = payload[field.key];
    if (typeof raw !== 'string' || raw.trim() === '') {
      payload[field.key] = '';
      continue;
    }

    const record = await resolveComboValue(field.combo, raw.trim());
    payload[field.key] = String(
      record[field.combo.valueKey ?? 'id'] ?? record.id ?? '',
    );
    if (field.combo.snapshotKey && !payload[field.combo.snapshotKey]) {
      payload[field.combo.snapshotKey] = String(
        record[field.combo.labelKey] ?? raw.trim(),
      );
    }
  }
}

function approvalUserId(payload: AdminRecord): string {
  return typeof payload.approvedByUserId === 'string'
    ? payload.approvedByUserId.trim()
    : '';
}

function hasOwnPayloadKey(payload: AdminRecord, key: string): boolean {
  return Object.hasOwn(payload, key);
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function submissionMethodFromApplyMethod(value: unknown): string {
  const applyMethod = typeof value === 'string' ? value.trim() : '';
  if (applyMethod === 'platform') return 'job_board';
  if (
    ['company_site', 'email', 'recruiter', 'referral', 'other'].includes(
      applyMethod,
    )
  ) {
    return applyMethod;
  }
  return '';
}

function assertAdminAccountStatusPayload(
  resource: AdminResource,
  payload: AdminRecord,
): void {
  if (
    (resource.className === 'Application' || resource.className === 'Source') &&
    hasOwnPayloadKey(payload, 'accountStatus')
  ) {
    payload.accountStatus = normalizeAccountStatus(payload.accountStatus);
  }
}

function normalizeAdminAgentPayload(
  resource: AdminResource,
  payload: AdminRecord,
): void {
  try {
    normalizeAgentWritablePayload(resource.className, payload);
  } catch (cause) {
    if (cause instanceof AgentFieldContractError) {
      error(400, cause.message);
    }
    throw cause;
  }
}

export function assertAdminWorkflowPayload(
  resource: AdminResource,
  payload: AdminRecord,
  user?: AdminActor,
  currentRecord?: AdminRecord | null,
  now = new Date(),
): void {
  if (resource.className !== 'Application') {
    return;
  }

  if (hasOwnPayloadKey(payload, 'materialWriteLock')) {
    error(403, 'Application material-write locks are system-managed.');
  }

  if (hasFinalApplicationApprovalMutation(payload)) {
    error(
      400,
      'Final submission approval must be recorded from the application review page.',
    );
  }
  if (
    applicationSubmissionRequiresDedicatedAction({ currentRecord, payload })
  ) {
    error(
      400,
      'Application submission must be recorded from the application review page.',
    );
  }

  const hasStatus = hasOwnPayloadKey(payload, 'status');
  const statusValue = hasStatus ? String(payload.status ?? '').trim() : '';
  if (hasStatus) {
    if (statusValue && !toApplicationStatus(statusValue)) {
      error(400, `Invalid application status: ${statusValue}.`);
    }
    payload.status = normalizeApplicationStatus(statusValue);
  }

  let scopeInvalidatedApproval = false;
  if (
    currentRecord &&
    applicationApprovalScopeChanged({ currentRecord, payload })
  ) {
    const currentStatus = currentRecord?.status ?? payload.status;
    if (applicationMaterialsAreLockedOrLeased(currentStatus, currentRecord)) {
      error(
        400,
        'Submitted or closed applications cannot have their approved materials changed.',
      );
    }
    if (applicationApprovalShouldInvalidate(currentRecord.status)) {
      payload.status = 'awaiting_user';
      clearApplicationApprovalFields(payload);
      scopeInvalidatedApproval = true;
    }
  }

  const nextStatus =
    hasStatus || scopeInvalidatedApproval
      ? payload.status
      : currentRecord?.status;
  const requiresApproval = applicationStatusRequiresApproval(nextStatus);
  const approvedByUserId = approvalUserId(payload);
  const isSubmitted = toApplicationStatus(nextStatus) === 'submitted';

  if (requiresApproval || approvedByUserId) {
    if (!user?.id) {
      error(400, 'Application approval requires an authenticated user.');
    }

    if (approvedByUserId && approvedByUserId !== user.id) {
      error(
        400,
        'Application approval requires approvedByUserId matching the authenticated user.',
      );
    }

    payload.approvedByUserId = user.id;
    if (
      !dateValue(payload.approvedAt) &&
      !dateValue(currentRecord?.approvedAt)
    ) {
      payload.approvedAt = now;
    }
  }

  if (hasStatus || scopeInvalidatedApproval) {
    const violation = validateApplicationStatusTransition({
      approvedByUserId:
        payload.approvedByUserId ?? currentRecord?.approvedByUserId,
      currentStatus: currentRecord?.status,
      nextStatus: payload.status,
    });
    if (violation) {
      error(400, violation);
    }
  }

  if (isSubmitted) {
    if (
      !dateValue(payload.submittedAt) &&
      !dateValue(currentRecord?.submittedAt)
    ) {
      payload.submittedAt = now;
    }

    if (!payload.submissionMethod && !currentRecord?.submissionMethod) {
      payload.submissionMethod = submissionMethodFromApplyMethod(
        payload.applyMethod ?? currentRecord?.applyMethod,
      );
    }

    if (!payload.submittedByRole && !currentRecord?.submittedByRole) {
      payload.submittedByRole = currentRecord?.approvedByUserId
        ? 'agent_with_approval'
        : 'owner';
    }

    if (
      payload.submittedByRole === 'owner' &&
      user?.id &&
      !payload.submittedByUserId
    ) {
      payload.submittedByUserId = user.id;
    }

    const submissionViolation = validateSubmittedApplicationPayload({
      currentRecord,
      payload,
      user,
    });
    if (submissionViolation) {
      error(400, submissionViolation);
    }
  }
}

export async function createAdminRecord(
  resource: AdminResource,
  formData: FormData,
  user?: AdminActor,
) {
  assertAdminResourceIsWritable(resource);
  const collection = await getAdminCollection(resource);
  const payload = parseResourceForm(resource, formData);
  await resolveComboFields(resource, payload);
  normalizeAdminAgentPayload(resource, payload);
  if (resource.className === 'ResumeAsset') {
    assertAdminResumeAssetIsWritable({}, payload);
  }
  assertAdminAccountStatusPayload(resource, payload);
  assertAdminWorkflowPayload(resource, payload, user);
  const record = await collection.create(payload);
  await record.save();
  if (resource.className === 'Source') {
    await syncSourceSchedule(
      record as unknown as Parameters<typeof syncSourceSchedule>[0],
    );
    await syncSourceAccountTasks(record as unknown as AdminRecord);
  }
  if (resource.className === 'Application') {
    await syncApplicationWorkflowTasks(record as unknown as AdminRecord);
  }
  if (resource.className === 'Opportunity') {
    await syncRecommendedOpportunityDecisionTasks();
  }
  if (resource.className === 'ResumeVariant') {
    await syncResumeVariantApplicationApprovals(String(record.id ?? ''));
  }
  queueResumeRefreshAfterSourceWrite(resource);
  return serializeRecord(record);
}

export async function updateAdminRecord(
  resource: AdminResource,
  formData: FormData,
  user?: AdminActor,
) {
  assertAdminResourceIsWritable(resource);
  const id = String(formData.get('id') ?? '');
  if (!id) {
    error(400, 'Missing record id');
  }

  const collection = await getAdminCollection(resource);
  const record = await collection.get(id);
  if (!record) {
    error(404, 'Record not found');
  }
  if (resource.className === 'ResumeAsset') {
    assertAdminResumeAssetIsWritable(serializeRecord(record));
  }

  const payload = parseResourceForm(resource, formData);
  await resolveComboFields(resource, payload);
  normalizeAdminAgentPayload(resource, payload);
  if (resource.className === 'ResumeAsset') {
    assertAdminResumeAssetIsWritable(serializeRecord(record), payload);
  }
  assertAdminAccountStatusPayload(resource, payload);
  assertAdminWorkflowPayload(resource, payload, user, serializeRecord(record));
  let resumeVariantReservation: Awaited<
    ReturnType<typeof reserveResumeVariantApplicationWrite>
  >['reservation'] = null;
  if (resource.className === 'ResumeVariant') {
    const { reservation, violation } =
      await reserveResumeVariantApplicationWrite(id);
    if (violation) {
      error(409, violation);
    }
    resumeVariantReservation = reservation;
  }
  try {
    if (resource.className === 'Application') {
      if (
        !(await commitApplicationIfCurrent(
          record as unknown as Record<string, unknown>,
          applicationUpdatesFromPayload(payload),
        ))
      ) {
        error(
          409,
          'Application changed before this update could be saved. Reload and review the current application.',
        );
      }
    } else {
      Object.assign(record, payload);
      await record.save();
    }
  } catch (cause) {
    if (resumeVariantReservation) {
      await releaseResumeVariantApplicationWrite(resumeVariantReservation);
    }
    throw cause;
  }
  if (resumeVariantReservation) {
    const release = await releaseResumeVariantApplicationWrite(
      resumeVariantReservation,
    );
    if (!release.applicationLocksReleased) {
      error(
        409,
        'Resume variant changed, but application materials could not be unlocked. Reload and review the current applications.',
      );
    }
    if (!release.workflowTasksSynced) {
      error(
        500,
        'Resume variant changed, but application review tasks could not be synchronized. Reload and review the current applications.',
      );
    }
  }
  if (resource.className === 'Source') {
    await syncSourceSchedule(
      record as unknown as Parameters<typeof syncSourceSchedule>[0],
    );
    await syncSourceAccountTasks(record as unknown as AdminRecord);
  }
  if (resource.className === 'Application') {
    await syncApplicationWorkflowTasks(record as unknown as AdminRecord);
  }
  if (resource.className === 'Opportunity') {
    await syncRecommendedOpportunityDecisionTasks();
  }
  if (resource.className === 'ResumeVariant') {
    await syncResumeVariantApplicationApprovals(id);
  }
  queueResumeRefreshAfterSourceWrite(resource);
  return serializeRecord(record);
}

export async function deleteAdminRecord(
  resource: AdminResource,
  formData: FormData,
) {
  assertAdminResourceIsWritable(resource);
  const id = String(formData.get('id') ?? '');
  if (!id) {
    error(400, 'Missing record id');
  }

  const collection = await getAdminCollection(resource);
  if (resource.className === 'ResumeAsset') {
    const record = await collection.get(id);
    if (!record) {
      error(404, 'Record not found');
    }
    assertAdminResumeAssetIsWritable(serializeRecord(record));
  }
  if (resource.className === 'ResumeVariant') {
    const record = await collection.get(id);
    if (!record) {
      error(404, 'Record not found');
    }

    const violation = await resumeVariantDeleteViolation(id);
    if (violation) {
      error(400, violation);
    }
  }
  const deleted = await collection.delete(id);
  if (!deleted) {
    error(404, 'Record not found');
  }
  if (resource.className === 'Source') {
    await deleteSourceSchedule(id);
  }
  queueResumeRefreshAfterSourceWrite(resource);

  return { deleted: true };
}
