import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitResumeVariantIfCurrent } from './resume-variant-concurrency';

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => ({ affected: 1 })),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({ update: mocks.update })),
}));

describe('resume variant concurrency', () => {
  beforeEach(() => {
    mocks.update.mockReset();
    mocks.update.mockResolvedValue({ affected: 1 });
  });

  it('uses the observed version as a fence for generated artifact updates', async () => {
    const persisted = {
      candidateProfileId: 'profile-1',
      id: 'variant-1',
      notes: 'Keep this user-authored note.',
      outputSlug: 'before',
      status: 'draft',
      updated_at: '2026-08-28T12:00:00.000Z',
    };
    const variant = {
      id: 'variant-1',
      outputSlug: 'after',
      resumeAssetId: 'resume-1',
      status: 'generated',
    };

    await expect(
      commitResumeVariantIfCurrent(persisted, variant),
    ).resolves.toBe(true);

    expect(mocks.update).toHaveBeenCalledWith(
      'resume_variants',
      {
        id: 'variant-1',
        updated_at: new Date('2026-08-28T12:00:00.000Z'),
      },
      expect.objectContaining({
        output_slug: 'after',
        resume_asset_id: 'resume-1',
        status: 'generated',
        updated_at: expect.any(Date),
      }),
    );
    const updateCalls = mocks.update.mock.calls as unknown as Array<
      [string, Record<string, unknown>, Record<string, unknown>]
    >;
    const updates = updateCalls[0]?.[2];
    expect(updates).toBeDefined();
    expect(updates).not.toHaveProperty('candidate_profile_id');
    expect(updates).not.toHaveProperty('notes');
  });

  it('does not write when the observed version is absent or stale', async () => {
    await expect(
      commitResumeVariantIfCurrent({ id: 'variant-1' }, { id: 'variant-1' }),
    ).resolves.toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.update.mockResolvedValueOnce({ affected: 0 });
    await expect(
      commitResumeVariantIfCurrent(
        {
          id: 'variant-1',
          outputSlug: 'before',
          updated_at: '2026-08-28T12:00:00.000Z',
        },
        { id: 'variant-1', outputSlug: 'after' },
      ),
    ).resolves.toBe(false);
  });
});
