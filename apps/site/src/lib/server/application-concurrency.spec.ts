import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applicationConcurrencyFence,
  applicationUpdatesFromPayload,
  commitApplicationIfCurrent,
} from './application-concurrency';

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => ({ affected: 1 })),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({ update: mocks.update })),
}));

describe('application concurrency fence', () => {
  beforeEach(() => {
    mocks.update.mockReset();
    mocks.update.mockResolvedValue({ affected: 1 });
  });

  it('fences every material-scoped and final-approval field', () => {
    const fence = applicationConcurrencyFence({
      applicationInstructions: 'Use the tailored resume.',
      applicationUrl: 'https://example.com/apply',
      finalApprovalAt: '2026-08-26T16:00:00.000Z',
      finalApprovalKind: 'final_submission',
      finalApprovalMaterialsJson: '[{"materialType":"resume"}]',
      finalApprovedByUserId: 'user-1',
      id: 'app-1',
      requiredAnswersJson: '{"work_auth":"yes"}',
      resumeAssetId: 'asset-1',
      status: 'approved',
    });

    expect(fence).toMatchObject({
      application_instructions: 'Use the tailored resume.',
      application_url: 'https://example.com/apply',
      final_approval_kind: 'final_submission',
      final_approval_materials_json: '[{"materialType":"resume"}]',
      final_approved_by_user_id: 'user-1',
      id: 'app-1',
      required_answers_json: '{"work_auth":"yes"}',
      resume_asset_id: 'asset-1',
      status: 'approved',
    });
    expect(fence?.final_approval_at).toEqual(
      new Date('2026-08-26T16:00:00.000Z'),
    );
  });

  it('preserves NULL material fields in the database fence', async () => {
    const application = {
      id: 'app-1',
      materialWriteLock: null,
      status: 'application_drafting',
    };

    expect(applicationConcurrencyFence(application)).toMatchObject({
      id: 'app-1',
      material_write_lock: null,
      status: 'application_drafting',
    });

    await expect(
      commitApplicationIfCurrent(application, { status: 'awaiting_user' }),
    ).resolves.toBe(true);

    expect(mocks.update).toHaveBeenCalledWith(
      'applications',
      expect.objectContaining({ material_write_lock: null }),
      expect.objectContaining({ status: 'awaiting_user' }),
    );
  });

  it('does not mutate a stale object or downstream state when the guarded write loses', async () => {
    const application = {
      finalApprovalKind: 'final_submission',
      id: 'app-1',
      resumeAssetId: 'asset-1',
      status: 'approved',
    };
    mocks.update.mockResolvedValueOnce({ affected: 0 });

    await expect(
      commitApplicationIfCurrent(application, { status: 'submitting' }),
    ).resolves.toBe(false);

    expect(application.status).toBe('approved');
    expect(mocks.update).toHaveBeenCalledWith(
      'applications',
      expect.objectContaining({
        final_approval_kind: 'final_submission',
        resume_asset_id: 'asset-1',
        status: 'approved',
      }),
      expect.objectContaining({ status: 'submitting' }),
    );
  });

  it('uses an explicitly supplied transaction database for the guarded write', async () => {
    const transactionUpdate = vi.fn(async () => ({ affected: 1 }));
    const application = { id: 'app-1', status: 'draft' };

    await expect(
      commitApplicationIfCurrent(
        application,
        { status: 'application_drafting' },
        { update: transactionUpdate } as never,
      ),
    ).resolves.toBe(true);

    expect(transactionUpdate).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(application.status).toBe('application_drafting');
  });

  it('does not expose system-owned material-write locks to generic updates', () => {
    expect(
      applicationUpdatesFromPayload({
        materialWriteLock: 'resume-variant:variant-1:token',
        notes: 'A user note',
      }),
    ).toEqual({ notes: 'A user note' });
  });
});
