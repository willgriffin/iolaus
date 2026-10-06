import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPrivateDecision,
  createPrivateDecisionTag,
  listPrivateDecisionTags,
  loadCurrentOpportunityReviewOverlays,
  recordPrivateOpportunityReview,
} from './opportunity-review-overlay.js';

const mocks = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  records: new Map<string, Record<string, unknown>>(),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async () => ({
    create: async (payload: Record<string, unknown>) => {
      const record = { id: `created-${mocks.created.length + 1}`, ...payload };
      mocks.created.push(record);
      return record;
    },
    get: async (id: string) => mocks.records.get(id) ?? null,
    list: async () => [...mocks.records.values()],
  })),
}));

const subject = {
  profileId: 'profile-a',
  tenantId: 'tenant-a',
  userId: 'user-a',
};
const other = {
  profileId: 'profile-b',
  tenantId: 'tenant-a',
  userId: 'user-b',
};
const owned = (value: Record<string, unknown>) => ({
  candidateProfileId: subject.profileId,
  ownerUserId: subject.userId,
  tenantId: subject.tenantId,
  ...value,
});

describe('private opportunity review overlays', () => {
  beforeEach(() => {
    mocks.created.length = 0;
    mocks.records.clear();
  });

  it('projects only the current owned decision for each requested opportunity', async () => {
    mocks.records.set(
      'older',
      owned({
        createdAt: '2026-09-01T00:00:00.000Z',
        decision: 'defer',
        id: 'older',
        opportunityId: 'opp-a',
        reason: 'Later',
      }),
    );
    mocks.records.set(
      'newer',
      owned({
        createdAt: '2026-09-02T00:00:00.000Z',
        decision: 'reject',
        humanRating: 3,
        id: 'newer',
        opportunityId: 'opp-a',
        reason: 'No relocation',
      }),
    );
    mocks.records.set('foreign', {
      ...owned({
        id: 'foreign',
        opportunityId: 'opp-b',
        decision: 'accept_to_apply',
      }),
      candidateProfileId: other.profileId,
      ownerUserId: other.userId,
    });

    const overlays = await loadCurrentOpportunityReviewOverlays({
      opportunityIds: ['opp-a', 'opp-b'],
      subject,
    });

    expect(overlays.get('opp-a')).toMatchObject({
      humanRating: 3,
      humanReviewNotes: 'No relocation',
      humanReviewStatus: 'reject',
      reviewedByProfileId: '',
      reviewedByUserId: '',
    });
    expect(overlays.has('opp-b')).toBe(false);
  });

  it('derives decision ownership and actor attribution from the subject', async () => {
    await createPrivateDecision({
      decision: 'defer',
      humanRating: 7,
      opportunityId: 'opp-a',
      subject,
    });

    expect(mocks.created[0]).toMatchObject({
      candidateProfileId: 'profile-a',
      deciderProfileId: 'profile-a',
      deciderUserId: 'user-a',
      ownerUserId: 'user-a',
      tenantId: 'tenant-a',
    });
  });

  it('records a review revision instead of mutating the shared opportunity', async () => {
    await recordPrivateOpportunityReview({
      humanRating: 8,
      humanReviewNotes: 'Strong role fit',
      humanReviewStatus: 'maybe',
      opportunityId: 'opp-a',
      subject,
    });

    expect(mocks.created[0]).toMatchObject({
      decision: 'defer',
      humanRating: 8,
      opportunityId: 'opp-a',
      reason: 'Strong role fit',
      ...owned({}),
    });
  });

  it('rejects a tag whose parent Decision belongs to another workspace', async () => {
    mocks.records.set('foreign-decision', {
      candidateProfileId: other.profileId,
      id: 'foreign-decision',
      ownerUserId: other.userId,
      tenantId: other.tenantId,
    });

    await expect(
      createPrivateDecisionTag({
        decisionId: 'foreign-decision',
        subject,
        tagId: 'tag-a',
        tagRole: 'reason',
      }),
    ).rejects.toThrow('outside the current workspace');
    await expect(
      listPrivateDecisionTags({ decisionId: 'foreign-decision', subject }),
    ).rejects.toThrow('outside the current workspace');
  });
});
