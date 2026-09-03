import { randomUUID } from 'node:crypto';
import {
  applicationApprovalShouldInvalidate,
  applicationMaterialsAreLockedOrLeased,
  clearApplicationApprovalFields,
} from '../objects/application-approval-scope.js';
import { commitApplicationIfCurrent } from './application-concurrency.js';
import { syncApplicationWorkflowTasks } from './application-workflow.js';
import { getCollection } from './smrt.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};

export type ResumeVariantWriteReservation = {
  applications: MutableRecord[];
  token: string;
};

export type ResumeVariantWriteRelease = {
  applicationLocksReleased: boolean;
  workflowTasksSynced: boolean;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function selectedApplicationsForResumeVariant(
  resumeVariantId: string,
): Promise<MutableRecord[]> {
  const variantId = stringValue(resumeVariantId);
  if (!variantId) return [];

  const collection = await getCollection('Application');
  const pageSize = 100;
  const applications: MutableRecord[] = [];

  // The reservation below updates records as it walks them, so paginate by an
  // immutable key. Ordering by updated_at would move already-reserved records
  // between pages and could skip a later selected application.
  for (let offset = 0; ; offset += pageSize) {
    const page = (await collection.list({
      limit: pageSize,
      offset,
      orderBy: 'id ASC',
      where: { resumeVariantId: variantId },
    })) as unknown as MutableRecord[];
    applications.push(...page);
    if (page.length < pageSize) break;
  }

  return applications;
}

export async function resumeVariantWriteViolation(
  resumeVariantId: string,
): Promise<string> {
  const selectedApplications =
    await selectedApplicationsForResumeVariant(resumeVariantId);
  if (
    selectedApplications.some((application) =>
      applicationMaterialsAreLockedOrLeased(application.status, application),
    )
  ) {
    return 'Submitted, closed, or in-progress applications cannot have selected resume variants changed.';
  }
  return '';
}

/**
 * Reserves every selected application before a resume-variant write. The
 * reservation clears existing approval and fences final approval/material
 * changes until the variant write releases it, closing the check/write race
 * between generic variant editors and submission.
 */
export async function reserveResumeVariantApplicationWrite(
  resumeVariantId: string,
): Promise<{
  reservation: ResumeVariantWriteReservation | null;
  violation: string;
}> {
  const selectedApplications =
    await selectedApplicationsForResumeVariant(resumeVariantId);
  if (
    selectedApplications.some((application) =>
      applicationMaterialsAreLockedOrLeased(application.status, application),
    )
  ) {
    return {
      reservation: null,
      violation:
        'Submitted, closed, or in-progress applications cannot have selected resume variants changed.',
    };
  }

  const reservation: ResumeVariantWriteReservation = {
    applications: [],
    token: `resume-variant:${stringValue(resumeVariantId)}:${randomUUID()}`,
  };
  for (const application of selectedApplications) {
    const updates: Record<string, unknown> = {
      materialWriteLock: reservation.token,
    };
    if (applicationApprovalShouldInvalidate(application.status)) {
      updates.status = 'awaiting_user';
      clearApplicationApprovalFields(updates);
    }
    if (!(await commitApplicationIfCurrent(application, updates))) {
      await releaseResumeVariantApplicationWrite(reservation);
      return {
        reservation: null,
        violation:
          'Application changed before the selected resume variant could be updated. Reload and try again.',
      };
    }
    reservation.applications.push(application);
  }

  return { reservation, violation: '' };
}

export async function releaseResumeVariantApplicationWrite(
  reservation: ResumeVariantWriteReservation,
): Promise<ResumeVariantWriteRelease> {
  const result: ResumeVariantWriteRelease = {
    applicationLocksReleased: true,
    workflowTasksSynced: true,
  };
  for (const application of reservation.applications) {
    if (stringValue(application.materialWriteLock) !== reservation.token) {
      result.applicationLocksReleased = false;
      continue;
    }
    if (
      await commitApplicationIfCurrent(application, { materialWriteLock: '' })
    ) {
      try {
        await syncApplicationWorkflowTasks(application);
      } catch {
        // Continue releasing every selected application before reporting the
        // task-sync failure to the caller.
        result.workflowTasksSynced = false;
      }
    } else {
      result.applicationLocksReleased = false;
    }
  }
  return result;
}

export async function resumeVariantDeleteViolation(
  resumeVariantId: string,
): Promise<string> {
  const selectedApplications =
    await selectedApplicationsForResumeVariant(resumeVariantId);
  if (selectedApplications.length) {
    return 'Resume variant is selected by an application and cannot be deleted.';
  }
  return '';
}

export async function syncResumeVariantApplicationApprovals(
  resumeVariantId: string,
) {
  const selectedApplications =
    await selectedApplicationsForResumeVariant(resumeVariantId);
  let invalidated = 0;

  for (const application of selectedApplications) {
    if (
      applicationMaterialsAreLockedOrLeased(application.status, application)
    ) {
      continue;
    }
    if (applicationApprovalShouldInvalidate(application.status)) {
      const updates: Record<string, unknown> = { status: 'awaiting_user' };
      clearApplicationApprovalFields(updates);
      if (!(await commitApplicationIfCurrent(application, updates))) {
        continue;
      }
      invalidated += 1;
    }
    await syncApplicationWorkflowTasks(application);
  }

  return { invalidated, selected: selectedApplications.length };
}
