import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.SOURCE_PROVENANCE_TEST_DATABASE_URL?.trim();
const enabled = Boolean(databaseUrl);

describe.runIf(enabled)('source provenance database guards', () => {
  let db: Awaited<ReturnType<typeof resolveDatabase>>;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('SOURCE_PROVENANCE_TEST_DATABASE_URL is required.');
    }
    const parsed = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      throw new Error('Source provenance integration tests require localhost.');
    }
    db = await resolveDatabase(
      { type: 'postgres', url: databaseUrl },
      { dbid: `source-provenance-test-${randomUUID()}` },
    );
    if (!db.transaction) {
      throw new Error(
        'Source provenance integration tests require transactions.',
      );
    }
  });

  async function insertLineage(
    transaction: Awaited<ReturnType<typeof resolveDatabase>>,
    rootId: string,
    childId: string,
  ) {
    await transaction.query(
      `INSERT INTO sources (id, slug, context, source_role, parent_source_id, is_active)
       VALUES (?, ?, 'source-provenance-test', 'root', NULL, FALSE)`,
      [rootId, `root-${rootId}`],
    );
    await transaction.query(
      `INSERT INTO sources (id, slug, context, source_role, parent_source_id, is_active)
       VALUES (?, ?, 'source-provenance-test', 'posting_derived', ?, FALSE)`,
      [childId, `child-${childId}`, rootId],
    );
  }

  it('rejects a posting-derived source whose parent does not exist', async () => {
    const childId = randomUUID();
    const missingParentId = randomUUID();
    await expect(
      db.transaction?.(async (transaction) => {
        await transaction.query(
          `INSERT INTO sources (id, slug, context, source_role, parent_source_id, is_active)
           VALUES (?, ?, 'source-provenance-test', 'posting_derived', ?, FALSE)`,
          [childId, `child-${childId}`, missingParentId],
        );
      }),
    ).rejects.toThrow();
  });

  it.each([
    true,
    null,
  ])('rejects posting-derived activation state %s', async (isActive) => {
    const rootId = randomUUID();
    const childId = randomUUID();
    await expect(
      db.transaction?.(async (transaction) => {
        await transaction.query(
          `INSERT INTO sources (id, slug, context, source_role, parent_source_id, is_active)
             VALUES (?, ?, 'source-provenance-test', 'root', NULL, FALSE)`,
          [rootId, `root-${rootId}`],
        );
        await transaction.query(
          `INSERT INTO sources (id, slug, context, source_role, parent_source_id, is_active)
             VALUES (?, ?, 'source-provenance-test', 'posting_derived', ?, ?)`,
          [childId, `child-${childId}`, rootId, isActive],
        );
      }),
    ).rejects.toThrow();
    const residue = await db.query(
      'SELECT id FROM sources WHERE id IN (?, ?)',
      [rootId, childId],
    );
    expect(residue.rows).toHaveLength(0);
  });

  it('rejects deleting or demoting a root that still owns children', async () => {
    const deleteRootId = randomUUID();
    const deleteChildId = randomUUID();
    await expect(
      db.transaction?.(async (transaction) => {
        await insertLineage(transaction, deleteRootId, deleteChildId);
        await transaction.query('DELETE FROM sources WHERE id = ?', [
          deleteRootId,
        ]);
      }),
    ).rejects.toThrow();

    const demoteRootId = randomUUID();
    const demoteChildId = randomUUID();
    await expect(
      db.transaction?.(async (transaction) => {
        await insertLineage(transaction, demoteRootId, demoteChildId);
        await transaction.query(
          "UPDATE sources SET source_role = 'unknown' WHERE id = ?",
          [demoteRootId],
        );
      }),
    ).rejects.toThrow();

    const nullRootId = randomUUID();
    const nullChildId = randomUUID();
    await expect(
      db.transaction?.(async (transaction) => {
        await insertLineage(transaction, nullRootId, nullChildId);
        await transaction.query(
          'UPDATE sources SET source_role = NULL WHERE id = ?',
          [nullRootId],
        );
      }),
    ).rejects.toThrow();

    const nullInsertId = randomUUID();
    await expect(
      db.transaction?.(async (transaction) => {
        await transaction.query(
          `INSERT INTO sources (id, slug, context, source_role, parent_source_id, is_active)
           VALUES (?, ?, 'source-provenance-test', NULL, NULL, FALSE)`,
          [nullInsertId, `null-${nullInsertId}`],
        );
      }),
    ).rejects.toThrow();

    const residue = await db.query(
      `SELECT id FROM sources
       WHERE id IN (?, ?, ?, ?, ?, ?, ?)`,
      [
        deleteRootId,
        deleteChildId,
        demoteRootId,
        demoteChildId,
        nullRootId,
        nullChildId,
        nullInsertId,
      ],
    );
    expect(residue.rows).toHaveLength(0);
  });

  it('serializes child creation against concurrent parent demotion', async () => {
    const rootId = randomUUID();
    const childId = randomUUID();
    await db.query(
      `INSERT INTO sources (id, slug, context, source_role, parent_source_id, is_active)
       VALUES (?, ?, 'source-provenance-test', 'root', NULL, FALSE)`,
      [rootId, `root-${rootId}`],
    );

    let signalChildInserted: (() => void) | undefined;
    let releaseChildTransaction: (() => void) | undefined;
    const childInserted = new Promise<void>((resolve) => {
      signalChildInserted = resolve;
    });
    const childMayCommit = new Promise<void>((resolve) => {
      releaseChildTransaction = resolve;
    });

    try {
      const childWork = db.transaction?.(async (transaction) => {
        await transaction.query(
          `INSERT INTO sources (id, slug, context, source_role, parent_source_id, is_active)
           VALUES (?, ?, 'source-provenance-test', 'posting_derived', ?, FALSE)`,
          [childId, `child-${childId}`, rootId],
        );
        signalChildInserted?.();
        await childMayCommit;
      });
      await childInserted;

      let demotionSettled = false;
      const demotionOutcome = db
        .transaction?.(async (transaction) => {
          await transaction.query(
            "UPDATE sources SET source_role = 'unknown' WHERE id = ?",
            [rootId],
          );
        })
        .then(
          () => ({ error: null, ok: true }),
          (error: unknown) => ({ error, ok: false }),
        )
        .finally(() => {
          demotionSettled = true;
        });

      await delay(50);
      expect(demotionSettled).toBe(false);
      releaseChildTransaction?.();
      await childWork;

      const outcome = await demotionOutcome;
      expect(outcome?.ok).toBe(false);
      expect(outcome?.error).toBeInstanceOf(Error);

      const rows = await db.query(
        `SELECT id, source_role AS "sourceRole", parent_source_id AS "parentSourceId"
         FROM sources WHERE id IN (?, ?) ORDER BY id`,
        [rootId, childId],
      );
      expect(rows.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: rootId, sourceRole: 'root' }),
          expect.objectContaining({
            id: childId,
            parentSourceId: rootId,
            sourceRole: 'posting_derived',
          }),
        ]),
      );
    } finally {
      releaseChildTransaction?.();
      await db.query('DELETE FROM sources WHERE id = ?', [childId]);
      await db.query('DELETE FROM sources WHERE id = ?', [rootId]);
    }
  });
});
