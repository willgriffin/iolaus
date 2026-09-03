import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queuePublishedCanonicalRefresh,
  resetPublishedCanonicalRefreshQueueForTests,
  withPublishedCanonicalRefresh,
} from './resume-source-refresh';

const mocks = vi.hoisted(() => ({
  refreshPublishedCanonicalResumeAsset: vi.fn(async () => ({
    asset: { id: 'fresh-canonical' },
    updatedApplications: 2,
  })),
}));

vi.mock('./resume-admin.js', () => ({
  refreshPublishedCanonicalResumeAsset:
    mocks.refreshPublishedCanonicalResumeAsset,
}));

beforeEach(() => {
  resetPublishedCanonicalRefreshQueueForTests();
  mocks.refreshPublishedCanonicalResumeAsset.mockClear();
  mocks.refreshPublishedCanonicalResumeAsset.mockResolvedValue({
    asset: { id: 'fresh-canonical' },
    updatedApplications: 2,
  });
});

describe('withPublishedCanonicalRefresh', () => {
  it('refreshes canonical after a successful resume source write', async () => {
    await expect(
      withPublishedCanonicalRefresh({ ok: true }),
    ).resolves.toMatchObject({
      canonicalRefresh: {
        assetId: 'fresh-canonical',
        updatedApplications: 2,
      },
      message: 'Saved and refreshed the canonical resume PDF.',
      ok: true,
    });
    expect(mocks.refreshPublishedCanonicalResumeAsset).toHaveBeenCalledOnce();
  });

  it('does not refresh canonical after a failed resume source write', async () => {
    await expect(
      withPublishedCanonicalRefresh({ error: 'Record not found', ok: false }),
    ).resolves.toEqual({ error: 'Record not found', ok: false });
    expect(mocks.refreshPublishedCanonicalResumeAsset).not.toHaveBeenCalled();
  });

  it('reports refresh failures as warnings while preserving the successful save', async () => {
    mocks.refreshPublishedCanonicalResumeAsset.mockRejectedValueOnce(
      new Error('renderer unavailable'),
    );

    await expect(
      withPublishedCanonicalRefresh({ ok: true }),
    ).resolves.toMatchObject({
      message: 'Saved resume data.',
      ok: true,
      warning:
        'Canonical resume PDF refresh failed; the existing published PDF is still live. renderer unavailable',
    });
  });
});

describe('queuePublishedCanonicalRefresh', () => {
  it('debounces queued canonical resume refreshes', async () => {
    vi.useFakeTimers();
    try {
      expect(queuePublishedCanonicalRefresh(100)).toEqual({
        debounceMs: 100,
        queued: true,
      });
      queuePublishedCanonicalRefresh(100);

      await vi.advanceTimersByTimeAsync(99);
      expect(mocks.refreshPublishedCanonicalResumeAsset).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.refreshPublishedCanonicalResumeAsset).toHaveBeenCalledOnce();
    } finally {
      resetPublishedCanonicalRefreshQueueForTests();
      vi.useRealTimers();
    }
  });
});
