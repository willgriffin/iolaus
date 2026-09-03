import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  releaseResumeVariantApplicationWrite,
  reserveResumeVariantApplicationWrite,
  resumeVariantDeleteViolation,
  resumeVariantWriteViolation,
  syncResumeVariantApplicationApprovals,
} from './resume-variant-workflow';

const workflowMocks = vi.hoisted(() => ({
  applications: [] as Array<
    Record<string, unknown> & { save: ReturnType<typeof vi.fn> }
  >,
  syncApplicationWorkflowTasks: vi.fn(async () => ({ created: 0 })),
}));
const concurrencyMocks = vi.hoisted(() => ({
  commitApplicationIfCurrent: vi.fn(
    async (
      application: Record<string, unknown>,
      updates: Record<string, unknown>,
    ) => {
      Object.assign(application, updates);
      return true;
    },
  ),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    if (className !== 'Application') {
      throw new Error(`Unexpected collection: ${className}`);
    }

    return {
      list: vi.fn(
        async ({
          limit,
          offset = 0,
          where,
        }: {
          limit?: number;
          offset?: number;
          where?: Record<string, unknown>;
        } = {}) => {
          const selected = where
            ? workflowMocks.applications.filter((application) =>
                Object.entries(where).every(
                  ([key, value]) => application[key] === value,
                ),
              )
            : workflowMocks.applications;
          return selected.slice(offset, limit ? offset + limit : undefined);
        },
      ),
    };
  }),
}));

vi.mock('./application-workflow.js', () => ({
  syncApplicationWorkflowTasks: workflowMocks.syncApplicationWorkflowTasks,
}));

vi.mock('./application-concurrency.js', () => ({
  commitApplicationIfCurrent: concurrencyMocks.commitApplicationIfCurrent,
}));

function application(
  payload: Record<string, unknown>,
): Record<string, unknown> & { save: ReturnType<typeof vi.fn> } {
  return {
    save: vi.fn(async () => undefined),
    ...payload,
  };
}

describe('resume variant workflow guards', () => {
  beforeEach(() => {
    workflowMocks.applications.length = 0;
    workflowMocks.syncApplicationWorkflowTasks.mockClear();
    concurrencyMocks.commitApplicationIfCurrent.mockReset();
    concurrencyMocks.commitApplicationIfCurrent.mockImplementation(
      async (application, updates) => {
        Object.assign(application, updates);
        return true;
      },
    );
  });

  it('invalidates selected approved applications after resume variant writes', async () => {
    const approvedApplication = application({
      approvedAt: '2026-06-04T10:00:00.000Z',
      approvedByProfileId: 'profile-1',
      approvedByUserId: 'user-1',
      id: 'app-approved',
      resumeVariantId: 'variant-1',
      status: 'approved',
    });
    const draftApplication = application({
      id: 'app-draft',
      resumeVariantId: 'variant-1',
      status: 'draft',
    });
    workflowMocks.applications.push(
      approvedApplication,
      draftApplication,
      application({
        id: 'app-other',
        resumeVariantId: 'variant-other',
        status: 'approved',
      }),
    );

    await expect(
      syncResumeVariantApplicationApprovals('variant-1'),
    ).resolves.toEqual({ invalidated: 1, selected: 2 });

    expect(approvedApplication).toMatchObject({
      approvedAt: null,
      approvedByProfileId: '',
      approvedByUserId: '',
      status: 'awaiting_user',
    });
    expect(approvedApplication.save).not.toHaveBeenCalled();
    expect(draftApplication.save).not.toHaveBeenCalled();
    expect(workflowMocks.syncApplicationWorkflowTasks).toHaveBeenCalledTimes(2);
  });

  it('blocks selected resume variant writes after application materials are locked', async () => {
    workflowMocks.applications.push(
      application({
        id: 'app-submitted',
        resumeVariantId: 'variant-1',
        status: 'submitted',
      }),
    );

    await expect(resumeVariantWriteViolation('variant-1')).resolves.toBe(
      'Submitted, closed, or in-progress applications cannot have selected resume variants changed.',
    );
  });

  it('reserves every selected application before a resume variant write', async () => {
    workflowMocks.applications.push(
      ...Array.from({ length: 100 }, (_, index) =>
        application({
          id: `app-${String(index).padStart(3, '0')}`,
          resumeVariantId: 'variant-1',
          status: 'draft',
        }),
      ),
      application({
        id: 'app-101',
        resumeVariantId: 'variant-1',
        status: 'approved',
      }),
    );

    const { reservation, violation } =
      await reserveResumeVariantApplicationWrite('variant-1');

    expect(violation).toBe('');
    expect(reservation?.applications).toHaveLength(101);
    expect(workflowMocks.applications[100]).toMatchObject({
      materialWriteLock: expect.stringContaining('resume-variant:variant-1:'),
      status: 'awaiting_user',
    });
  });

  it('leases selected applications across a resume-variant write and clears approval first', async () => {
    const approvedApplication = application({
      finalApprovalKind: 'final_submission',
      id: 'app-approved',
      resumeVariantId: 'variant-1',
      status: 'approved',
    });
    workflowMocks.applications.push(approvedApplication);

    const { reservation, violation } =
      await reserveResumeVariantApplicationWrite('variant-1');

    expect(violation).toBe('');
    expect(reservation).not.toBeNull();
    if (!reservation) throw new Error('Expected a resume-variant reservation.');
    expect(approvedApplication).toMatchObject({
      finalApprovalKind: '',
      materialWriteLock: expect.stringContaining('resume-variant:variant-1:'),
      status: 'awaiting_user',
    });

    await expect(
      releaseResumeVariantApplicationWrite(reservation),
    ).resolves.toEqual({
      applicationLocksReleased: true,
      workflowTasksSynced: true,
    });

    expect(approvedApplication.materialWriteLock).toBe('');
    expect(workflowMocks.syncApplicationWorkflowTasks).toHaveBeenCalled();
  });

  it('releases every application lock before reporting a task sync failure', async () => {
    const firstApplication = application({
      id: 'app-first',
      resumeVariantId: 'variant-1',
      status: 'draft',
    });
    const secondApplication = application({
      id: 'app-second',
      resumeVariantId: 'variant-1',
      status: 'draft',
    });
    workflowMocks.applications.push(firstApplication, secondApplication);
    workflowMocks.syncApplicationWorkflowTasks
      .mockRejectedValueOnce(new Error('Task sync unavailable'))
      .mockResolvedValueOnce({ created: 0 });

    const { reservation, violation } =
      await reserveResumeVariantApplicationWrite('variant-1');

    expect(violation).toBe('');
    if (!reservation) throw new Error('Expected a resume-variant reservation.');

    await expect(
      releaseResumeVariantApplicationWrite(reservation),
    ).resolves.toEqual({
      applicationLocksReleased: true,
      workflowTasksSynced: false,
    });
    expect(firstApplication.materialWriteLock).toBe('');
    expect(secondApplication.materialWriteLock).toBe('');
  });

  it('blocks deleting resume variants selected by applications', async () => {
    workflowMocks.applications.push(
      application({
        id: 'app-approved',
        resumeVariantId: 'variant-1',
        status: 'approved',
      }),
    );

    await expect(resumeVariantDeleteViolation('variant-1')).resolves.toBe(
      'Resume variant is selected by an application and cannot be deleted.',
    );
    await expect(resumeVariantDeleteViolation('variant-missing')).resolves.toBe(
      '',
    );
  });
});
