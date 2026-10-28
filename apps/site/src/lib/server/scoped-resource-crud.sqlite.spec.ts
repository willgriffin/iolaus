import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Two owners in one hosted tenant against real SQLite persistence. The unit
 * spec mocks the collection; this one proves the owner predicate and the
 * identity guard hold on SMRT's own write path, including the natural-key
 * adoption an explicit `slug` would otherwise trigger.
 */
const fixture = vi.hoisted(() => ({
  database: undefined as
    | Awaited<ReturnType<typeof getTestDatabase>>
    | undefined,
  subject: {
    profileId: 'profile-a',
    tenantId: 'tenant-a',
    userId: 'user-a',
  } as { profileId?: string; tenantId: string; userId: string } | null,
}));

vi.mock('./smrt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./smrt.js')>();
  return {
    ...actual,
    getCollection: async (className: string) => {
      const database = fixture.database;
      if (!database) throw new Error('Native fixture is unavailable.');
      return await ObjectRegistry.getCollection(className, { db: database });
    },
  };
});
vi.mock('./app-config.js', () => ({ isSharedHosted: () => true }));
vi.mock('./workspace-subject.js', () => ({
  getCurrentWorkspaceSubject: () => fixture.subject,
  isCurrentWorkspaceOperator: () => false,
}));
vi.mock('./resume-data.js', () => ({
  invalidatePublishedResumeCache: vi.fn(),
}));
vi.mock('./resume-source-refresh.js', () => ({
  queuePublishedCanonicalRefresh: vi.fn(),
}));

import {
  createScopedRecord,
  deleteScopedRecord,
  getScopedRecord,
  listScopedRecords,
  updateScopedRecord,
} from './scoped-resource-crud.js';

const ownerA = {
  profileId: 'profile-a',
  tenantId: 'tenant-a',
  userId: 'user-a',
};
const ownerB = {
  profileId: 'profile-b',
  tenantId: 'tenant-a',
  userId: 'user-b',
};

async function rowById(id: string) {
  const result = await fixture.database!.query(
    'SELECT id, slug, owner_user_id, candidate_profile_id, title FROM achievements WHERE id = ?',
    [id],
  );
  return result.rows[0] ?? null;
}

describe('owner-scoped CRUD on native SQLite with two owners in one tenant', () => {
  afterEach(async () => {
    await fixture.database?.close?.();
    fixture.database = undefined;
  });

  it('never lets one owner read, adopt, change or delete the other owner’s rows', async () =>
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      fixture.database = await getTestDatabase({
        classes: ['Achievement'],
        type: 'sqlite',
      });
      // Owner A creates a record through the scoped path.
      fixture.subject = ownerA;
      const mine = await createScopedRecord('Achievement', {
        title: 'Shipped the thing',
      });
      expect(mine).toMatchObject({
        candidateProfileId: 'profile-a',
        ownerUserId: 'user-a',
        tenantId: 'tenant-a',
      });
      const mineId = String(mine.id);
      const mineSlug = String((await rowById(mineId))?.slug ?? '');
      expect(mineSlug).not.toBe('');

      // Owner B, same tenant.
      fixture.subject = ownerB;
      expect((await listScopedRecords('Achievement')).items).toEqual([]);
      expect(await getScopedRecord('Achievement', mineId)).toBeNull();
      await expect(
        updateScopedRecord('Achievement', mineId, { title: 'Taken over' }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        deleteScopedRecord('Achievement', mineId),
      ).rejects.toMatchObject({ status: 404 });
      // The natural-key adoption vector: an explicit slug equal to A's row.
      await expect(
        createScopedRecord('Achievement', {
          slug: mineSlug,
          title: 'Adopted',
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        createScopedRecord('Achievement', { id: mineId, title: 'Adopted' }),
      ).rejects.toMatchObject({ status: 400 });
      // B's own create with the same human title gets its own row.
      const theirs = await createScopedRecord('Achievement', {
        title: 'Shipped the thing',
      });
      expect(theirs.id).not.toBe(mineId);
      expect(theirs).toMatchObject({
        candidateProfileId: 'profile-b',
        ownerUserId: 'user-b',
      });
      // A forged tuple is refused outright.
      await expect(
        createScopedRecord('Achievement', {
          ownerUserId: 'user-a',
          title: 'Forged',
        }),
      ).rejects.toMatchObject({ status: 403 });

      // A's row is untouched and still only A's.
      expect(await rowById(mineId)).toMatchObject({
        candidate_profile_id: 'profile-a',
        owner_user_id: 'user-a',
        title: 'Shipped the thing',
      });
      fixture.subject = ownerA;
      const listed = await listScopedRecords('Achievement');
      expect(listed.items.map((item) => item.id)).toEqual([mineId]);
      expect(listed.total).toBe(1);
      await deleteScopedRecord('Achievement', mineId);
      expect(await rowById(mineId)).toBeNull();
      expect(await rowById(String(theirs.id))).toMatchObject({
        owner_user_id: 'user-b',
      });
    }));
});
