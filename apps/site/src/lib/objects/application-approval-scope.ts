import { normalizeApplicationStatus } from './lifecycle.js';

export const finalSubmissionApprovalKind = 'final_submission';
export const finalApplicationApprovalKeys = [
  'finalApprovalAt',
  'finalApprovalKind',
  'finalApprovedByUserId',
  'finalApprovalMaterialsJson',
] as const;

export const applicationApprovalScopeKeys = [
  'applicationInstructions',
  'applicationUrl',
  'applyMethod',
  'coverLetterAssetId',
  'coverLetterMode',
  'dueAt',
  'packetAssetId',
  'requiredAnswers',
  'requiredAnswersJson',
  'requiredQuestionsJson',
  'resolvedApplyUrl',
  'resumeAssetId',
  'resumeMode',
  'resumeVariantId',
] as const;

const approvalBoundApplicationStatuses = new Set([
  'approved',
  'submitting',
  'manual_submission',
]);
const materialLockedApplicationStatuses = new Set([
  'submitting',
  'submitted',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
  'archived',
]);
const submissionProvenanceKeys = new Set([
  'submittedAt',
  'submissionEvidenceUrl',
  'submissionMethod',
  'submissionNotes',
  'submittedByProfileId',
  'submittedByRole',
  'submittedByUserId',
]);

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function comparableScopeValue(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString();
  if (value === null || value === undefined) return '';
  return stringValue(value);
}

function hasOwnPayloadKey(
  payload: Record<string, unknown>,
  key: string,
): boolean {
  return Object.hasOwn(payload, key);
}

export function applicationApprovalShouldInvalidate(status: unknown): boolean {
  return approvalBoundApplicationStatuses.has(
    normalizeApplicationStatus(status),
  );
}

export function applicationMaterialsAreLocked(status: unknown): boolean {
  return materialLockedApplicationStatuses.has(
    normalizeApplicationStatus(status),
  );
}

export function applicationHasMaterialWriteLock(
  record: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(stringValue(record?.materialWriteLock));
}

export function applicationMaterialsAreLockedOrLeased(
  status: unknown,
  record: Record<string, unknown> | null | undefined,
): boolean {
  return (
    materialLockedApplicationStatuses.has(normalizeApplicationStatus(status)) ||
    applicationHasMaterialWriteLock(record)
  );
}

export function applicationApprovalScopeChanged(options: {
  currentRecord?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}): boolean {
  const current = options.currentRecord ?? {};
  return applicationApprovalScopeKeys.some((key) => {
    if (!hasOwnPayloadKey(options.payload, key)) return false;
    return (
      comparableScopeValue(current[key]) !==
      comparableScopeValue(options.payload[key])
    );
  });
}

/**
 * Recording a completed submission is a workflow action, not a generic CRUD
 * status change. The dedicated action verifies the final material snapshot and
 * writes the audit record before it transitions the application.
 */
export function applicationSubmissionRequiresDedicatedAction(options: {
  currentRecord?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}): boolean {
  if (
    [...submissionProvenanceKeys].some((key) =>
      hasOwnPayloadKey(options.payload, key),
    )
  ) {
    return true;
  }
  if (!hasOwnPayloadKey(options.payload, 'status')) return false;
  const currentStatus = normalizeApplicationStatus(
    options.currentRecord?.status,
  );
  const nextStatus = normalizeApplicationStatus(options.payload.status);
  return (
    nextStatus !== currentStatus &&
    materialLockedApplicationStatuses.has(nextStatus)
  );
}

function validDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== 'string' || !value.trim()) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export type FinalApprovalMaterial = {
  materialRecordId: string;
  materialType: string;
  materialVersion: string;
  pdfDigest?: string;
  pdfFilename?: string;
};

function finalApprovalMaterials(value: unknown): FinalApprovalMaterial[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
      )
      .map((entry) => ({
        materialRecordId: stringValue(entry.materialRecordId),
        materialType: stringValue(entry.materialType),
        materialVersion: stringValue(entry.materialVersion),
        pdfDigest: stringValue(entry.pdfDigest),
        pdfFilename: stringValue(entry.pdfFilename),
      }))
      .filter((entry) =>
        Boolean(
          entry.materialRecordId && entry.materialType && entry.materialVersion,
        ),
      )
      .sort((left, right) =>
        `${left.materialType}:${left.materialRecordId}`.localeCompare(
          `${right.materialType}:${right.materialRecordId}`,
        ),
      );
  } catch {
    return [];
  }
}

export function serializeFinalApprovalMaterials(
  materials: readonly FinalApprovalMaterial[],
): string {
  return JSON.stringify(
    materials
      .map((material) => ({
        materialRecordId: stringValue(material.materialRecordId),
        materialType: stringValue(material.materialType),
        materialVersion: stringValue(material.materialVersion),
        pdfDigest: stringValue(material.pdfDigest),
        pdfFilename: stringValue(material.pdfFilename),
      }))
      .filter((material) =>
        Boolean(
          material.materialRecordId &&
            material.materialType &&
            material.materialVersion,
        ),
      )
      .sort((left, right) =>
        `${left.materialType}:${left.materialRecordId}`.localeCompare(
          `${right.materialType}:${right.materialRecordId}`,
        ),
      ),
  );
}

export function finalApprovalMaterialSnapshotMatches(
  record: Record<string, unknown>,
  materials: readonly FinalApprovalMaterial[],
): boolean {
  const expected = finalApprovalMaterials(record.finalApprovalMaterialsJson);
  return (
    expected.length > 0 &&
    serializeFinalApprovalMaterials(expected) ===
      serializeFinalApprovalMaterials(materials)
  );
}

/**
 * Returns the raw SHA-256 digest for the application-selected resume that was
 * present at final approval. Legacy snapshots lack this value and therefore
 * intentionally fail the execution-time comparison.
 */
export function finalApprovalResumePdfDigest(
  record: Record<string, unknown>,
): string {
  return (
    finalApprovalMaterials(record.finalApprovalMaterialsJson).find(
      (material) => material.materialType === 'resume',
    )?.pdfDigest ?? ''
  );
}

/**
 * Returns the ATS-facing filename for the application-selected resume that
 * was present at final approval. Legacy snapshots lack this value and
 * intentionally fail the execution-time comparison.
 */
export function finalApprovalResumePdfFilename(
  record: Record<string, unknown>,
): string {
  return (
    finalApprovalMaterials(record.finalApprovalMaterialsJson).find(
      (material) => material.materialType === 'resume',
    )?.pdfFilename ?? ''
  );
}

export function recordFinalApplicationApproval(
  record: Record<string, unknown>,
  options: {
    approvedAt: Date;
    materials: readonly FinalApprovalMaterial[];
    userId: string;
  },
): void {
  const materials = JSON.parse(
    serializeFinalApprovalMaterials(options.materials),
  ) as FinalApprovalMaterial[];
  record.finalApprovalAt = options.approvedAt;
  record.finalApprovalKind = finalSubmissionApprovalKind;
  record.finalApprovedByUserId = options.userId;
  record.finalApprovalMaterialsJson = JSON.stringify(materials);
}

/**
 * The only approval which authorizes an external submission. `approvalScope`
 * remains an audit/display field and is intentionally not part of this check.
 */
export function hasFinalApplicationApproval(
  record: Record<string, unknown>,
): boolean {
  return (
    stringValue(record.finalApprovalKind) === finalSubmissionApprovalKind &&
    Boolean(stringValue(record.finalApprovedByUserId)) &&
    validDate(record.finalApprovalAt)
  );
}

/**
 * Generic resource mutations must not manufacture the marker that external
 * submission gates trust. The dedicated application-review action is the sole
 * way to record final approval.
 */
export function hasFinalApplicationApprovalMutation(
  payload: Record<string, unknown>,
): boolean {
  return finalApplicationApprovalKeys.some((key) =>
    hasOwnPayloadKey(payload, key),
  );
}

export function clearApplicationApprovalFields(
  record: Record<string, unknown>,
): void {
  record.approvalNotes = '';
  record.approvalScope = '';
  record.approvedAt = null;
  record.approvedByProfileId = '';
  record.approvedByUserId = '';
  record.finalApprovalAt = null;
  record.finalApprovalKind = '';
  record.finalApprovedByUserId = '';
  record.finalApprovalMaterialsJson = '[]';
}
