import { describe, expect, it } from 'vitest';
import {
  applicationApprovalScopeChanged,
  applicationSubmissionRequiresDedicatedAction,
  clearApplicationApprovalFields,
  hasFinalApplicationApproval,
} from './application-approval-scope';

describe('final application approval', () => {
  it('requires a dedicated final approval marker instead of scope text', () => {
    expect(
      hasFinalApplicationApproval({
        approvalScope: 'Résumé only',
        approvedAt: new Date('2026-08-26T12:00:00.000Z'),
        approvedByUserId: 'user-1',
      }),
    ).toBe(false);
    expect(
      hasFinalApplicationApproval({
        finalApprovalAt: new Date('2026-08-26T12:00:00.000Z'),
        finalApprovalKind: 'final_submission',
        finalApprovedByUserId: 'user-1',
      }),
    ).toBe(true);
  });

  it('clears final and legacy approval fields when scoped materials change', () => {
    const application: Record<string, unknown> = {
      approvalNotes: 'Ready',
      approvalScope: 'final_submission',
      approvedAt: new Date('2026-08-26T12:00:00.000Z'),
      approvedByProfileId: 'profile-1',
      approvedByUserId: 'user-1',
      finalApprovalAt: new Date('2026-08-26T12:00:00.000Z'),
      finalApprovalKind: 'final_submission',
      finalApprovedByUserId: 'user-1',
      finalApprovalMaterialsJson:
        '[{"materialRecordId":"resume-1","materialType":"resume","materialVersion":"v1"}]',
    };

    clearApplicationApprovalFields(application);

    expect(application).toMatchObject({
      approvalNotes: '',
      approvalScope: '',
      approvedAt: null,
      approvedByProfileId: '',
      approvedByUserId: '',
      finalApprovalAt: null,
      finalApprovalKind: '',
      finalApprovedByUserId: '',
      finalApprovalMaterialsJson: '[]',
    });
  });

  it('invalidates approval when the ATS target or answer schema changes', () => {
    const currentRecord = {
      requiredQuestionsJson: '{"ats":"greenhouse"}',
      resolvedApplyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      status: 'approved',
    };

    expect(
      applicationApprovalScopeChanged({
        currentRecord,
        payload: {
          resolvedApplyUrl: 'https://boards.greenhouse.io/acme/jobs/2',
        },
      }),
    ).toBe(true);
    expect(
      applicationApprovalScopeChanged({
        currentRecord,
        payload: { requiredQuestionsJson: '{"ats":"ashby"}' },
      }),
    ).toBe(true);
  });

  it('requires the dedicated workflow action to record a new submission', () => {
    expect(
      applicationSubmissionRequiresDedicatedAction({
        currentRecord: { status: 'approved' },
        payload: { status: 'submitted' },
      }),
    ).toBe(true);
    expect(
      applicationSubmissionRequiresDedicatedAction({
        currentRecord: { status: 'submitted' },
        payload: { submissionNotes: 'Retain audit note' },
      }),
    ).toBe(true);
    expect(
      applicationSubmissionRequiresDedicatedAction({
        currentRecord: { status: 'draft' },
        payload: { status: 'interviewing' },
      }),
    ).toBe(true);
    expect(
      applicationSubmissionRequiresDedicatedAction({
        currentRecord: { status: 'draft' },
        payload: { submittedAt: new Date() },
      }),
    ).toBe(true);
  });
});
