import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicOpportunity } from '$lib/public-opportunity-contract.js';

const mocks = vi.hoisted(() => ({
  assertOperation: vi.fn(),
  list: vi.fn(),
  runAsOwner: vi.fn(),
  store: vi.fn(),
  subject: vi.fn(),
  batch: vi.fn(),
  single: vi.fn(),
}));
vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  resolveDatabase: vi.fn(),
}));
vi.mock('./db.js', () => ({ getDbConfig: vi.fn() }));
vi.mock('./owner-principal.js', () => ({
  runAsOwner: mocks.runAsOwner,
}));
vi.mock('./shortlist-store.js', () => ({ createShortlistStore: mocks.store }));
vi.mock('./workspace-subject.js', () => ({
  workspaceSubjectFromLocals: mocks.subject,
}));
vi.mock('./public-search/index.js', () => ({
  getPublicOpportunities: mocks.batch,
  getPublicOpportunity: mocks.single,
}));

import {
  importShortlist,
  listShortlist,
  mutateShortlist,
} from './shortlist-service.js';

const opportunity: PublicOpportunity = {
  id: 'opportunity-1',
  title: 'Role',
  normalized_title: 'role',
  company: null,
  location: { text: '', countries: [], remote: true, timezones: [] },
  seniority: 'mid',
  function: 'engineering',
  employment_type: 'full_time',
  work_mode: 'remote',
  skills: { required: [], preferred: [] },
  compensation: null,
  posted_at: null,
  updated_at: '2026-10-08T00:00:00.000Z',
  expires_at: null,
  analysis_version: 'v1',
  source_content_version: 1,
  posting_url: 'https://example.test/1',
  url: 'https://example.test/1',
};
const entry = {
  opportunity,
  decision: 'saved' as const,
  firstSeenAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
  openedAt: null,
  appliedAt: null,
  revision: 2,
};

describe('shortlist account service authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subject.mockReturnValue({ tenantId: 'tenant', userId: 'user' });
    mocks.assertOperation.mockResolvedValue(undefined);
    mocks.store.mockReturnValue({ list: mocks.list, merge: mocks.store });
    mocks.list.mockResolvedValue([]);
    mocks.batch.mockResolvedValue([]);
    mocks.runAsOwner.mockImplementation(
      async (
        _locals: unknown,
        callback: (run: {
          assertOperation: typeof mocks.assertOperation;
        }) => Promise<unknown>,
      ) => callback({ assertOperation: mocks.assertOperation }),
    );
  });
  it('accepts an authenticated workspace subject without a candidate profile and asserts the narrow capability', async () => {
    await expect(listShortlist({})).resolves.toEqual([]);
    expect(mocks.subject).toHaveBeenCalledWith({});
    expect(mocks.assertOperation).toHaveBeenCalledWith(
      'workflow',
      'shortlist.manage',
    );
    expect(mocks.list).toHaveBeenCalledWith({
      tenantId: 'tenant',
      userId: 'user',
    });
  });
  it('does not run storage when the fresh native permission check rejects', async () => {
    mocks.assertOperation.mockRejectedValueOnce(new Error('revoked'));
    await expect(listShortlist({})).rejects.toThrow('revoked');
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('applies the same native fence before POST and import work', async () => {
    mocks.assertOperation.mockRejectedValueOnce(new Error('revoked'));
    await expect(
      mutateShortlist(
        {},
        {
          mutationId: '11111111-1111-4111-8111-111111111111',
          opportunityId: opportunity.id,
          expectedRevision: 0,
          decision: 'saved',
        },
      ),
    ).rejects.toThrow('revoked');
    mocks.assertOperation.mockRejectedValueOnce(new Error('revoked'));
    await expect(importShortlist({}, [entry])).rejects.toThrow('revoked');
    expect(mocks.single).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
  });
  it('imports only one batched current projection and leaves unavailable guest IDs unacknowledged', async () => {
    mocks.batch.mockResolvedValue([opportunity]);
    mocks.store.mockReturnValue({
      list: mocks.list,
      merge: vi.fn().mockResolvedValue({
        entries: [entry],
        acknowledgedIds: [opportunity.id],
      }),
    });
    const missing = {
      ...entry,
      opportunity: { ...opportunity, id: 'missing' },
    };
    const result = await importShortlist({}, [entry, missing]);
    expect(mocks.batch).toHaveBeenCalledWith([opportunity.id, 'missing']);
    expect(result.acknowledgedIds).toEqual([opportunity.id]);
  });
});
