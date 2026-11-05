import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import {
  ensureMatchingProjectionSchema,
  matchingProjectionSchemaReady,
} from './matching-projection-schema.js';

const postgresUrl = process.env.IOLAUS_MATCHING_TEST_DATABASE_URL?.trim();

for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.runIf(dialect === 'sqlite' || postgresUrl)(
    `matching projection revision schema (${dialect})`,
    () => {
      let database: DatabaseInterface;
      let close: (() => Promise<void>) | undefined;
      const job = randomUUID();
      const profile = randomUUID();
      const other = randomUUID();

      beforeAll(async () => {
        const fixture = await createMatchingProjectionFixture(
          dialect,
          postgresUrl,
        );
        database = fixture.database;
        close = fixture.close;
        await database.query(
          "INSERT INTO opportunities (id, source_id, title) VALUES (?, 'board', 'Engineer')",
          [job],
        );
        await database.query(
          "INSERT INTO sources VALUES ('board', TRUE, TRUE)",
        );
        await database.query(
          "INSERT INTO candidate_profiles (id, active, tenant_id, owner_user_id) VALUES (?, TRUE, 'tenant-a', 'owner'), (?, TRUE, 'tenant-b', 'owner')",
          [profile, other],
        );
        await ensureMatchingProjectionSchema(database, dialect);
      });

      afterAll(async () => {
        await close?.();
      });

      async function revision(
        table: string,
        key: string,
        id: string | number,
        db = database,
      ) {
        const result = await db.query(
          `SELECT revision FROM ${table} WHERE ${key} = ?`,
          [id],
        );
        return result.rows.length ? String(result.rows[0].revision) : undefined;
      }
      const sourceRevision = (db = database) =>
        revision('matching_source_versions', 'opportunity_id', job, db);
      const profileRevision = (id: string) =>
        revision('matching_profile_versions', 'profile_id', id);
      const listingRevision = () =>
        revision('matching_source_listing_versions', 'source_id', 'board');
      const vocabularyRevision = () =>
        revision('matching_vocabulary_version', 'id', 1);

      it('backfills each registry and installs the schema idempotently', async () => {
        const revisions = await Promise.all([
          sourceRevision(),
          profileRevision(profile),
          listingRevision(),
        ]);
        expect(revisions.every(Boolean)).toBe(true);
        await ensureMatchingProjectionSchema(database, dialect);
        expect(
          await Promise.all([
            sourceRevision(),
            profileRevision(profile),
            listingRevision(),
          ]),
        ).toEqual(revisions);
      });

      it('adds the screened flag to existing rows and constrains its rank and status', async () => {
        const fixture = await createMatchingProjectionFixture(
          dialect,
          postgresUrl,
        );
        try {
          const legacy = fixture.database;
          await ensureMatchingProjectionSchema(legacy, dialect);
          await legacy.query('DROP INDEX matching_results_current_discovery');
          await legacy.query(
            'ALTER TABLE matching_results DROP COLUMN screened_with_gaps',
          );
          await legacy.query(
            'UPDATE matching_worker_cursor SET schema_revision=2 WHERE id=1',
          );
          await legacy.query(`
            INSERT INTO matching_results
              (profile_id, tenant_id, user_id, opportunity_id, profile_revision,
               source_revision, source_listing_revision, vocabulary_revision,
               policy_version, status, score, reasons_json)
            VALUES ('profile', 'tenant', 'user', 'posting', 1, 1, 1, 1, 'legacy', 'qualified', 70, '[]')
          `);
          expect(await matchingProjectionSchemaReady(legacy, dialect)).toBe(
            false,
          );
          await ensureMatchingProjectionSchema(legacy, dialect);
          expect(await matchingProjectionSchemaReady(legacy, dialect)).toBe(
            true,
          );
          const migrated = await legacy.query(
            'SELECT status, score, screened_with_gaps FROM matching_results',
          );
          expect(migrated.rows[0]).toMatchObject({
            status: 'qualified',
            score: 70,
          });
          expect(Boolean(migrated.rows[0]?.screened_with_gaps)).toBe(false);
          await expect(
            legacy.query('UPDATE matching_results SET screened_with_gaps=TRUE'),
          ).rejects.toThrow();
          await expect(
            legacy.query(
              "UPDATE matching_results SET screened_with_gaps=TRUE, status='insufficient-evidence'",
            ),
          ).rejects.toThrow();
          await legacy.query(
            "UPDATE matching_results SET screened_with_gaps=TRUE, status='insufficient-evidence', score=35",
          );
        } finally {
          await fixture.close();
        }
      });

      it('invalidates raw source edits transactionally and ignores crawl timestamps', async () => {
        const before = await sourceRevision();
        const unrelated = await profileRevision(profile);
        await database.query(
          "UPDATE opportunities SET updated_at = 'now', title = title WHERE id = ?",
          [job],
        );
        expect(await sourceRevision()).toBe(before);
        if (!database.transaction)
          throw new Error('Test requires native transactions.');
        await expect(
          database.transaction(async (tx) => {
            await tx.query(
              "UPDATE opportunities SET description_raw = 'changed' WHERE id = ?",
              [job],
            );
            expect(await sourceRevision(tx)).not.toBe(before);
            throw new Error('injected rollback');
          }),
        ).rejects.toThrow('injected rollback');
        expect(await sourceRevision()).toBe(before);
        await database.query(
          "UPDATE opportunities SET description_raw = 'new requirements' WHERE id = ?",
          [job],
        );
        expect(await sourceRevision()).not.toBe(before);
        expect(await profileRevision(profile)).toBe(unrelated);
      });

      it('updates only the board revision when the board opts out or resumes', async () => {
        const source = await sourceRevision();
        const before = await listingRevision();
        await database.query(
          "UPDATE sources SET public_listing = FALSE WHERE id = 'board'",
        );
        const optedOut = await listingRevision();
        expect(optedOut).not.toBe(before);
        await database.query(
          "UPDATE sources SET public_listing = TRUE WHERE id = 'board'",
        );
        expect(await listingRevision()).not.toBe(optedOut);
        expect(await sourceRevision()).toBe(source);
      });

      it('isolates private evidence and questions across the complete owner tuple', async () => {
        const before = await profileRevision(profile);
        const sibling = await profileRevision(other);
        await database.query(
          "INSERT INTO resume_skills VALUES ('inconsistent', 'tenant-b', 'owner', ?, 'TypeScript')",
          [profile],
        );
        await database.query(
          "INSERT INTO preference_rules (id, tenant_id, owner_user_id, candidate_profile_id, category, active) VALUES ('unrelated', 'tenant-a', 'owner', ?, 'other', TRUE)",
          [profile],
        );
        expect(await profileRevision(profile)).toBe(before);
        await database.query(
          "INSERT INTO resume_skills VALUES ('owned', 'tenant-a', 'owner', ?, 'TypeScript')",
          [profile],
        );
        const evidence = await profileRevision(profile);
        expect(evidence).not.toBe(before);
        await database.query("DELETE FROM resume_skills WHERE id = 'owned'");
        expect(await profileRevision(profile)).not.toBe(evidence);
        await database.query(
          "UPDATE preference_rules SET category = 'screening_questions' WHERE id = 'unrelated'",
        );
        const question = await profileRevision(profile);
        expect(question).not.toBe(evidence);
        await database.query(
          "UPDATE preference_rules SET active = FALSE WHERE id = 'unrelated'",
        );
        expect(await profileRevision(profile)).not.toBe(question);
        expect(await profileRevision(other)).toBe(sibling);
      });

      it('invalidates governed vocabulary edits and active membership transitions', async () => {
        const v = await vocabularyRevision();
        await database.query(
          "INSERT INTO skill_terms (skill_slug, label, status) VALUES ('ts', 'TypeScript', 'proposed')",
        );
        expect(await vocabularyRevision()).toBe(v);
        await database.query(
          "UPDATE skill_terms SET status = 'confirmed' WHERE skill_slug = 'ts'",
        );
        const confirmed = await vocabularyRevision();
        expect(confirmed).not.toBe(v);
        await database.query(
          "UPDATE skill_terms SET occurrence_count = 3 WHERE skill_slug = 'ts'",
        );
        expect(await vocabularyRevision()).toBe(confirmed);
        await database.query(
          "UPDATE skill_terms SET aliases_json = '[\"ts\"]' WHERE skill_slug = 'ts'",
        );
        expect(await vocabularyRevision()).not.toBe(confirmed);
        await database.query(
          "INSERT INTO memberships VALUES ('tenant-a', 'owner', 'active', 'member')",
        );
        const active = await profileRevision(profile);
        const sibling = await profileRevision(other);
        await database.query(
          "UPDATE memberships SET status = 'inactive' WHERE tenant_id = 'tenant-a'",
        );
        expect(await profileRevision(profile)).not.toBe(active);
        expect(await profileRevision(other)).toBe(sibling);
      });

      it('purges derived private data on ownership transfer and never reuses a deleted profile revision', async () => {
        const before = await profileRevision(profile);
        await database.query(
          `INSERT INTO matching_profile_facts
          (profile_id, tenant_id, user_id, profile_revision, vocabulary_revision, policy_version, facts_json, status)
          SELECT profile_id, 'tenant-a', 'owner', revision, 0, 'test', '{}', 'ready'
          FROM matching_profile_versions WHERE profile_id = ?`,
          [profile],
        );
        await database.query(
          `INSERT INTO matching_results
          (profile_id, tenant_id, user_id, opportunity_id, profile_revision, source_revision,
           source_listing_revision, vocabulary_revision, policy_version, status, score, reasons_json)
          SELECT profile_id, 'tenant-a', 'owner', ?, revision, 0, 0, 0, 'test', 'qualified', 1, '[]'
          FROM matching_profile_versions WHERE profile_id = ?`,
          [job, profile],
        );
        await database.query(
          "UPDATE candidate_profiles SET owner_user_id = 'other-owner' WHERE id = ?",
          [profile],
        );
        expect(
          (
            await database.query(
              'SELECT profile_id FROM matching_profile_facts',
            )
          ).rows,
        ).toEqual([]);
        expect(
          (await database.query('SELECT profile_id FROM matching_results'))
            .rows,
        ).toEqual([]);
        expect(await profileRevision(profile)).not.toBe(before);
        const transferred = await profileRevision(profile);
        await database.query('DELETE FROM candidate_profiles WHERE id = ?', [
          profile,
        ]);
        expect(await profileRevision(profile)).toBeUndefined();
        await database.query(
          "INSERT INTO candidate_profiles (id, active, tenant_id, owner_user_id) VALUES (?, TRUE, 'tenant-a', 'other-owner')",
          [profile],
        );
        expect(await profileRevision(profile)).not.toBe(transferred);
      });
      it('repairs a missing trigger and invalidates results that may have missed a raw edit', async () => {
        const trigger = 'matching_touch_opportunities_update';
        const before = await vocabularyRevision();
        const source = await sourceRevision();
        expect(await matchingProjectionSchemaReady(database, dialect)).toBe(
          true,
        );
        await database.query(
          `DROP TRIGGER ${trigger}${dialect === 'postgres' ? ' ON opportunities' : ''}`,
        );
        await database.query(
          "UPDATE opportunities SET title = 'New title' WHERE id = ?",
          [job],
        );
        expect(await sourceRevision()).toBe(source);
        expect(await matchingProjectionSchemaReady(database, dialect)).toBe(
          false,
        );
        await ensureMatchingProjectionSchema(database, dialect);
        expect(await matchingProjectionSchemaReady(database, dialect)).toBe(
          true,
        );
        expect(await vocabularyRevision()).not.toBe(before);
        await database.query(
          "UPDATE opportunities SET title = 'Another title' WHERE id = ?",
          [job],
        );
        expect(await sourceRevision()).not.toBe(source);
      });
    },
  );
}
