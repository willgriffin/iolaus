import { describe, expect, it } from 'vitest';
import {
  applicationStatusDefinitions,
  applicationStatuses,
  canTransitionApplicationStatus,
  opportunityStatusDefinitions,
  opportunityStatuses,
  validateApplicationStatusTransition,
} from './lifecycle';

describe('employment workflow lifecycle', () => {
  it('documents canonical opportunity and application statuses', () => {
    expect(opportunityStatuses).toEqual([
      'found',
      'recommended',
      'apply',
      'applied',
      'interviewing',
      'offer',
      'rejected',
      'archived',
    ]);
    expect(applicationStatuses).toEqual([
      'draft',
      'application_drafting',
      'awaiting_user',
      'approved',
      'submitting',
      'manual_submission',
      'submitted',
      'interviewing',
      'offer',
      'rejected',
      'withdrawn',
      'archived',
    ]);
    expect(
      applicationStatusDefinitions.every(
        (definition) => definition.description,
      ),
    ).toBe(true);
    expect(
      opportunityStatusDefinitions.every(
        (definition) => definition.description,
      ),
    ).toBe(true);
  });

  it('allows deliberate lifecycle transitions', () => {
    expect(
      canTransitionApplicationStatus('draft', 'application_drafting'),
    ).toBe(true);
    expect(
      canTransitionApplicationStatus('application_drafting', 'awaiting_user'),
    ).toBe(true);
    expect(canTransitionApplicationStatus('awaiting_user', 'approved')).toBe(
      true,
    );
    expect(canTransitionApplicationStatus('approved', 'submitting')).toBe(true);
    expect(canTransitionApplicationStatus('submitting', 'submitted')).toBe(
      true,
    );
    expect(canTransitionApplicationStatus('submitted', 'interviewing')).toBe(
      true,
    );
  });

  it('rejects unsafe or incoherent lifecycle jumps', () => {
    expect(canTransitionApplicationStatus('draft', 'submitted')).toBe(false);
    expect(canTransitionApplicationStatus('submitted', 'draft')).toBe(false);
    expect(canTransitionApplicationStatus('archived', 'approved')).toBe(false);
    expect(canTransitionApplicationStatus('draft', 'unknown')).toBe(false);
  });

  it('requires approval before approved/submitting/submitted states', () => {
    expect(
      validateApplicationStatusTransition({
        currentStatus: 'awaiting_user',
        nextStatus: 'approved',
      }),
    ).toBe('Application status approved requires explicit user approval.');
    expect(
      validateApplicationStatusTransition({
        approvedByUserId: 'user-1',
        currentStatus: 'awaiting_user',
        nextStatus: 'approved',
      }),
    ).toBeNull();
  });

  it('reports invalid status transitions with current and next status names', () => {
    expect(
      validateApplicationStatusTransition({
        approvedByUserId: 'user-1',
        currentStatus: 'draft',
        nextStatus: 'submitted',
      }),
    ).toBe('Application status cannot transition from draft to submitted.');
    expect(validateApplicationStatusTransition({ nextStatus: 'missing' })).toBe(
      'Invalid application status: missing.',
    );
  });
});
