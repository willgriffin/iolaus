import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  database: undefined as
    | Awaited<ReturnType<typeof getTestDatabase>>
    | undefined,
}));

// Keep the overlay's production collection path intact while binding it to the
// isolated native SQLite schema produced by SMRT's test database helper.
vi.mock('./smrt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./smrt.js')>();
  return {
    ...actual,
    getCollection: async (
      className: string,
      options: { db?: Awaited<ReturnType<typeof getTestDatabase>> } = {},
    ) => {
      const database = options.db ?? fixture.database;
      if (!database) throw new Error('Native Decision fixture is unavailable.');
      return await ObjectRegistry.getCollection(className, { db: database });
    },
  };
});

import { loadCurrentOpportunityReviewOverlays } from './opportunity-review-overlay.js';

const subject = {
  profileId: 'profile-a',
  tenantId: 'tenant-a',
  userId: 'user-a',
} as const;

async function seedDecision(
  values: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  const database = fixture.database;
  if (!database) throw new Error('Native Decision fixture is unavailable.');
  const decisions = await ObjectRegistry.getCollection('Decision', {
    db: database,
  });
  const decision = await decisions.create(values);
  await database.query('UPDATE decisions SET created_at = ? WHERE id = ?', [
    createdAt,
    decision.id,
  ]);
}

describe('private opportunity review overlays on native SQLite', () => {
  afterEach(async () => {
    await fixture.database?.close?.();
    fixture.database = undefined;
  });

  it('uses native array multi-ordering to select the latest owned review and excludes foreign tuples', async () =>
    await withTenant({ tenantId: subject.tenantId }, async () => {
      fixture.database = await getTestDatabase({
        classes: ['Decision'],
        type: 'sqlite',
      });

      await seedDecision(
        {
          candidateProfileId: subject.profileId,
          decision: 'defer',
          id: '00000000-0000-4000-8000-000000000001',
          opportunityId: 'opp-1',
          ownerUserId: subject.userId,
          reason: 'Older review',
          tenantId: subject.tenantId,
        },
        '2026-10-01T00:00:00.000Z',
      );
      await seedDecision(
        {
          candidateProfileId: subject.profileId,
          decision: 'defer',
          humanRating: 3,
          id: '00000000-0000-4000-8000-00000000000a',
          opportunityId: 'opp-1',
          ownerUserId: subject.userId,
          reason: 'Tie loser',
          tenantId: subject.tenantId,
        },
        '2026-10-02T00:00:00.000Z',
      );
      await seedDecision(
        {
          candidateProfileId: subject.profileId,
          decision: 'reject',
          humanRating: 9,
          id: '00000000-0000-4000-8000-00000000000f',
          opportunityId: 'opp-1',
          ownerUserId: subject.userId,
          reason: 'Tie winner',
          tenantId: subject.tenantId,
        },
        '2026-10-02T00:00:00.000Z',
      );
      await seedDecision(
        {
          candidateProfileId: 'profile-b',
          decision: 'accept_to_apply',
          humanRating: 10,
          id: '00000000-0000-4000-8000-0000000000ff',
          opportunityId: 'opp-1',
          ownerUserId: 'user-b',
          reason: 'Foreign review must never win',
          tenantId: subject.tenantId,
        },
        '2026-10-03T00:00:00.000Z',
      );

      const overlays = await loadCurrentOpportunityReviewOverlays({
        opportunityIds: ['opp-1'],
        subject,
      });

      expect(overlays.get('opp-1')).toMatchObject({
        humanRating: 9,
        humanReviewNotes: 'Tie winner',
        humanReviewStatus: 'reject',
      });
    }));
});
